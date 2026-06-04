/**
 * Two-pass type-aware token budget allocator.
 *
 * Pass 1: reserve per-type quotas (scaled to MAX_RESERVATION_RATIO of budget).
 * Pass 2: fill remainder by score (task-driven recall) or recency (fill render),
 *         from atoms that did not get a reserved slot.
 *
 * The same algorithm serves two callers:
 *   - `src/recall.ts` task-driven recall (score-ranked Pass 2)
 *   - `src/render.ts` renderFill / renderClaudeMd (recency-ranked Pass 2)
 *
 * Issue #154: fill mode used to be a single-pass recency fill — beliefs
 * monopolised the budget and other types were starved. Routing fill mode
 * through this helper guarantees per-type slots.
 */

import type { Atom, AtomFrontmatter, AtomType } from './types.js';

/** Maximum fraction of total budget that reservations may consume. */
export const MAX_RESERVATION_RATIO = 0.3;

/** Pass-2 tie-breaker mode. */
export type Pass2Mode =
  | { mode: 'recency' }
  | { mode: 'score'; scores: Map<string, number> };

/** Rough token estimate (4 chars per token). Matches src/recall.ts. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Issue #114: memoize `JSON.stringify(frontmatter)` across the recall hot path.
 *
 * Token counting calls JSON.stringify on the same frontmatter object multiple
 * times per recall (once in `atomTokens()` inside this helper, once in the
 * final reduce inside `src/recall.ts`). A WeakMap keyed on the frontmatter
 * reference is safe — frontmatter is treated as immutable after load — and
 * lets the GC reclaim entries when atoms go out of scope.
 */
const frontmatterJsonCache: WeakMap<AtomFrontmatter, string> = new WeakMap();

export function frontmatterJson(fm: AtomFrontmatter): string {
  const cached = frontmatterJsonCache.get(fm);
  if (cached !== undefined) return cached;
  const s = JSON.stringify(fm);
  frontmatterJsonCache.set(fm, s);
  return s;
}

function atomTokens(a: Atom): number {
  return estimateTokens(a.body + frontmatterJson(a.frontmatter));
}

function compareDescByUpdatedAt(a: Atom, b: Atom): number {
  return b.frontmatter.updated_at.localeCompare(a.frontmatter.updated_at);
}

function compareDescByScore(scores: Map<string, number>) {
  return (a: Atom, b: Atom) =>
    (scores.get(b.frontmatter.id) ?? 0) - (scores.get(a.frontmatter.id) ?? 0);
}

/**
 * Select atoms that fit within `maxTokens`, honouring per-type reservations.
 *
 * @param atoms - Candidate atoms (already filtered for status/classification).
 *                The order is significant only for stable tie-break inside a
 *                type; callers should pre-sort by their preferred Pass-1 order.
 * @param maxTokens - Hard budget cap in tokens.
 * @param reservations - Per-type token quotas. Sum is auto-scaled to fit
 *                       MAX_RESERVATION_RATIO * maxTokens.
 * @param pass2 - How to rank atoms in Pass 2 (recency for fill, score for task).
 */
export function selectAtomsWithReservations(
  atoms: Atom[],
  maxTokens: number,
  reservations: Partial<Record<AtomType, number>>,
  pass2: Pass2Mode,
): Atom[] {
  const reservedTypes = (Object.keys(reservations) as AtomType[])
    .filter((t) => (reservations[t] ?? 0) > 0);

  // No reservations → simple greedy fill by Pass-2 order.
  if (reservedTypes.length === 0) {
    const ordered = [...atoms].sort(
      pass2.mode === 'score' ? compareDescByScore(pass2.scores) : compareDescByUpdatedAt,
    );
    return greedyFill(ordered, maxTokens);
  }

  // Scale reservations so the total cannot exceed MAX_RESERVATION_RATIO of budget.
  const maxReservationBudget = Math.floor(maxTokens * MAX_RESERVATION_RATIO);
  const rawTotal = reservedTypes.reduce((s, t) => s + (reservations[t] ?? 0), 0);
  const scale = rawTotal > maxReservationBudget && rawTotal > 0
    ? maxReservationBudget / rawTotal
    : 1;
  const scaled: Partial<Record<AtomType, number>> = {};
  for (const t of reservedTypes) {
    scaled[t] = Math.floor((reservations[t] ?? 0) * scale);
  }

  // Pass-1 ordering: by Pass-2 comparator so the "best" candidates fill
  // their reserved slots first.
  const pass1Comparator =
    pass2.mode === 'score' ? compareDescByScore(pass2.scores) : compareDescByUpdatedAt;
  const ordered = [...atoms].sort(pass1Comparator);

  const reserved: Atom[] = [];
  const unreserved: Atom[] = [];
  const used: Partial<Record<AtomType, number>> = {};

  for (const atom of ordered) {
    const t = atom.frontmatter.type;
    const quota = scaled[t];
    if (quota !== undefined && quota > 0) {
      const tokens = atomTokens(atom);
      const cur = used[t] ?? 0;
      if (cur + tokens <= quota) {
        reserved.push(atom);
        used[t] = cur + tokens;
        continue;
      }
    }
    unreserved.push(atom);
  }

  const reservedTokens = reserved.reduce((s, a) => s + atomTokens(a), 0);
  const remainingBudget = Math.max(0, maxTokens - reservedTokens);
  const fromUnreserved = greedyFill(unreserved, remainingBudget);

  // Output ordering: keep Pass-2 ordering across the merged list so callers
  // see a consistent rank.
  const merged = [...reserved, ...fromUnreserved];
  merged.sort(pass1Comparator);
  return merged;
}

function greedyFill(atoms: Atom[], maxTokens: number): Atom[] {
  const out: Atom[] = [];
  let total = 0;
  for (const a of atoms) {
    const t = atomTokens(a);
    // Issue #112: continue past oversized atoms so smaller candidates further
    // down the score list can still consume the remaining budget. A `break`
    // here would abandon the entire fill the first time the top-ranked atom
    // doesn't fit.
    if (total + t > maxTokens) continue;
    out.push(a);
    total += t;
  }
  return out;
}
