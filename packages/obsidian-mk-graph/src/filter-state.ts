import type { ParsedAtom } from './atom-parser.js';

/**
 * Filter state for the side panel. Each Set is "what's hidden" except
 * `selectedTags` which is "what's required" — empty Set in either case
 * means "no filtering on this dimension".
 *
 * A Set-based representation keeps state compact (just the diff from
 * "show all"), survives type/status/classification additions in mk-core
 * without breaking persisted settings, and serializes cleanly via Array.from.
 */
export interface FilterState {
  /** Case-insensitive substring matched against atom id, body, and tags.
   *  Empty string disables the search filter. */
  search: string;
  /** Atom types to hide. Empty = show all types. */
  hiddenTypes: Set<string>;
  /** Atom statuses to hide. Empty = show all statuses. */
  hiddenStatuses: Set<string>;
  /** Atom classifications to hide. Empty = show all classifications. */
  hiddenClassifications: Set<string>;
  /** Tags to focus on. Empty = no tag filter. Non-empty = an atom must
   *  have at least one of these tags. */
  selectedTags: Set<string>;
  /** When true, only show atoms with no outbound relations AND no inbound
   *  references (true graph orphans). */
  orphansOnly: boolean;
}

/** Build a fresh FilterState that matches every atom. */
export function defaultFilterState(): FilterState {
  return {
    search: '',
    hiddenTypes: new Set(),
    hiddenStatuses: new Set(),
    hiddenClassifications: new Set(),
    selectedTags: new Set(),
    orphansOnly: false,
  };
}

/**
 * Predicate: does the given atom pass all active filter dimensions?
 *
 * `isReferenced(id)` is supplied by the caller and reports whether any
 * other atom links to this one. The view computes this once per render
 * via `GraphState.getReferencedIds()` so this predicate stays O(1) per
 * atom.
 */
export function matchesFilter(
  atom: ParsedAtom,
  state: FilterState,
  isReferenced: (id: string) => boolean,
): boolean {
  if (state.hiddenTypes.has(atom.type)) return false;
  if (state.hiddenStatuses.has(atom.status)) return false;
  if (state.hiddenClassifications.has(atom.classification)) return false;

  if (state.selectedTags.size > 0) {
    const hit = atom.tags.some((t) => state.selectedTags.has(t));
    if (!hit) return false;
  }

  if (state.search.length > 0) {
    const q = state.search.toLowerCase();
    const inId = atom.id.toLowerCase().includes(q);
    const inBody = atom.body.toLowerCase().includes(q);
    const inTags = atom.tags.some((t) => t.toLowerCase().includes(q));
    if (!inId && !inBody && !inTags) return false;
  }

  if (state.orphansOnly) {
    if (atom.relations.length > 0) return false;
    if (isReferenced(atom.id)) return false;
  }

  return true;
}

/** JSON-serializable shape used by `MkGraphSettings.filters`. */
export interface SerializedFilterState {
  search?: string;
  hiddenTypes?: string[];
  hiddenStatuses?: string[];
  hiddenClassifications?: string[];
  selectedTags?: string[];
  orphansOnly?: boolean;
}

export function serializeFilterState(s: FilterState): SerializedFilterState {
  return {
    search: s.search,
    hiddenTypes: [...s.hiddenTypes].sort(),
    hiddenStatuses: [...s.hiddenStatuses].sort(),
    hiddenClassifications: [...s.hiddenClassifications].sort(),
    selectedTags: [...s.selectedTags].sort(),
    orphansOnly: s.orphansOnly,
  };
}

export function deserializeFilterState(blob: unknown): FilterState {
  const out = defaultFilterState();
  if (!blob || typeof blob !== 'object') return out;
  const b = blob as SerializedFilterState;
  if (typeof b.search === 'string') out.search = b.search;
  if (Array.isArray(b.hiddenTypes)) for (const t of b.hiddenTypes) if (typeof t === 'string') out.hiddenTypes.add(t);
  if (Array.isArray(b.hiddenStatuses)) for (const t of b.hiddenStatuses) if (typeof t === 'string') out.hiddenStatuses.add(t);
  if (Array.isArray(b.hiddenClassifications)) for (const t of b.hiddenClassifications) if (typeof t === 'string') out.hiddenClassifications.add(t);
  if (Array.isArray(b.selectedTags)) for (const t of b.selectedTags) if (typeof t === 'string') out.selectedTags.add(t);
  if (typeof b.orphansOnly === 'boolean') out.orphansOnly = b.orphansOnly;
  return out;
}
