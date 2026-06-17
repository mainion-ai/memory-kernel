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
import { appendTriplesSidecar } from './triples-sidecar.js';
import type { EntityTriple, TripleInput } from './types.js';

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Hard cap on fuzzy-arm candidates per source triple in `findCandidateConflicts`.
 *
 * Each candidate that survives Tier 1 triggers a Tier-2 Claude CLI confirmation
 * call. Without a cap, a single ingestion that touches a high-cardinality
 * predicate (`is_a`, `has_tag`, …) returns every other atom sharing that
 * predicate as a candidate — O(N) `claude` spawns per `mk extract`. The cap
 * trades a small chance of missing a real alias for predictable cost.
 */
const FUZZY_CANDIDATE_LIMIT = 20;

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
  // Collect the rows actually written so the durable sidecar (#370) mirrors the
  // table exactly — same normalization, same created_at, same skip rules.
  const written: EntityTriple[] = [];
  const tx = db.transaction((rows: readonly TripleInput[]) => {
    for (const t of rows) {
      if (!t.subject || !t.predicate || !t.object) continue;
      const row: EntityTriple = {
        atom_id: atomId,
        subject: normalize(t.subject),
        predicate: normalize(t.predicate),
        object: normalize(t.object),
        confidence: t.confidence ?? 1.0,
        created_at: now,
      };
      stmt.run(row.atom_id, row.subject, row.predicate, row.object, row.confidence, row.created_at);
      written.push(row);
    }
  });
  tx(triples);
  // Append after the DB commit so the sidecar never records triples that failed
  // to insert. If this append fails, the next reindex reconciles the sidecar
  // from the table anyway.
  appendTriplesSidecar(memoryDir, written);
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
 *   - atoms with status 'superseded', 'archived', or 'expired' (i.e. anything
 *     not active — kept in sync with queryIndex / wander)
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
        AND a.status NOT IN ('superseded', 'archived', 'expired')`,
  );

  // Fallback: match on predicate alone when subjects differ but are likely aliases.
  // E.g. "alex lives_in NYC" vs "user lives_in Boston" — same entity, different naming.
  //
  // Bounded by FUZZY_CANDIDATE_LIMIT and ordered by recency: without the cap,
  // high-cardinality predicates (`is_a`, `has_tag`, etc.) return every other
  // atom in the store as a candidate, and each candidate fires a Tier-2 LLM
  // confirmation call in detectAndResolveConflicts — O(N) Claude spawns per
  // mk extract. Recent atoms are preferred under the cap as the more likely
  // alias candidates.
  const stmtFuzzy = db.prepare(
    `SELECT t.atom_id, t.subject, t.predicate, t.object, t.confidence, t.created_at
       FROM entity_triples t
       JOIN atoms a ON a.atom_id = t.atom_id
      WHERE t.predicate = ?
        AND t.object <> ?
        AND t.atom_id <> ?
        AND t.subject <> ?
        AND a.status NOT IN ('superseded', 'archived', 'expired')
      ORDER BY t.created_at DESC
      LIMIT ?`,
  );

  const out: ConflictCandidate[] = [];
  const seen = new Set<string>(); // track old_atom_id + predicate pairs to avoid duplicates

  for (const nt of newTriples) {
    // Exact subject match first (high confidence)
    const rows = stmt.all(nt.subject, nt.predicate, nt.object, newAtomId) as EntityTriple[];
    for (const ot of rows) {
      const key = `${ot.atom_id}:${ot.predicate}`;
      seen.add(key);
      out.push({ old_atom_id: ot.atom_id, old_triple: ot, new_triple: nt });
    }

    // Fuzzy subject match: same predicate, different subject, different object.
    // Only include if not already matched exactly. Capped per call to bound
    // downstream Tier-2 LLM confirmation cost (see stmtFuzzy comment above).
    const fuzzyRows = stmtFuzzy.all(
      nt.predicate,
      nt.object,
      newAtomId,
      nt.subject,
      FUZZY_CANDIDATE_LIMIT,
    ) as EntityTriple[];
    for (const ot of fuzzyRows) {
      const key = `${ot.atom_id}:${ot.predicate}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ old_atom_id: ot.atom_id, old_triple: ot, new_triple: nt });
    }
  }
  return out;
}
