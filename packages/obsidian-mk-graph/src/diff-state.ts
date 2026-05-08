import type { ParsedAtom } from './atom-parser.js';

export type DiffTag = 'added' | 'removed' | 'mutated' | 'unchanged';

export interface DiffSet {
  added: Set<string>;
  removed: Set<string>;
  mutated: Set<string>;
  /** Returns the tag for a given atom id. Cheap O(1) lookup used by the
   *  renderer per node. */
  classify(id: string): DiffTag;
  /** The atom set the renderer should display: union of `prev` and `next`
   *  by id, with `next` winning on overlap so mutated atoms render with
   *  their newer content. Removed atoms come from `prev`. */
  union(): ParsedAtom[];
}

/**
 * Compute the diff between two replayed states. Mutation is detected by
 * `updated_at` change — content-hash diffing would be more precise but
 * `updated_at` is what mk-core writes on every mutation event, so it's
 * the cheapest reliable signal.
 *
 * The returned `union()` is the set of atoms the renderer should draw:
 *  - added atoms come from `next`
 *  - mutated atoms come from `next` (newer state)
 *  - removed atoms come from `prev` (so they're visible to render as ghosts)
 *  - unchanged atoms come from `next` (== prev for these)
 */
export function diffStates(
  prev: ReadonlyMap<string, ParsedAtom>,
  next: ReadonlyMap<string, ParsedAtom>,
): DiffSet {
  const added = new Set<string>();
  const removed = new Set<string>();
  const mutated = new Set<string>();

  for (const [id, n] of next) {
    const p = prev.get(id);
    if (!p) added.add(id);
    else if (p.updatedAt !== n.updatedAt) mutated.add(id);
  }
  for (const id of prev.keys()) {
    if (!next.has(id)) removed.add(id);
  }

  const classify = (id: string): DiffTag => {
    if (added.has(id)) return 'added';
    if (removed.has(id)) return 'removed';
    if (mutated.has(id)) return 'mutated';
    return 'unchanged';
  };

  const union = (): ParsedAtom[] => {
    const out: ParsedAtom[] = [];
    for (const a of next.values()) out.push(a);
    for (const [id, a] of prev) {
      if (!next.has(id)) out.push(a);
    }
    return out;
  };

  return { added, removed, mutated, classify, union };
}
