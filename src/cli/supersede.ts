import fs from 'fs';
import type { Command } from 'commander';
import { resolveDir } from './resolve-dir.js';
import {
  readAtom,
  writeAtom,
  indexExists,
  snapshotAtom,
} from '../index.js';
import { indexAtom } from '../index-db.js';
import { assertWithinDir } from '../store.js';
import { appendEvent } from '../event-log.js';
import { normalizeTimestamp } from '../format.js';
import type { Relation } from '../types.js';
import { exitWithError } from './cli-util.js';
import { findAtomFile } from './atom-lookup.js';

export interface SupersedeOptions {
  memoryDir: string;
  oldAtomId: string;
  newAtomId: string;
  agent_id?: string;
  session_id?: string;
  dryRun?: boolean;
}

export interface SupersedeResult {
  old_atom_id: string;
  new_atom_id: string;
  changed: boolean;
  old_status_changed: boolean;
  relation_added: boolean;
  reason?: string;
}

/**
 * Idempotent both halves: each is checked independently, so re-running after a
 * partial-state crash (old marked superseded but new missing the relation, or
 * vice versa) repairs whichever half is missing without duplicating the other.
 */
export function supersedeAtoms(opts: SupersedeOptions): SupersedeResult {
  const { memoryDir, oldAtomId, newAtomId } = opts;
  const agentId = opts.agent_id ?? 'cli';
  const sessionId = opts.session_id ?? 'mk-supersede';

  if (oldAtomId === newAtomId) {
    throw new Error('Cannot supersede an atom with itself.');
  }

  const oldFile = findAtomFile(memoryDir, oldAtomId);
  if (!oldFile) {
    throw new Error(`Old atom not found: ${oldAtomId}`);
  }
  const newFile = findAtomFile(memoryDir, newAtomId);
  if (!newFile) {
    throw new Error(`New atom not found: ${newAtomId}`);
  }

  // Path-traversal guard: file paths come from the index/scan but are keyed
  // off user-supplied atom IDs, so defense-in-depth is required before I/O.
  assertWithinDir(memoryDir, oldFile);
  assertWithinDir(memoryDir, newFile);

  const oldAtom = readAtom(oldFile);
  const newAtom = readAtom(newFile);

  const oldNeedsStatus = oldAtom.frontmatter.status !== 'superseded';

  const existingRelations: Relation[] = newAtom.frontmatter.relations ?? [];
  const newNeedsRelation = !existingRelations.some(
    (r) => r.target === oldAtomId && r.type === 'supersedes',
  );

  if (!oldNeedsStatus && !newNeedsRelation) {
    return {
      old_atom_id: oldAtomId,
      new_atom_id: newAtomId,
      changed: false,
      old_status_changed: false,
      relation_added: false,
      reason: 'Already superseded and relation already present.',
    };
  }

  if (opts.dryRun) {
    return {
      old_atom_id: oldAtomId,
      new_atom_id: newAtomId,
      changed: oldNeedsStatus || newNeedsRelation,
      old_status_changed: oldNeedsStatus,
      relation_added: newNeedsRelation,
      reason: 'dry-run',
    };
  }

  const now = normalizeTimestamp();

  if (oldNeedsStatus) {
    oldAtom.frontmatter.status = 'superseded';
    oldAtom.frontmatter.updated_at = now;
    writeAtom(oldAtom, oldFile);
  }

  if (newNeedsRelation) {
    newAtom.frontmatter.relations = [
      ...existingRelations,
      { target: oldAtomId, type: 'supersedes' },
    ];
    newAtom.frontmatter.updated_at = now;
    writeAtom(newAtom, newFile);
  }

  if (indexExists(memoryDir)) {
    if (oldNeedsStatus) {
      oldAtom.filePath = oldFile;
      indexAtom(memoryDir, oldAtom);
    }
    if (newNeedsRelation) {
      newAtom.filePath = newFile;
      indexAtom(memoryDir, newAtom);
    }
  }

  // Emit V2 mutation events with atom_snapshot so compactLog can preserve
  // the post-supersede atom state (see CODING_INSTRUCTIONS.md §Log compaction invariant).
  // Order matches retain.ts: writeAtom → appendEvent. A crash between the two
  // leaves disk ahead of the log; replay would then reconstruct the pre-supersede
  // snapshot until the next supersede run repairs the half via idempotency.
  if (oldNeedsStatus) {
    appendEvent(memoryDir, 'atom_updated', {
      agent_id: agentId,
      session_id: sessionId,
      atom_refs: [oldAtomId],
      touched_paths: [oldFile],
      evidence: [`Superseded by ${newAtomId}`],
      meta: { operation: 'supersede', role: 'old', new_atom_id: newAtomId },
      schema_version: 2,
      atom_snapshot: snapshotAtom(oldAtom),
    });
  }

  if (newNeedsRelation) {
    appendEvent(memoryDir, 'atom_updated', {
      agent_id: agentId,
      session_id: sessionId,
      atom_refs: [newAtomId],
      touched_paths: [newFile],
      evidence: [`Supersedes ${oldAtomId}`],
      meta: { operation: 'supersede', role: 'new', old_atom_id: oldAtomId },
      schema_version: 2,
      atom_snapshot: snapshotAtom(newAtom),
    });
  }

  return {
    old_atom_id: oldAtomId,
    new_atom_id: newAtomId,
    changed: true,
    old_status_changed: oldNeedsStatus,
    relation_added: newNeedsRelation,
  };
}

// Superseded atoms are excluded from default recall/render — the durable
// invariant callers rely on after invoking this command.
export function registerSupersedeCommand(program: Command): void {
  program
    .command('supersede')
    .description(
      'Mark an atom as superseded by a newer atom.\n' +
      'Sets old atom status to "superseded" and adds a "supersedes" relation on the new atom.',
    )
    .argument('<old-atom-id>', 'The atom being replaced (will be marked superseded)')
    .argument('<new-atom-id>', 'The atom that replaces it (gets the supersedes relation)')
    .option('-d, --dir <dir>', 'Memory directory', './memory')
    .option('--agent-id <id>', 'Agent ID recorded on emitted events', 'cli')
    .option('--session-id <id>', 'Session ID recorded on emitted events', 'mk-supersede')
    .option('--dry-run', 'Preview changes without writing files or emitting events')
    .option('--json', 'Output as JSON')
    .action((
      oldAtomId: string,
      newAtomId: string,
      opts: {
        dir: string;
        agentId: string;
        sessionId: string;
        dryRun?: boolean;
        json?: boolean;
      },
    ) => {
      const memoryDir = resolveDir(opts.dir, program.opts().agent);
      if (!fs.existsSync(memoryDir)) {
        exitWithError(`Memory directory not found: ${memoryDir}`, opts.json);
      }

      let result: SupersedeResult;
      try {
        result = supersedeAtoms({
          memoryDir,
          oldAtomId,
          newAtomId,
          agent_id: opts.agentId,
          session_id: opts.sessionId,
          dryRun: opts.dryRun,
        });
      } catch (err) {
        exitWithError(err instanceof Error ? err.message : String(err), opts.json);
      }

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (!result.changed) {
        console.log(`✓ Already superseded: ${oldAtomId}`);
        return;
      }

      const prefix = opts.dryRun ? '[dry-run] ' : '';
      if (result.old_status_changed) {
        console.log(`✓ ${prefix}${oldAtomId} → superseded`);
      }
      if (result.relation_added) {
        console.log(`✓ ${prefix}${newAtomId} --[supersedes]--> ${oldAtomId}`);
      }
    });
}
