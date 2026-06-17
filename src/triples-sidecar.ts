/**
 * Durable on-disk store for entity triples (#370).
 *
 * Triples are LLM-extracted at atom-write time and are NOT serialized into the
 * atom markdown, so historically the SQLite `entity_triples` table was their
 * only home — deleting `.memory-index.db` lost them permanently. This NDJSON
 * sidecar (`<memoryDir>/triples.ndjson`, parallel to `events.ndjson`) is the
 * durable source of truth: `insertTriples` mirrors every row here, and
 * `reindex` rebuilds the table from it. The SQLite table is now a derived
 * cache like the rest of the index.
 *
 * One JSON object per line: `{ atom_id, subject, predicate, object,
 * confidence, created_at }` — the full `EntityTriple` shape.
 */

import path from 'path';
import fs from 'fs';
import { writeFileAtomic } from './store.js';
import type { EntityTriple } from './types.js';

const SIDECAR_FILENAME = 'triples.ndjson';

/** Absolute path to a store's triples sidecar. */
export function triplesSidecarPath(memoryDir: string): string {
  return path.join(memoryDir, SIDECAR_FILENAME);
}

/** Append rows to the sidecar (creating it if absent). No-op for empty input. */
export function appendTriplesSidecar(memoryDir: string, rows: readonly EntityTriple[]): void {
  if (rows.length === 0) return;
  const p = triplesSidecarPath(memoryDir);
  const lines = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  // fsync + owner-only perms for parity with the events.ndjson append (#138):
  // this sidecar is the durable source of truth for triples, so the write must
  // actually reach disk, and triple content (extracted from possibly SECRET
  // atoms) must not be world/group-readable.
  const fd = fs.openSync(p, 'a');
  try {
    fs.writeSync(fd, lines);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try { fs.chmodSync(p, 0o600); } catch { /* best-effort; no-op on Windows */ }
}

/**
 * Read all triples from the sidecar. Returns [] when the file is absent.
 * Malformed or partially-shaped lines are skipped (resilience parity with the
 * event-log reader) rather than aborting the whole read.
 */
export function readTriplesSidecar(memoryDir: string): EntityTriple[] {
  const p = triplesSidecarPath(memoryDir);
  if (!fs.existsSync(p)) return [];
  const out: EntityTriple[] = [];
  for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Partial<EntityTriple>;
      if (
        obj &&
        typeof obj.atom_id === 'string' &&
        typeof obj.subject === 'string' &&
        typeof obj.predicate === 'string' &&
        typeof obj.object === 'string'
      ) {
        out.push({
          atom_id: obj.atom_id,
          subject: obj.subject,
          predicate: obj.predicate,
          object: obj.object,
          confidence: typeof obj.confidence === 'number' ? obj.confidence : 1.0,
          created_at: typeof obj.created_at === 'string' ? obj.created_at : '',
        });
      }
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/**
 * Atomically rewrite the sidecar to exactly `rows` (tmp file + rename). Used by
 * reindex to reconcile the sidecar with the rebuilt table (backfilling old
 * stores and pruning orphaned triples). Writing an empty set removes the file.
 */
export function writeTriplesSidecar(memoryDir: string, rows: readonly EntityTriple[]): void {
  const p = triplesSidecarPath(memoryDir);
  if (rows.length === 0) {
    if (fs.existsSync(p)) fs.rmSync(p);
    return;
  }
  const content = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  // Reuse the shared atomic writer (tmp + fsync + rename, owner-only perms, tmp
  // cleanup on rename failure) rather than a hand-rolled tmp+rename — parity with
  // events.ndjson / atom files (#138), and the write actually reaches disk.
  writeFileAtomic(p, content, 0o600);
}
