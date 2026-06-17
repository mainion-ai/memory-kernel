/**
 * Content-length normalization scoring.
 *
 * Pure ranking primitive extracted from recall.ts so it can be unit-tested in
 * isolation. Re-exported from recall.ts for API stability.
 */

import type { Atom } from '../types.js';

/**
 * Compute per-atom length normalization factors.
 *
 * Atoms longer than the average word count in the result set get a penalty
 * factor < 1.0. Atoms at or below average get 1.0 (no boost).
 *
 * Formula: lengthFactor = 1 / (1 + k * (wordCount / avgWordCount - 1))
 * where k controls penalty strength. Clamped to 1.0 for short atoms.
 */
export function computeLengthFactors(
  filtered: Atom[],
  k: number,
): Map<string, number> {
  const factors = new Map<string, number>();

  if (k === 0 || filtered.length === 0) return factors;

  // Compute word counts
  const wordCounts = new Map<string, number>();
  let totalWords = 0;
  for (const atom of filtered) {
    const wc = atom.body.split(/\s+/).filter(w => w.length > 0).length;
    wordCounts.set(atom.frontmatter.id, wc);
    totalWords += wc;
  }

  const avgWordCount = totalWords / filtered.length;

  // Edge case: all atoms empty or single atom
  if (avgWordCount === 0) return factors;

  for (const atom of filtered) {
    const id = atom.frontmatter.id;
    const wc = wordCounts.get(id) ?? 0;
    const ratio = wc / avgWordCount;

    if (ratio <= 1.0) {
      // At or below average — no penalty (factor = 1.0)
      factors.set(id, 1.0);
    } else {
      // Above average — apply penalty
      const factor = 1 / (1 + k * (ratio - 1));
      factors.set(id, factor);
    }
  }

  return factors;
}
