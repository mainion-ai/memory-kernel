import type { ParsedAtom } from './atom-parser.js';

/**
 * Count inbound relation edges per atom id, restricted to edges whose
 * target exists in the input set. Used by the F2 encoder to size nodes
 * by `log10(citations+1)`. Edges to missing atoms are ignored so dangling
 * references don't inflate phantom node sizes.
 */
export function countIncomingCitations(atoms: ParsedAtom[]): Map<string, number> {
  const known = new Set(atoms.map((a) => a.id));
  const counts = new Map<string, number>();
  for (const a of atoms) {
    for (const rel of a.relations) {
      if (!known.has(rel.target)) continue;
      counts.set(rel.target, (counts.get(rel.target) ?? 0) + 1);
    }
  }
  return counts;
}
