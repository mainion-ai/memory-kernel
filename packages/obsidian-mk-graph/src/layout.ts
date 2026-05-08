import type { GraphNode } from './graph-state.js';
import { computeTimelinePositions } from './timeline-layout.js';

export type LayoutKind = 'force' | 'timeline';

export interface LayoutOptions {
  kind: LayoutKind;
  width: number;
  height: number;
  /** Required for `timeline`; ignored for `force`. ISO8601. */
  fromIso: string;
  /** Required for `timeline`; ignored for `force`. ISO8601. */
  toIso: string;
}

/**
 * Mutate the supplied node array in place to apply the chosen layout.
 *  - `force`: clear `fx`/`fy` so the simulation owns positions.
 *  - `timeline`: compute pinned positions via `computeTimelinePositions`
 *    and set `fx`/`fy` on each node. The renderer should freeze the
 *    simulation while pinned positions are set.
 *
 * Mutating in place keeps force-graph's internal node references stable
 * (force-graph rewrites `source` and `target` to node-object references
 * on the first tick; replacing the array would orphan those refs).
 */
export function applyLayout(nodes: GraphNode[], opts: LayoutOptions): void {
  if (opts.kind === 'force') {
    for (const n of nodes) {
      n.fx = undefined;
      n.fy = undefined;
    }
    return;
  }

  // timeline
  const positions = computeTimelinePositions(nodes, {
    width: opts.width,
    height: opts.height,
    fromIso: opts.fromIso,
    toIso: opts.toIso,
  });
  for (const n of nodes) {
    const p = positions.get(n.id);
    if (p) {
      n.fx = p.x;
      n.fy = p.y;
    }
  }
}
