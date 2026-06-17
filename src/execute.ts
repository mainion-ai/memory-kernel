/**
 * Execute operation — stamp an atom's first-confirmed-execution timestamp (#309).
 *
 * Engine-layer logic (#376): the `mk execute` CLI command wraps this, and it is
 * re-exported as public SDK API from the package barrel — neither should reach
 * into `src/cli/`. Mirrors the #359 move of `supersedeAtoms` to `src/supersede.ts`.
 */

import { readAtom, writeAtom, assertWithinDir } from './store.js';
import { indexExists, indexAtom } from './index-db.js';
import { snapshotAtom } from './retain.js';
import { appendEvent } from './event-log.js';
import { normalizeTimestamp } from './format.js';
import { findAtomFile } from './atom-lookup.js';

export interface ExecuteOptions {
  memoryDir: string;
  atomId: string;
  agent_id?: string;
  session_id?: string;
  dryRun?: boolean;
}

export interface ExecuteResult {
  atom_id: string;
  type: string;
  changed: boolean;
  executed_at: string;
  reason?: string;
}

/**
 * Stamp an atom's first-confirmed-execution timestamp (#309). For `procedure`
 * drafts this is the auto-promotion signal (a procedure is only trustworthy
 * once it has actually run — `autoPromote` in reflect.ts promotes executed
 * procedures at confidence ≥ 0.7). Idempotent: re-running preserves the FIRST
 * execution time, since "has it ever run" is the signal we care about.
 */
export function markExecuted(opts: ExecuteOptions): ExecuteResult {
  const { memoryDir, atomId } = opts;
  const agentId = opts.agent_id ?? 'cli';
  const sessionId = opts.session_id ?? 'mk-execute';

  const file = findAtomFile(memoryDir, atomId);
  if (!file) {
    throw new Error(`Atom not found: ${atomId}`);
  }
  // Path-traversal guard: the path is keyed off a user-supplied atom ID.
  assertWithinDir(memoryDir, file);

  const atom = readAtom(file);

  // Idempotent: keep the first execution timestamp.
  if (atom.frontmatter.executed_at) {
    return {
      atom_id: atomId,
      type: atom.frontmatter.type,
      changed: false,
      executed_at: atom.frontmatter.executed_at,
      reason: 'already marked executed',
    };
  }

  const now = normalizeTimestamp();
  if (opts.dryRun) {
    return { atom_id: atomId, type: atom.frontmatter.type, changed: true, executed_at: now, reason: 'dry-run' };
  }

  atom.frontmatter.executed_at = now;
  atom.frontmatter.updated_at = now;
  writeAtom(atom, file);

  appendEvent(memoryDir, 'atom_updated', {
    agent_id: agentId,
    session_id: sessionId,
    atom_refs: [atomId],
    touched_paths: [file],
    evidence: [`Marked executed at ${now}`],
    meta: { operation: 'execute' },
    schema_version: 2,
    atom_snapshot: snapshotAtom(atom),
  });

  if (indexExists(memoryDir)) {
    atom.filePath = file;
    indexAtom(memoryDir, atom);
  }

  return { atom_id: atomId, type: atom.frontmatter.type, changed: true, executed_at: now };
}
