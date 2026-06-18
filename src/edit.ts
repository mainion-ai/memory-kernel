/**
 * Edit operation — the forward path for `human_edit` provenance (#247).
 *
 * `human_edit` has been in EVENT_ACTIONS since v1 but was never emitted: direct
 * filesystem edits (via $EDITOR, the Edit tool, or any non-mk path) bypass the
 * event system entirely, so the strongest correction signal in the store — a
 * human directly validating or correcting an atom — was invisible to the log.
 *
 * `mk edit <id>` closes the forward half: open the atom in $EDITOR, hash the
 * file before/after, and on change emit a provenanced `human_edit` event whose
 * snapshot captures the post-edit state. The backward half (detecting past
 * unprovenanced writes) lives in `src/provenance.ts`.
 *
 * Engine-layer logic (mirrors #376's move of execute to `src/execute.ts`): the
 * CLI command wraps this and it is re-exported from the package barrel — neither
 * should reach into `src/cli/`.
 */

import fs from 'fs';
import { spawnSync } from 'child_process';
import { readAtom, writeAtom, assertWithinDir } from './store.js';
import { indexExists, indexAtom } from './index-db.js';
import { snapshotAtom } from './retain.js';
import { appendEvent } from './event-log.js';
import { normalizeTimestamp } from './format.js';
import { isEncrypted } from './crypto.js';
import { sha256Hex } from './evidence.js';
import { findAtomFile } from './atom-lookup.js';

/**
 * Injectable editor runner. Receives the atom file path and is expected to
 * mutate the file in place. The default launches `$EDITOR`; tests inject a
 * function that rewrites the file deterministically instead of spawning an
 * interactive editor.
 */
export type EditorRunner = (filePath: string) => void;

export interface EditOptions {
  memoryDir: string;
  atomId: string;
  agent_id?: string;
  session_id?: string;
  /** Override the interactive `$EDITOR` launch (testing / non-interactive use). */
  runEditor?: EditorRunner;
  /** Resolve the atom and report without launching the editor or emitting events. */
  dryRun?: boolean;
}

export interface EditResult {
  atom_id: string;
  type: string;
  changed: boolean;
  hash_before: string;
  hash_after: string;
  lines_added: number;
  lines_removed: number;
  updated_at: string;
  reason?: string;
}

/** Default editor launcher — honours `$EDITOR`/`$VISUAL`, falls back to `vi`. */
function defaultEditor(filePath: string): void {
  const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
  // Support "code -w" / "subl -w"-style EDITOR strings (binary + flags).
  const [bin, ...args] = editor.split(' ').filter(Boolean);
  const res = spawnSync(bin, [...args, filePath], { stdio: 'inherit' });
  if (res.error) {
    throw new Error(`Failed to launch editor "${editor}": ${res.error.message}`);
  }
  // Abnormal termination by signal leaves `status === null`; treat it as a
  // failed edit so a Ctrl-C'd / killed editor never records a human_edit from
  // a partially-written file.
  if (res.signal) {
    throw new Error(`Editor "${editor}" terminated by signal ${res.signal}`);
  }
  if (typeof res.status === 'number' && res.status !== 0) {
    throw new Error(`Editor "${editor}" exited with status ${res.status}`);
  }
}

/**
 * Order-insensitive multiset line diff — counts how many distinct lines were
 * added vs removed. A summary, not a patch: enough for the event meta to record
 * the shape of a hand edit without storing the full before/after content.
 */
function diffLines(before: string, after: string): { added: number; removed: number } {
  const countLines = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (const line of s.split('\n')) m.set(line, (m.get(line) ?? 0) + 1);
    return m;
  };
  const b = countLines(before);
  const a = countLines(after);
  let added = 0;
  let removed = 0;
  for (const [line, n] of a) added += Math.max(0, n - (b.get(line) ?? 0));
  for (const [line, n] of b) removed += Math.max(0, n - (a.get(line) ?? 0));
  return { added, removed };
}

/**
 * Open an atom in `$EDITOR` and record a provenanced `human_edit` event when the
 * file content changes. Idempotent on no-change: an editor session that saves
 * nothing emits no event. The post-edit atom is re-serialized through the
 * canonical writer so the on-disk bytes match the recorded snapshot — this keeps
 * the reflect backward-detector (`src/provenance.ts`) from re-flagging the same
 * edit as an unprovenanced write on the next cycle.
 */
export function editAtom(opts: EditOptions): EditResult {
  const { memoryDir, atomId } = opts;
  const agentId = opts.agent_id ?? 'cli';
  const sessionId = opts.session_id ?? 'mk-edit';

  const file = findAtomFile(memoryDir, atomId);
  if (!file) {
    throw new Error(`Atom not found: ${atomId}`);
  }
  // Path-traversal guard: the path is keyed off a user-supplied atom ID.
  assertWithinDir(memoryDir, file);

  const before = fs.readFileSync(file, 'utf-8');
  if (isEncrypted(before)) {
    throw new Error(
      `Atom ${atomId} is encrypted (SECRET); mk edit cannot edit ciphertext directly. ` +
        `Decrypt out-of-band or update it through the SDK.`,
    );
  }

  if (opts.dryRun) {
    const atom = readAtom(file);
    const h = sha256Hex(before);
    return {
      atom_id: atomId,
      type: atom.frontmatter.type,
      changed: false,
      hash_before: h,
      hash_after: h,
      lines_added: 0,
      lines_removed: 0,
      updated_at: atom.frontmatter.updated_at,
      reason: 'dry-run',
    };
  }

  const runEditor = opts.runEditor ?? defaultEditor;
  runEditor(file);

  const after = fs.readFileSync(file, 'utf-8');
  const hashBefore = sha256Hex(before);
  const hashAfter = sha256Hex(after);

  if (before === after) {
    const atom = readAtom(file);
    return {
      atom_id: atomId,
      type: atom.frontmatter.type,
      changed: false,
      hash_before: hashBefore,
      hash_after: hashAfter,
      lines_added: 0,
      lines_removed: 0,
      updated_at: atom.frontmatter.updated_at,
      reason: 'no changes',
    };
  }

  // Re-parse the edited file, stamp updated_at, and re-write through the
  // canonical serializer so the snapshot we record IS the on-disk content.
  const atom = readAtom(file);
  const now = normalizeTimestamp();
  atom.frontmatter.updated_at = now;
  writeAtom(atom, file);

  const { added, removed } = diffLines(before, after);

  appendEvent(memoryDir, 'human_edit', {
    agent_id: agentId,
    session_id: sessionId,
    atom_refs: [atomId],
    touched_paths: [file],
    evidence: [`hash ${hashBefore.slice(0, 12)} → ${hashAfter.slice(0, 12)}`],
    meta: {
      source: 'mk edit',
      hash_before: hashBefore,
      hash_after: hashAfter,
      lines_added: added,
      lines_removed: removed,
    },
    schema_version: 2,
    atom_snapshot: snapshotAtom(atom),
  });

  if (indexExists(memoryDir)) {
    atom.filePath = file;
    indexAtom(memoryDir, atom);
  }

  return {
    atom_id: atomId,
    type: atom.frontmatter.type,
    changed: true,
    hash_before: hashBefore,
    hash_after: hashAfter,
    lines_added: added,
    lines_removed: removed,
    updated_at: now,
  };
}
