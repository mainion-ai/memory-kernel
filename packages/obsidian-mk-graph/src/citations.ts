import type { ParsedAtom } from './atom-parser.js';

/**
 * Count inbound relation edges per atom id, restricted to edges whose
 * target exists in the input set. Used by the F2 encoder to size nodes
 * by `log10(citations + 1)`.
 *
 * Behaviour contract:
 * - Edges to atoms not in the input set are dropped (no phantom node
 *   sizes for dangling references).
 * - Self-references (an atom whose relation target equals its own id)
 *   are NOT counted — self-edges aren't citations.
 * - Duplicate edges between the same source and target (e.g. one
 *   `extends` and one `supports` from A to B) ARE counted separately.
 *   Each relation row is a distinct typed assertion.
 * - Atoms with zero inbound edges are ABSENT from the returned map
 *   (not mapped to `0`). Callers should use `counts.get(id) ?? 0`.
 */
export function countIncomingCitations(atoms: ParsedAtom[]): Map<string, number> {
  const known = new Set(atoms.map((a) => a.id));
  const counts = new Map<string, number>();
  for (const a of atoms) {
    for (const rel of a.relations) {
      if (rel.target === a.id) continue; // ignore self-edges
      if (!known.has(rel.target)) continue;
      counts.set(rel.target, (counts.get(rel.target) ?? 0) + 1);
    }
  }
  return counts;
}
