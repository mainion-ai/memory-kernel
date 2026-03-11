/**
 * Append-only NDJSON event log.
 * Source of truth for "what happened." Views are derived from this.
 */

import fs from 'fs';
import path from 'path';
import { validateEvent, generateEventId, isMutationAction } from './schema.js';
import { normalizeTimestamp } from './format.js';
import { writeFileAtomic } from './store.js';
import type { CompactResult, EventAction, MemoryEvent } from './types.js';

/**
 * Append an event to the log. Returns the event with generated ID.
 */
export function appendEvent(
  memoryDir: string,
  action: EventAction,
  opts: {
    agent_id: string;
    session_id: string;
    atom_refs?: string[];
    touched_paths?: string[];
    evidence?: string[];
    meta?: Record<string, unknown>;
    // V2 fields
    schema_version?: 2;
    atom_snapshot?: string;
    atom_snapshot_hash?: string;
  },
): MemoryEvent {
  const event: MemoryEvent = {
    event_id: generateEventId(),
    timestamp: normalizeTimestamp(),
    agent_id: opts.agent_id,
    session_id: opts.session_id,
    action,
    atom_refs: opts.atom_refs,
    touched_paths: opts.touched_paths,
    evidence: opts.evidence,
    meta: opts.meta,
    schema_version: opts.schema_version,
    atom_snapshot: opts.atom_snapshot,
    atom_snapshot_hash: opts.atom_snapshot_hash,
  };

  // Validate before writing
  const result = validateEvent(event);
  if (!result.success) {
    throw new Error(`Invalid event: ${JSON.stringify(result.error.issues)}`);
  }

  // Append to NDJSON (with fsync for durability)
  const logPath = path.join(memoryDir, 'events.ndjson');
  const line = JSON.stringify(event) + '\n';
  const fd = fs.openSync(logPath, 'a');
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  return event;
}

/**
 * Read all events from the log.
 */
export function readEvents(memoryDir: string): MemoryEvent[] {
  const logPath = path.join(memoryDir, 'events.ndjson');
  if (!fs.existsSync(logPath)) return [];

  const content = fs.readFileSync(logPath, 'utf-8').trim();
  if (!content) return [];

  return content.split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line) as MemoryEvent];
    } catch {
      return []; // Skip corrupted lines
    }
  });
}

/**
 * Read events filtered by action type.
 */
export function readEventsByAction(
  memoryDir: string,
  action: EventAction,
): MemoryEvent[] {
  return readEvents(memoryDir).filter((e) => e.action === action);
}

/**
 * Read events related to specific atom IDs.
 */
export function readEventsForAtoms(
  memoryDir: string,
  atomIds: string[],
): MemoryEvent[] {
  const idSet = new Set(atomIds);
  return readEvents(memoryDir).filter(
    (e) => e.atom_refs?.some((ref) => idSet.has(ref)),
  );
}

/**
 * Compact the event log by keeping only the latest mutation event per atom
 * and all non-mutation events. Creates a timestamped backup before writing.
 *
 * This reduces log size for large stores where many atoms have been updated
 * multiple times. The compacted log is still sufficient for replay — only
 * intermediate snapshots are discarded.
 *
 * Concurrency note: a best-effort re-read after backup captures events
 * appended between the initial read and the backup copy. A small window
 * remains between the re-read and writeFileAtomic where concurrent appends
 * may be lost. For full safety, run compactLog when no other writers are
 * active (e.g., during maintenance windows).
 */
export function compactLog(memoryDir: string): CompactResult {
  const logPath = path.join(memoryDir, 'events.ndjson');
  const events = readEvents(memoryDir);
  const eventsBefore = events.length;

  if (eventsBefore === 0) {
    return { events_before: 0, events_after: 0, removed: 0, backup_path: '' };
  }

  // For each atom, keep only the LATEST mutation event.
  // Non-mutation events (reflect_completed, session_started, etc.) are always kept.
  // atom_imported events are kept when they are the latest for that atom.
  const latestMutationByAtom = new Map<string, number>(); // atom_id → event index

  for (let i = 0; i < events.length; i++) {
    const evt = events[i];
    if (!isMutationAction(evt.action)) continue;
    if (!evt.atom_refs) continue;
    for (const ref of evt.atom_refs) {
      latestMutationByAtom.set(ref, i);
    }
  }

  // Build the set of event indices to keep
  const keepIndices = new Set<number>();
  for (let i = 0; i < events.length; i++) {
    const evt = events[i];
    if (!isMutationAction(evt.action)) {
      // Non-mutation: always keep
      keepIndices.add(i);
    } else if (evt.atom_refs) {
      // Mutation: keep only if this is the latest mutation for ANY of its atom refs
      for (const ref of evt.atom_refs) {
        if (latestMutationByAtom.get(ref) === i) {
          keepIndices.add(i);
          break;
        }
      }
    } else {
      // Mutation with no atom_refs: keep (shouldn't happen, but safe)
      keepIndices.add(i);
    }
  }

  const compacted = events.filter((_, i) => keepIndices.has(i));
  const eventsAfter = compacted.length;
  const removed = eventsBefore - eventsAfter;

  if (removed === 0) {
    return { events_before: eventsBefore, events_after: eventsAfter, removed: 0, backup_path: '' };
  }

  // Create timestamped backup
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = logPath + `.bak.${timestamp}`;
  if (fs.existsSync(logPath)) {
    fs.copyFileSync(logPath, backupPath);
  }

  // Re-read to capture any events appended concurrently since the initial read
  const latestEvents = readEvents(memoryDir);
  const originalIds = new Set(events.map((e) => e.event_id));
  const newEvents = latestEvents.filter((e) => !originalIds.has(e.event_id));
  const finalCompacted = [...compacted, ...newEvents];

  // Write compacted log
  const ndjson = finalCompacted.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileAtomic(logPath, ndjson);

  return { events_before: eventsBefore, events_after: finalCompacted.length, removed: eventsBefore - finalCompacted.length, backup_path: backupPath };
}

/**
 * Count events in the log.
 * Matches readEvents() semantics: skips blank lines AND unparseable JSON lines.
 * This ensures countEvents() === readEvents().length for any log state.
 */
export function countEvents(memoryDir: string): number {
  const logPath = path.join(memoryDir, 'events.ndjson');
  if (!fs.existsSync(logPath)) return 0;

  const content = fs.readFileSync(logPath, 'utf-8').trim();
  if (!content) return 0;

  let count = 0;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      JSON.parse(line);
      count++;
    } catch {
      // Skip malformed lines — same as readEvents()
    }
  }
  return count;
}
