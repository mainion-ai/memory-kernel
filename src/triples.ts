/**
 * triples — entity-relation triple store for Tier-1 semantic conflict detection (#75).
 *
 * Triples are (subject, predicate, object) facts extracted from atom bodies at
 * ingestion time. They are stored lower-cased for case-insensitive matching.
 *
 * Tier 1: cheap, deterministic SQL match — same (subject, predicate), different
 * object → candidate conflict. The Tier 2 LLM call in conflict-detect.ts decides
 * whether the candidate is a real conflict.
 */

import { openIndex } from './index-db.js';
import { normalizeTimestamp } from './format.js';
import type { EntityTriple, TripleInput } from './types.js';

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Insert one or more triples for an atom. No-op for empty input.
 * Strings are normalized (trim + lower-case) to make matching case-insensitive.
 */
export function insertTriples(
  memoryDir: string,
  atomId: string,
  triples: readonly TripleInput[],
): void {
  if (triples.length === 0) return;

  const db = openIndex(memoryDir);
  const now = normalizeTimestamp();
  const stmt = db.prepare(
    `INSERT INTO entity_triples (atom_id, subject, predicate, object, confidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction((rows: readonly TripleInput[]) => {
    for (const t of rows) {
      if (!t.subject || !t.predicate || !t.object) continue;
      stmt.run(
        atomId,
        normalize(t.subject),
        normalize(t.predicate),
        normalize(t.object),
        t.confidence ?? 1.0,
        now,
      );
    }
  });
  tx(triples);
}

/**
 * Return all triples for a given atom.
 */
export function getTriplesForAtom(memoryDir: string, atomId: string): EntityTriple[] {
  const db = openIndex(memoryDir);
  return db.prepare(
    `SELECT atom_id, subject, predicate, object, confidence, created_at
     FROM entity_triples WHERE atom_id = ?`,
  ).all(atomId) as EntityTriple[];
}

export interface ConflictCandidate {
  old_atom_id: string;
  old_triple: EntityTriple;
  new_triple: EntityTriple;
}

/**
 * For each triple owned by `newAtomId`, return existing atoms that share the
 * (subject, predicate) but have a different object. Excludes:
 *   - the new atom itself
 *   - atoms with status 'superseded' or 'archived'
 *
 * Returns one row per matching old triple (an old atom with multiple matching
 * triples produces multiple rows).
 */
export function findCandidateConflicts(
  memoryDir: string,
  newAtomId: string,
): ConflictCandidate[] {
  const db = openIndex(memoryDir);
  const newTriples = getTriplesForAtom(memoryDir, newAtomId);
  if (newTriples.length === 0) return [];

  const stmt = db.prepare(
    `SELECT t.atom_id, t.subject, t.predicate, t.object, t.confidence, t.created_at
       FROM entity_triples t
       JOIN atoms a ON a.atom_id = t.atom_id
      WHERE t.subject = ?
        AND t.predicate = ?
        AND t.object <> ?
        AND t.atom_id <> ?
        AND a.status NOT IN ('superseded', 'archived')`,
  );

  const out: ConflictCandidate[] = [];
  for (const nt of newTriples) {
    const rows = stmt.all(nt.subject, nt.predicate, nt.object, newAtomId) as EntityTriple[];
    for (const ot of rows) {
      out.push({ old_atom_id: ot.atom_id, old_triple: ot, new_triple: nt });
    }
  }
  return out;
}
