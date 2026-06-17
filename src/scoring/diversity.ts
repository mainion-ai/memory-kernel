/**
 * Result diversity scoring — trigram similarity + Maximal Marginal Relevance.
 *
 * Pure ranking primitives extracted from recall.ts so they can be unit-tested
 * in isolation. Re-exported from recall.ts for API stability.
 */

import type { Atom } from '../types.js';

/**
 * Extract word trigrams from text. Lowercase, strip punctuation, split into words,
 * then generate consecutive 3-word windows.
 */
function extractTrigrams(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .split(/\s+/)
    .filter(w => w.length > 0);

  const trigrams = new Set<string>();
  for (let i = 0; i <= words.length - 3; i++) {
    trigrams.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }
  return trigrams;
}

/**
 * Compute Jaccard similarity on word trigrams between two text bodies.
 * Returns 0.0 (no overlap) to 1.0 (identical trigram sets).
 *
 * Edge case: texts shorter than 3 words produce no trigrams; two empty
 * trigram sets are treated as identical (returns 1.0). In practice atom
 * bodies are always longer than 3 words.
 *
 * Accepts optional pre-computed trigram sets to avoid redundant extraction
 * in the MMR loop (O(n) instead of O(n²) extractions).
 */
export function computeTextSimilarity(
  bodyA: string,
  bodyB: string,
  precomputedA?: Set<string>,
  precomputedB?: Set<string>,
): number {
  const trigramsA = precomputedA ?? extractTrigrams(bodyA);
  const trigramsB = precomputedB ?? extractTrigrams(bodyB);

  if (trigramsA.size === 0 && trigramsB.size === 0) return 1.0;
  if (trigramsA.size === 0 || trigramsB.size === 0) return 0.0;

  let intersection = 0;
  for (const t of trigramsA) {
    if (trigramsB.has(t)) intersection++;
  }

  const union = trigramsA.size + trigramsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Apply Maximal Marginal Relevance re-ranking (Carbonell & Goldstein, 1998).
 *
 * Greedy selection: pick the highest-scoring atom first, then iteratively select
 * the candidate that maximizes λ * score(d) - (1-λ) * max_sim(d, selected).
 *
 * Scores are normalized to [0, 1] before MMR computation. The returned scores
 * are the MMR scores (for debugging/audit), not the original relevance scores.
 * Note: returned scores can be negative when diversity penalty exceeds relevance
 * (e.g., low-relevance atom highly similar to already-selected atoms).
 *
 * O(n²) similarity comparisons but n is small (typically <200 atoms after
 * filtering). Trigrams are precomputed once per atom to avoid O(n²) extraction.
 */
export function applyMMR(
  scored: Array<{ atom: Atom; score: number }>,
  lambda: number,
): Array<{ atom: Atom; score: number }> {
  if (scored.length <= 1 || lambda >= 1.0) return scored;

  // Normalize scores to [0, 1]
  let maxScore = -Infinity;
  let minScore = Infinity;
  for (const s of scored) {
    if (s.score > maxScore) maxScore = s.score;
    if (s.score < minScore) minScore = s.score;
  }
  const scoreRange = maxScore - minScore || 1;

  // Precompute trigrams once per atom (avoids O(n²) extraction in the loop)
  const candidates = scored.map(s => ({
    atom: s.atom,
    normalizedScore: (s.score - minScore) / scoreRange,
    trigrams: extractTrigrams(s.atom.body),
  }));

  const selected: Array<{ atom: Atom; score: number }> = [];
  const selectedTrigrams: Set<string>[] = [];
  const remaining = new Set(candidates.map((_, i) => i));

  // First pick: highest normalized score
  let bestIdx = 0;
  let bestNorm = -Infinity;
  for (const i of remaining) {
    if (candidates[i].normalizedScore > bestNorm) {
      bestNorm = candidates[i].normalizedScore;
      bestIdx = i;
    }
  }
  selected.push({ atom: candidates[bestIdx].atom, score: candidates[bestIdx].normalizedScore });
  selectedTrigrams.push(candidates[bestIdx].trigrams);
  remaining.delete(bestIdx);

  // Greedy MMR loop
  while (remaining.size > 0) {
    let bestMMR = -Infinity;
    let bestCandIdx = -1;

    for (const i of remaining) {
      const relevance = candidates[i].normalizedScore;

      // max similarity to any already-selected atom
      let maxSim = 0;
      for (const selTri of selectedTrigrams) {
        const sim = computeTextSimilarity('', '', candidates[i].trigrams, selTri);
        if (sim > maxSim) maxSim = sim;
      }

      const mmrScore = lambda * relevance - (1 - lambda) * maxSim;
      if (mmrScore > bestMMR) {
        bestMMR = mmrScore;
        bestCandIdx = i;
      }
    }

    if (bestCandIdx === -1) break;

    selected.push({ atom: candidates[bestCandIdx].atom, score: bestMMR });
    selectedTrigrams.push(candidates[bestCandIdx].trigrams);
    remaining.delete(bestCandIdx);
  }

  return selected;
}
