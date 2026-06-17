/**
 * Multi-agent event-log union merge.
 *
 * Pattern B (PRD §11.7): event-log union + deterministic replay.
 * - Deduplicates events by event_id
 * - Sorts merged log by timestamp (stable, event_id tiebreaker)
 * - Replays to derive canonical atom state (last-writer-wins by timestamp)
 * - Surfaces conflict atoms for atoms concurrently modified by both agents
 */

import fs from 'fs';
import path from 'path';
import { appendEvent, readEvents } from './event-log.js';
import { replay } from './replay.js';
import { writeFileAtomic, writeAtom, atomFilePath, assertWithinDir, writeView } from './store.js';
import { serializeAtom, normalizeTimestamp } from './format.js';
import { generateAtomId, isMutationAction, DEFAULT_TTLS } from './schema.js';
import { reindex, indexExists } from './index-db.js';
import type { Atom, MemoryEvent, MergeResult } from './types.js';

export interface MergeOptions {
  localDir: string;
  remoteDir: string;
  agent_id: string;
  session_id: string;
  dryRun?: boolean;
}

export type { MergeResult } from './types.js';

/**
 * Merge a remote agent's event log into the local memory directory.
 *
 * Algorithm:
 * 1. Dedup events by event_id (local wins on collision — same event)
 * 2. Sort merged log by (timestamp ASC, event_id ASC)
 * 3. Replay merged events → canonical atom map + views
 * 4. Write atoms and views to disk
 * 5. Create conflict atoms for atoms modified by both agents independently
 * 6. Reindex SQLite if present
 * 7. Emit merge_completed event
 */
export function mergeEventLogs(opts: MergeOptions): MergeResult {
  const { localDir, remoteDir, agent_id, session_id } = opts;

  // Guard: must be different directories
  if (path.resolve(localDir) === path.resolve(remoteDir)) {
    throw new Error('localDir and remoteDir must be different directories');
  }

  // Guard: remote must exist and have an event log
  const remoteEventsPath = path.join(remoteDir, 'events.ndjson');
  if (!fs.existsSync(remoteDir) || !fs.existsSync(remoteEventsPath)) {
    return { events_imported: 0, events_skipped: 0, conflicts_created: 0, atoms_updated: 0, backup_path: '' };
  }

  // Read both event logs
  const localEvents = readEvents(localDir);
  const remoteEvents = readEvents(remoteDir);
  const localEventIdSet = new Set(localEvents.map((e) => e.event_id));

  // Partition remote events
  const remoteOnlyEvents = remoteEvents.filter((e) => !localEventIdSet.has(e.event_id));
  const events_skipped = remoteEvents.length - remoteOnlyEvents.length;

  if (remoteOnlyEvents.length === 0) {
    return { events_imported: 0, events_skipped, conflicts_created: 0, atoms_updated: 0, backup_path: '' };
  }

  // Dry run: return preview counts without writing
  if (opts.dryRun) {
    return {
      events_imported: remoteOnlyEvents.length,
      events_skipped,
      conflicts_created: 0,
      atoms_updated: 0,
      backup_path: '',
    };
  }

  // Detect concurrent-update atoms BEFORE writing anything
  // localOnly = local mutation events NOT present in remote log
  const remoteEventIdSet = new Set(remoteEvents.map((e) => e.event_id));
  const localOnlyMutations = localEvents.filter(
    (e) => isMutationAction(e.action) && !remoteEventIdSet.has(e.event_id),
  );

  const atomsInRemoteOnly = collectAtomIds(remoteOnlyEvents.filter((e) => isMutationAction(e.action)));
  const atomsInLocalOnly = collectAtomIds(localOnlyMutations);

  // Intersection = atoms modified independently by both agents
  const concurrentAtoms = [...atomsInRemoteOnly].filter((id) => atomsInLocalOnly.has(id));

  // Backup local events.ndjson
  const logPath = path.join(localDir, 'events.ndjson');
  let backup_path = '';
  if (fs.existsSync(logPath)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    backup_path = `${logPath}.bak.${ts}`;
    fs.copyFileSync(logPath, backup_path);
  }

  // Merge + sort events
  const mergedEvents = [...localEvents, ...remoteOnlyEvents];
  mergedEvents.sort((a, b) => {
    const tCmp = a.timestamp.localeCompare(b.timestamp);
    return tCmp !== 0 ? tCmp : a.event_id.localeCompare(b.event_id);
  });
  const ndjson = mergedEvents.map((e) => JSON.stringify(e)).join('\n') + '\n';
  // Owner-only (#138/#389): mirror appendEvent's 0o600 — a bare writeFileAtomic
  // lands at the umask default (0o644), exposing SECRET-derived event content.
  writeFileAtomic(logPath, ndjson, 0o600);

  // Replay merged events → canonical atom state
  const evidenceDir = path.join(localDir, 'EVIDENCE');
  const replayResult = replay(mergedEvents, { evidenceDir });

  // Write atoms from replay
  let atoms_updated = 0;
  for (const [id, atom] of replayResult.atoms) {
    const fp = atomFilePath(localDir, id, atom.frontmatter.type);
    assertWithinDir(localDir, fp);
    writeAtom(atom, fp);
    atom.filePath = fp;
    atoms_updated++;
  }

  // Write views from replay
  const VIEW_FILES: Record<string, string> = {
    index: 'INDEX.md',
    decisions: 'DECISIONS.md',
    constraints: 'CONSTRAINTS.md',
    open_questions: 'OPEN_QUESTIONS.md',
    handoff: 'HANDOFF.md',
  };
  for (const [key, filename] of Object.entries(VIEW_FILES)) {
    const content = replayResult.views[key as keyof typeof replayResult.views];
    writeView(localDir, filename, content);
  }

  // Create conflict atoms for concurrent updates
  let conflicts_created = 0;

  // Build set of existing conflict bodies (from replay result) to avoid duplicates
  const existingConflictBodies = new Set<string>();
  for (const atom of replayResult.atoms.values()) {
    if (atom.frontmatter.type === 'conflict' && atom.frontmatter.status === 'active') {
      existingConflictBodies.add(atom.body);
    }
  }

  for (const atomId of concurrentAtoms) {
    // Skip if a conflict atom already references this atomId
    const isDuplicate = [...existingConflictBodies].some((body) => body.includes(atomId));
    if (isDuplicate) continue;

    const latestLocalEvent = findLatestMutationFor(localOnlyMutations, atomId);
    const latestRemoteEvent = findLatestMutationFor(remoteOnlyEvents.filter((e) => isMutationAction(e.action)), atomId);

    const conflictBody = buildMergeConflictBody(atomId, latestLocalEvent, latestRemoteEvent);
    const conflictId = generateAtomId('conflict', `merge-${atomId}`);
    const now = normalizeTimestamp();

    const conflictAtom: Atom = {
      frontmatter: {
        id: conflictId,
        type: 'conflict',
        status: 'active',
        confidence: 1.0,
        created_at: now,
        updated_at: now,
        ttl_days: DEFAULT_TTLS.conflict,
        classification: 'TEAM',
        links: { related: [atomId] },
      },
      body: conflictBody,
    };

    const conflictPath = atomFilePath(localDir, conflictId, 'conflict');
    assertWithinDir(localDir, conflictPath);
    writeAtom(conflictAtom, conflictPath);
    conflictAtom.filePath = conflictPath;

    appendEvent(localDir, 'conflict_detected', {
      agent_id,
      session_id,
      atom_refs: [conflictId, atomId],
      schema_version: 2,
      atom_snapshot: serializeAtom(conflictAtom),
      meta: { reason: 'concurrent-merge', atom_id: atomId, remote_dir: remoteDir },
    });

    existingConflictBodies.add(conflictBody);
    conflicts_created++;
  }

  // Reindex SQLite if index exists
  if (indexExists(localDir)) {
    reindex(localDir);
  }

  // Emit merge_completed event
  appendEvent(localDir, 'merge_completed', {
    agent_id,
    session_id,
    meta: {
      remote_dir: remoteDir,
      events_imported: remoteOnlyEvents.length,
      events_skipped,
      conflicts_created,
      atoms_updated,
    },
  });

  return {
    events_imported: remoteOnlyEvents.length,
    events_skipped,
    conflicts_created,
    atoms_updated,
    backup_path,
  };
}

// --- Helpers ---

/** Collect all atom IDs referenced by mutation events. */
function collectAtomIds(events: MemoryEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const e of events) {
    if (e.atom_refs) {
      for (const id of e.atom_refs) ids.add(id);
    }
  }
  return ids;
}

/** Find the most recent mutation event referencing a given atom ID. */
function findLatestMutationFor(events: MemoryEvent[], atomId: string): MemoryEvent | undefined {
  let latest: MemoryEvent | undefined;
  for (const e of events) {
    if (e.atom_refs?.includes(atomId)) latest = e;
  }
  return latest;
}

/** Build the Markdown body for a merge conflict atom. */
function buildMergeConflictBody(
  atomId: string,
  localEvent: MemoryEvent | undefined,
  remoteEvent: MemoryEvent | undefined,
): string {
  return [
    `## Merge Conflict`,
    ``,
    `Atom \`${atomId}\` was independently modified by two agents before merging.`,
    ``,
    `### Local Agent Update`,
    `- Agent: ${localEvent?.agent_id ?? '(unknown)'}`,
    `- Session: ${localEvent?.session_id ?? '(unknown)'}`,
    `- Action: ${localEvent?.action ?? '(unknown)'}`,
    `- Timestamp: ${localEvent?.timestamp ?? '(unknown)'}`,
    `- Event: ${localEvent?.event_id ?? '(unknown)'}`,
    ``,
    `### Remote Agent Update`,
    `- Agent: ${remoteEvent?.agent_id ?? '(unknown)'}`,
    `- Session: ${remoteEvent?.session_id ?? '(unknown)'}`,
    `- Action: ${remoteEvent?.action ?? '(unknown)'}`,
    `- Timestamp: ${remoteEvent?.timestamp ?? '(unknown)'}`,
    `- Event: ${remoteEvent?.event_id ?? '(unknown)'}`,
    ``,
    `### Resolution`,
    `Review both agents' changes. The merged replay applied last-writer-wins by`,
    `timestamp. If this result is incorrect, manually update atom \`${atomId}\``,
    `and archive this conflict atom.`,
  ].join('\n');
}
