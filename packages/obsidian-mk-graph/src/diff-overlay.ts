import type { DiffTag } from './diff-state.js';

/** Diff palette — chosen for distinguishability against the F2 type colors
 *  (which lean cool — blue / purple / teal). Green/red/amber are warm and
 *  saturated so they pop atop the F2 baseline. */
export const DIFF_COLORS = {
  added:    '#22c55e', // green-500
  removed:  '#ef4444', // red-500
  mutated:  '#f59e0b', // amber-500
} as const;

const REMOVED_GHOST_OPACITY = 0.25;

/** Pure function: given the diff tag for a node and its F2 color, return
 *  the color the renderer should draw with. */
export function diffNodeColor(tag: DiffTag, fallback: string): string {
  if (tag === 'added') return DIFF_COLORS.added;
  if (tag === 'removed') return DIFF_COLORS.removed;
  if (tag === 'mutated') return DIFF_COLORS.mutated;
  return fallback;
}

/** Pure function: given the diff tag and F2 opacity, return the rendered
 *  opacity. Removed atoms ghost out so they're visible but de-emphasised. */
export function diffNodeOpacity(tag: DiffTag, fallback: number): number {
  if (tag === 'removed') return REMOVED_GHOST_OPACITY;
  return fallback;
}

/** Edge color in Diff mode: the more "interesting" endpoint wins. Source
 *  takes priority over target so an added→unchanged edge renders green
 *  (drawing the eye to the new structure), and an unchanged→removed edge
 *  renders red (highlighting the gap). */
export function diffEdgeColor(sourceTag: DiffTag, targetTag: DiffTag, fallback: string): string {
  if (sourceTag !== 'unchanged') return diffNodeColor(sourceTag, fallback);
  if (targetTag !== 'unchanged') return diffNodeColor(targetTag, fallback);
  return fallback;
}
