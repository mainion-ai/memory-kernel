# obsidian-mk-graph v0.3.0 — Filter & Display Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a side overlay panel that lets the user filter the graph by atom type, status, classification, tag, search query, and orphan status — modeled after Obsidian's native graph view filters but specialized for the 9-type / 8-status / 4-classification mk taxonomy. Persisted across sessions.

**Architecture:** A pure-logic `filter-state.ts` module owns the data shape and the `matchesFilter(atom, state, isReferenced)` predicate. A DOM module `filter-panel.ts` mounts a collapsible side overlay and fires `onChange(state)` callbacks. The view owns one `FilterState` instance, applies it via a `.filter(matchesFilter)` pass before calling `state.replace()`, persists the state to `MkGraphSettings` on every change, and remounts the panel on view-open. Filters short-circuit at the view level so the renderer, scrubber, legend, and replay controller never need to know about filtering.

**Tech Stack:** TypeScript 5.x, Obsidian Plugin API, vitest (`node` for pure logic, `jsdom` for DOM tests via `*.dom.test.ts` glob — already configured since v0.2.0).

**Spec / Reference:** [Obsidian native graph filter panel](https://help.obsidian.md/plugins/graph-view) — same general layout (Filters / Display / Forces sections) but only the Filters subset ships in v0.3.0. `Display` toggles (showLegend, showScrubber, defaultLayout) already live in plugin settings; v0.3.0 adds `showFilterPanel`. `Forces` (centre/repel/link sliders), `Groups` (named filter sets with color tints), arrow toggle, and text-fade threshold are explicitly **out of scope** — tracked for v0.4+.

**Predecessor releases:**
- v0.2.0–v0.2.5: Phase 3 (replay + timeline + scrubber).
- v0.2.6–v0.2.10: Scrubber UX polish (slider width, Play/Loop, Live disable, click-to-open in Diff/Scrubbed, Diff defaults, edge dashes).
- v0.2.11: Tooltip meta one-field-per-line.

---

## File structure

| File | Action | Responsibility |
|---|---|---|
| `packages/obsidian-mk-graph/src/atom-types.ts` | Modify | Add `ATOM_STATUS_ORDER` and `ATOM_CLASSIFICATION_ORDER` constants alongside the existing `ATOM_TYPE_ORDER` so the filter panel can render checkboxes in a stable order |
| `packages/obsidian-mk-graph/src/filter-state.ts` | Create | `FilterState` interface, `defaultFilterState()`, `matchesFilter(atom, state, isReferenced)`, `serializeFilterState()`, `deserializeFilterState()` |
| `packages/obsidian-mk-graph/src/graph-state.ts` | Modify | Add `getAvailableTags(): string[]` method that returns the sorted unique tag set across all loaded atoms — used by the panel to populate tag chips. Also add `getReferencedIds(): Set<string>` for the orphans filter (atoms referenced as relation targets) |
| `packages/obsidian-mk-graph/src/filter-panel.ts` | Create | `createFilterPanel(parent, opts) → FilterPanelHandle`. Renders sections: search input, atom-type checkboxes, status checkboxes, classification checkboxes, tag chips, "orphans only" toggle. Fires `onChange(FilterState)` on every interaction. Exposes `setState(state)`, `setAvailableTags(tags)`, `destroy()` |
| `packages/obsidian-mk-graph/src/settings.ts` | Modify | Add `showFilterPanel: boolean` and `filters: SerializedFilterState` to `MkGraphSettings` and `DEFAULT_SETTINGS`; settings tab gets a "Show filter panel" toggle |
| `packages/obsidian-mk-graph/src/view.ts` | Modify | Own a single `FilterState` instance. Mount the filter panel into the body-attached overlay-layer (alongside legend + tooltip). Apply `matchesFilter` before each `state.replace()` call. Persist state changes to settings |
| `packages/obsidian-mk-graph/src/main.ts` | Modify | Add a "Toggle filter panel" command-palette entry that toggles `settings.showFilterPanel` and the panel's visibility on the active view |
| `packages/obsidian-mk-graph/styles.css` | Modify | Filter panel styling — fixed-width side overlay, collapsible sections, search input, type/status/classification checkboxes, tag chips, orphans toggle |
| `packages/obsidian-mk-graph/test/filter-state.test.ts` | Create | Pure-logic tests for `matchesFilter` covering each filter dimension and combinations |
| `packages/obsidian-mk-graph/test/filter-panel.dom.test.ts` | Create | jsdom tests — panel renders all sections, checkbox toggles fire `onChange`, search input fires `onChange`, `setAvailableTags` re-renders chips |
| `packages/obsidian-mk-graph/test/graph-state.test.ts` | Modify | Add tests for `getAvailableTags()` and `getReferencedIds()` |
| `packages/obsidian-mk-graph/CHANGELOG.md` | Modify | Add `## [0.3.0] — 2026-05-04` section |
| `packages/obsidian-mk-graph/package.json` | Modify | `"version": "0.3.0"` |
| `packages/obsidian-mk-graph/manifest.json` | Modify | `"version": "0.3.0"` |
| `packages/obsidian-mk-graph/SMOKE_TEST.md` | Modify | Add S15: filter panel walk |

**Out of scope for v0.3.0** (tracked for later):
- **Forces** sliders (centre / repel / link / link distance) — future v0.4
- **Groups** (named filter sets that re-color matching nodes) — future v0.4 or v0.5; needs design thought because it conflicts with the F2 type fill
- **Arrow direction toggle** on edges (currently `linkDirectionalArrowLength(0)` is hardcoded) — future v0.4 trivial follow-up
- **Text fade threshold** slider for label visibility (currently labels appear at force-graph `globalScale > 1.5`) — future v0.4
- **"Animate" / "freeze" simulation button** — future v0.4
- **Existing files only** toggle from Obsidian's native panel — not applicable here (atoms are always files)
- **Attachments** toggle — not applicable here (no attachments in mk's atom model)

---

## Task 1: Add status + classification ordering constants to `atom-types.ts`

**Files:**
- Modify: `packages/obsidian-mk-graph/src/atom-types.ts`

The filter panel needs stable orderings for status and classification checkboxes (just like `ATOM_TYPE_ORDER` exists for atom types). These constants are consumed by both the filter panel's section renderers and the legend in v0.4+ work.

- [ ] **Step 1.1: Read the current `atom-types.ts`**

```bash
cat packages/obsidian-mk-graph/src/atom-types.ts
```

It currently exports only `ATOM_TYPE_ORDER`, `typeBandIndex`, `TIMELINE_BAND_COUNT`. Append the two new ordering constants at the end of the file.

- [ ] **Step 1.2: Append `ATOM_STATUS_ORDER` and `ATOM_CLASSIFICATION_ORDER`**

Use `Edit` to add the following after the existing `TIMELINE_BAND_COUNT` declaration:

```typescript

/**
 * Canonical ordering of the 8 mk atom statuses. Used by the filter panel
 * to render status checkboxes in a stable, intuitive order:
 * "live" statuses first (active / accepted), then transient (draft),
 * then terminal (rejected / superseded / resolved / archived / expired).
 */
export const ATOM_STATUS_ORDER: readonly string[] = [
  'active',
  'accepted',
  'draft',
  'rejected',
  'superseded',
  'resolved',
  'archived',
  'expired',
] as const;

/**
 * Canonical ordering of the 4 mk atom classifications. Used by the filter
 * panel to render classification checkboxes in increasing-restriction
 * order (PUBLIC at the top, SECRET at the bottom).
 */
export const ATOM_CLASSIFICATION_ORDER: readonly string[] = [
  'PUBLIC',
  'TEAM',
  'PERSONAL',
  'SECRET',
] as const;
```

- [ ] **Step 1.3: Type-check**

```bash
cd packages/obsidian-mk-graph && npx tsc --noEmit 2>&1 | grep -E "atom-types.ts" | head -5
```

Expected: 0 errors in `atom-types.ts`.

- [ ] **Step 1.4: Commit**

```bash
git add packages/obsidian-mk-graph/src/atom-types.ts
git commit -m "feat(obsidian-mk-graph): add ATOM_STATUS_ORDER + ATOM_CLASSIFICATION_ORDER constants"
```

---

## Task 2: `filter-state.ts` — pure data shape + matches predicate

**Files:**
- Create: `packages/obsidian-mk-graph/src/filter-state.ts`
- Create: `packages/obsidian-mk-graph/test/filter-state.test.ts`

TDD: test → run (FAIL) → implement → run (PASS) → commit.

- [ ] **Step 2.1: Write the failing tests**

Create `packages/obsidian-mk-graph/test/filter-state.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  defaultFilterState,
  matchesFilter,
  serializeFilterState,
  deserializeFilterState,
  type FilterState,
} from '../src/filter-state.js';
import type { ParsedAtom } from '../src/atom-parser.js';

const atom = (overrides: Partial<ParsedAtom> = {}): ParsedAtom => ({
  id: 'FACT-2026-04-01-X-aa00',
  type: 'fact',
  status: 'active',
  classification: 'TEAM',
  confidence: 1,
  createdAt: '2026-04-01T10:00:00Z',
  updatedAt: '2026-04-01T10:00:00Z',
  ttlDays: null,
  tags: [],
  relations: [],
  body: '',
  ...overrides,
});

const noReferences = (): boolean => false;
const allReferenced = (): boolean => true;

describe('defaultFilterState', () => {
  it('returns a state that matches every atom (no filters active)', () => {
    const s = defaultFilterState();
    expect(s.search).toBe('');
    expect(s.hiddenTypes.size).toBe(0);
    expect(s.hiddenStatuses.size).toBe(0);
    expect(s.hiddenClassifications.size).toBe(0);
    expect(s.selectedTags.size).toBe(0);
    expect(s.orphansOnly).toBe(false);
  });
});

describe('matchesFilter — type / status / classification', () => {
  it('returns true when no filters are active', () => {
    expect(matchesFilter(atom(), defaultFilterState(), noReferences)).toBe(true);
  });

  it('hides atoms whose type is in hiddenTypes', () => {
    const s = defaultFilterState();
    s.hiddenTypes.add('fact');
    expect(matchesFilter(atom({ type: 'fact' }), s, noReferences)).toBe(false);
    expect(matchesFilter(atom({ type: 'belief' }), s, noReferences)).toBe(true);
  });

  it('hides atoms whose status is in hiddenStatuses', () => {
    const s = defaultFilterState();
    s.hiddenStatuses.add('archived');
    expect(matchesFilter(atom({ status: 'archived' }), s, noReferences)).toBe(false);
    expect(matchesFilter(atom({ status: 'active' }), s, noReferences)).toBe(true);
  });

  it('hides atoms whose classification is in hiddenClassifications', () => {
    const s = defaultFilterState();
    s.hiddenClassifications.add('SECRET');
    expect(matchesFilter(atom({ classification: 'SECRET' }), s, noReferences)).toBe(false);
    expect(matchesFilter(atom({ classification: 'TEAM' }), s, noReferences)).toBe(true);
  });
});

describe('matchesFilter — selectedTags', () => {
  it('empty selectedTags = no tag filter (all atoms pass)', () => {
    const s = defaultFilterState();
    expect(matchesFilter(atom({ tags: ['foo'] }), s, noReferences)).toBe(true);
    expect(matchesFilter(atom({ tags: [] }), s, noReferences)).toBe(true);
  });

  it('non-empty selectedTags = atom must have at least one matching tag', () => {
    const s = defaultFilterState();
    s.selectedTags.add('decision-2026');
    expect(matchesFilter(atom({ tags: ['decision-2026'] }), s, noReferences)).toBe(true);
    expect(matchesFilter(atom({ tags: ['other', 'decision-2026'] }), s, noReferences)).toBe(true);
    expect(matchesFilter(atom({ tags: ['unrelated'] }), s, noReferences)).toBe(false);
    expect(matchesFilter(atom({ tags: [] }), s, noReferences)).toBe(false);
  });
});

describe('matchesFilter — search', () => {
  it('empty search = no search filter', () => {
    const s = defaultFilterState();
    expect(matchesFilter(atom({ id: 'X', body: 'Y' }), s, noReferences)).toBe(true);
  });

  it('search matches atom id (case-insensitive substring)', () => {
    const s = defaultFilterState();
    s.search = 'fix04';
    expect(matchesFilter(atom({ id: 'PREF-2026-04-05-FIX04-aa04' }), s, noReferences)).toBe(true);
    expect(matchesFilter(atom({ id: 'OTHER-aa00' }), s, noReferences)).toBe(false);
  });

  it('search matches atom body', () => {
    const s = defaultFilterState();
    s.search = 'consensus';
    expect(matchesFilter(atom({ body: 'We reached consensus on...' }), s, noReferences)).toBe(true);
    expect(matchesFilter(atom({ body: 'unrelated body' }), s, noReferences)).toBe(false);
  });

  it('search matches atom tags', () => {
    const s = defaultFilterState();
    s.search = 'fixture';
    expect(matchesFilter(atom({ tags: ['fixture', 'belief'] }), s, noReferences)).toBe(true);
    expect(matchesFilter(atom({ tags: ['decision'] }), s, noReferences)).toBe(false);
  });
});

describe('matchesFilter — orphansOnly', () => {
  it('off: all atoms pass regardless of relations', () => {
    const s = defaultFilterState();
    expect(matchesFilter(atom({ relations: [] }), s, noReferences)).toBe(true);
    expect(matchesFilter(atom({ relations: [{ target: 'X', type: 'related' }] }), s, allReferenced)).toBe(true);
  });

  it('on: hides atoms with outbound relations', () => {
    const s = defaultFilterState();
    s.orphansOnly = true;
    const withRel = atom({ relations: [{ target: 'X', type: 'related' }] });
    expect(matchesFilter(withRel, s, noReferences)).toBe(false);
  });

  it('on: hides atoms that are referenced inbound', () => {
    const s = defaultFilterState();
    s.orphansOnly = true;
    const referenced = atom({ id: 'TARGET' });
    expect(matchesFilter(referenced, s, allReferenced)).toBe(false);
    expect(matchesFilter(referenced, s, noReferences)).toBe(true);
  });

  it('on: shows atoms with no outbound and no inbound', () => {
    const s = defaultFilterState();
    s.orphansOnly = true;
    expect(matchesFilter(atom({ relations: [] }), s, noReferences)).toBe(true);
  });
});

describe('matchesFilter — combinations', () => {
  it('AND-combines all dimensions; first failing dimension shortcircuits', () => {
    const s = defaultFilterState();
    s.search = 'foo';
    s.hiddenTypes.add('belief');
    s.hiddenStatuses.add('archived');
    expect(matchesFilter(atom({ type: 'fact', status: 'active', body: 'foo bar' }), s, noReferences)).toBe(true);
    expect(matchesFilter(atom({ type: 'belief', body: 'foo bar' }), s, noReferences)).toBe(false);
    expect(matchesFilter(atom({ type: 'fact', status: 'archived', body: 'foo bar' }), s, noReferences)).toBe(false);
    expect(matchesFilter(atom({ type: 'fact', body: 'no match' }), s, noReferences)).toBe(false);
  });
});

describe('serialize / deserialize', () => {
  it('round-trips through JSON', () => {
    const s: FilterState = defaultFilterState();
    s.search = 'foo';
    s.hiddenTypes.add('belief').add('fact');
    s.hiddenStatuses.add('archived');
    s.hiddenClassifications.add('SECRET');
    s.selectedTags.add('a').add('b');
    s.orphansOnly = true;
    const blob = serializeFilterState(s);
    const json = JSON.parse(JSON.stringify(blob)); // simulate save/load
    const back = deserializeFilterState(json);
    expect(back.search).toBe('foo');
    expect([...back.hiddenTypes].sort()).toEqual(['belief', 'fact']);
    expect([...back.hiddenStatuses]).toEqual(['archived']);
    expect([...back.hiddenClassifications]).toEqual(['SECRET']);
    expect([...back.selectedTags].sort()).toEqual(['a', 'b']);
    expect(back.orphansOnly).toBe(true);
  });

  it('deserializes a missing or partial blob to default state', () => {
    expect(deserializeFilterState(undefined)).toEqual(defaultFilterState());
    expect(deserializeFilterState(null)).toEqual(defaultFilterState());
    expect(deserializeFilterState({})).toEqual(defaultFilterState());
    const partial = deserializeFilterState({ search: 'x' });
    expect(partial.search).toBe('x');
    expect(partial.hiddenTypes.size).toBe(0);
  });
});
```

- [ ] **Step 2.2: Run tests to verify they fail**

```bash
cd packages/obsidian-mk-graph && npx vitest run test/filter-state.test.ts
```

Expected: FAIL with `Cannot find module '../src/filter-state.js'`.

- [ ] **Step 2.3: Write `packages/obsidian-mk-graph/src/filter-state.ts`**

```typescript
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
```

- [ ] **Step 2.4: Run tests to verify they pass**

```bash
cd packages/obsidian-mk-graph && npx vitest run test/filter-state.test.ts
```

Expected: PASS — 16 it() blocks across 6 describes.

- [ ] **Step 2.5: Commit**

```bash
git add packages/obsidian-mk-graph/src/filter-state.ts packages/obsidian-mk-graph/test/filter-state.test.ts
git commit -m "feat(obsidian-mk-graph): add filter-state module (predicate + persistence)"
```

---

## Task 3: `getAvailableTags()` and `getReferencedIds()` on `GraphState`

**Files:**
- Modify: `packages/obsidian-mk-graph/src/graph-state.ts`
- Modify: `packages/obsidian-mk-graph/test/graph-state.test.ts`

TDD: test → run (FAIL) → implement → run (PASS) → commit.

- [ ] **Step 3.1: Read current graph-state.ts and graph-state.test.ts**

```bash
cat packages/obsidian-mk-graph/src/graph-state.ts
cat packages/obsidian-mk-graph/test/graph-state.test.ts | head -40
```

`GraphState` already maintains `atoms: Map<string, ParsedAtom>` and an outbound-index. We're adding two read-only accessors.

- [ ] **Step 3.2: Append failing tests to `test/graph-state.test.ts`**

Inside the existing `describe('GraphState', ...)` block (or as a sibling describe at the bottom of the file), add:

```typescript
describe('GraphState — filter-panel helpers', () => {
  it('getAvailableTags returns the sorted unique tag set across all atoms', () => {
    const s = new GraphState();
    s.replace([
      { ...sampleAtom('A'), tags: ['fixture', 'fact'] },
      { ...sampleAtom('B'), tags: ['fixture', 'belief'] },
      { ...sampleAtom('C'), tags: [] },
      { ...sampleAtom('D'), tags: ['fact'] },
    ]);
    expect(s.getAvailableTags()).toEqual(['belief', 'fact', 'fixture']);
  });

  it('getAvailableTags returns [] when the state has no atoms', () => {
    const s = new GraphState();
    expect(s.getAvailableTags()).toEqual([]);
  });

  it('getReferencedIds returns the set of atom ids that any other atom links to', () => {
    const s = new GraphState();
    s.replace([
      { ...sampleAtom('A'), relations: [{ target: 'B', type: 'related' }] },
      { ...sampleAtom('B'), relations: [{ target: 'C', type: 'extends' }] },
      { ...sampleAtom('C'), relations: [] },
      { ...sampleAtom('D'), relations: [] }, // truly orphan
    ]);
    const ref = s.getReferencedIds();
    expect(ref.has('B')).toBe(true);
    expect(ref.has('C')).toBe(true);
    expect(ref.has('A')).toBe(false);
    expect(ref.has('D')).toBe(false);
  });
});
```

If `sampleAtom` doesn't already exist in the test file, define a small helper at the top:

```typescript
const sampleAtom = (id: string): ParsedAtom => ({
  id,
  type: 'fact',
  status: 'active',
  classification: 'TEAM',
  confidence: 1,
  createdAt: '2026-04-01T10:00:00Z',
  updatedAt: '2026-04-01T10:00:00Z',
  ttlDays: null,
  tags: [],
  relations: [],
  body: '',
});
```

(Re-use existing sample helper if one is already present — check the file first to avoid duplication.)

- [ ] **Step 3.3: Run tests to verify they fail**

```bash
cd packages/obsidian-mk-graph && npx vitest run test/graph-state.test.ts
```

Expected: FAIL with `getAvailableTags is not a function` (or similar).

- [ ] **Step 3.4: Add the two methods to `GraphState`**

In `packages/obsidian-mk-graph/src/graph-state.ts`, find the existing `toGraphData()` method (the last method on the class) and append two new methods after it:

```typescript
  /** Sorted unique set of tags across all loaded atoms. Used by the
   *  filter panel to populate tag chips. Empty array when there are no
   *  atoms or no atoms have tags. */
  getAvailableTags(): string[] {
    const tags = new Set<string>();
    for (const a of this.atoms.values()) {
      for (const t of a.tags) tags.add(t);
    }
    return [...tags].sort();
  }

  /** Set of atom ids that are referenced as relation targets by some
   *  other atom. Used by the filter panel's "orphans only" mode to
   *  detect atoms with zero inbound references. O(total relations). */
  getReferencedIds(): Set<string> {
    const refs = new Set<string>();
    for (const rels of this.outboundIndex.values()) {
      for (const r of rels) refs.add(r.target);
    }
    return refs;
  }
```

- [ ] **Step 3.5: Run tests to verify they pass**

```bash
cd packages/obsidian-mk-graph && npx vitest run test/graph-state.test.ts
```

Expected: PASS — original tests + the 3 new ones.

- [ ] **Step 3.6: Commit**

```bash
git add packages/obsidian-mk-graph/src/graph-state.ts packages/obsidian-mk-graph/test/graph-state.test.ts
git commit -m "feat(obsidian-mk-graph): add getAvailableTags + getReferencedIds to GraphState"
```

---

## Task 4: Settings additions for filter panel

**Files:**
- Modify: `packages/obsidian-mk-graph/src/settings.ts`

The plugin's settings already persist `showLegend`, `showScrubber`, etc. Add two new fields: `showFilterPanel: boolean` and `filters: SerializedFilterState`. Defaults make the panel visible with no filters applied (everything shown).

- [ ] **Step 4.1: Read the current `MkGraphSettings` interface**

```bash
sed -n '20,55p' packages/obsidian-mk-graph/src/settings.ts
```

- [ ] **Step 4.2: Add the new fields to `MkGraphSettings`**

In `packages/obsidian-mk-graph/src/settings.ts`, find the `MkGraphSettings` interface and append (before the closing brace) the two new fields:

```typescript
  /** Show the filter side overlay (atom-type / status / classification
   *  toggles, search, tags, orphans). Default true. */
  showFilterPanel: boolean;
  /** Persisted filter state. JSON-friendly shape (Sets serialised as
   *  arrays). Empty / missing → default state matches every atom. */
  filters: SerializedFilterState;
```

Add the import at the top of the file:

```typescript
import type { SerializedFilterState } from './filter-state.js';
```

- [ ] **Step 4.3: Update `DEFAULT_SETTINGS`**

Append the two new defaults inside the `DEFAULT_SETTINGS` object literal:

```typescript
  showFilterPanel: true,
  filters: {
    search: '',
    hiddenTypes: [],
    hiddenStatuses: [],
    hiddenClassifications: [],
    selectedTags: [],
    orphansOnly: false,
  },
```

- [ ] **Step 4.4: Add a settings-tab toggle for `showFilterPanel`**

Find the existing `showLegend` toggle in `MkGraphSettingTab.display()` and append after its closing block:

```typescript
new Setting(containerEl)
  .setName('Show filter panel')
  .setDesc('Display the side overlay with atom-type / status / classification toggles, search, tag chips, and orphans-only filter.')
  .addToggle((t) =>
    t.setValue(this.host.settings.showFilterPanel).onChange(async (v) => {
      this.host.settings.showFilterPanel = v;
      await this.safeSave();
    }),
  );
```

- [ ] **Step 4.5: Type-check + run the full test suite**

```bash
cd packages/obsidian-mk-graph && npx tsc --noEmit 2>&1 | grep -E "settings.ts" | head -5
cd packages/obsidian-mk-graph && npm test
```

Expected: 0 new errors in `settings.ts`; full test suite passes.

- [ ] **Step 4.6: Commit**

```bash
git add packages/obsidian-mk-graph/src/settings.ts
git commit -m "feat(obsidian-mk-graph): add showFilterPanel + filters to settings"
```

---

## Task 5: `filter-panel.ts` — DOM panel

**Files:**
- Create: `packages/obsidian-mk-graph/src/filter-panel.ts`
- Create: `packages/obsidian-mk-graph/test/filter-panel.dom.test.ts`

TDD: test → run (FAIL) → implement → run (PASS) → commit. The DOM test runs under jsdom (the `*.dom.test.ts` glob is already configured in `vitest.config.ts`).

- [ ] **Step 5.1: Write the failing tests**

Create `packages/obsidian-mk-graph/test/filter-panel.dom.test.ts`:

```typescript
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createFilterPanel } from '../src/filter-panel.js';
import { defaultFilterState } from '../src/filter-state.js';

describe('createFilterPanel', () => {
  it('renders search + type / status / classification sections + orphans toggle', () => {
    const root = document.createElement('div');
    const onChange = vi.fn();
    const p = createFilterPanel(root, {
      initialState: defaultFilterState(),
      availableTags: [],
      onChange,
    });
    expect(root.querySelector('.mk-graph-filter-panel')).not.toBeNull();
    expect(root.querySelector<HTMLInputElement>('.mk-graph-filter-search')).not.toBeNull();
    // 9 type checkboxes
    expect(root.querySelectorAll('.mk-graph-filter-type-cb').length).toBe(9);
    // 8 status checkboxes
    expect(root.querySelectorAll('.mk-graph-filter-status-cb').length).toBe(8);
    // 4 classification checkboxes
    expect(root.querySelectorAll('.mk-graph-filter-classification-cb').length).toBe(4);
    // orphans toggle
    expect(root.querySelector<HTMLInputElement>('.mk-graph-filter-orphans-cb')).not.toBeNull();
    p.destroy();
  });

  it('fires onChange when a type checkbox is toggled', () => {
    const root = document.createElement('div');
    const onChange = vi.fn();
    const p = createFilterPanel(root, {
      initialState: defaultFilterState(),
      availableTags: [],
      onChange,
    });
    const factCb = root.querySelector<HTMLInputElement>('.mk-graph-filter-type-cb[data-value="fact"]')!;
    expect(factCb.checked).toBe(true);
    factCb.checked = false;
    factCb.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onChange).toHaveBeenCalledOnce();
    const emitted = onChange.mock.calls[0][0];
    expect(emitted.hiddenTypes.has('fact')).toBe(true);
    p.destroy();
  });

  it('fires onChange when the search input changes', () => {
    const root = document.createElement('div');
    const onChange = vi.fn();
    const p = createFilterPanel(root, {
      initialState: defaultFilterState(),
      availableTags: [],
      onChange,
    });
    const search = root.querySelector<HTMLInputElement>('.mk-graph-filter-search')!;
    search.value = 'consensus';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0][0].search).toBe('consensus');
    p.destroy();
  });

  it('fires onChange when orphans toggle is clicked', () => {
    const root = document.createElement('div');
    const onChange = vi.fn();
    const p = createFilterPanel(root, {
      initialState: defaultFilterState(),
      availableTags: [],
      onChange,
    });
    const cb = root.querySelector<HTMLInputElement>('.mk-graph-filter-orphans-cb')!;
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0][0].orphansOnly).toBe(true);
    p.destroy();
  });

  it('renders tag chips from availableTags and toggles selection', () => {
    const root = document.createElement('div');
    const onChange = vi.fn();
    const p = createFilterPanel(root, {
      initialState: defaultFilterState(),
      availableTags: ['fixture', 'belief', 'fact'],
      onChange,
    });
    const chips = root.querySelectorAll('.mk-graph-filter-tag-chip');
    expect(chips.length).toBe(3);
    const fixtureChip = root.querySelector<HTMLElement>('.mk-graph-filter-tag-chip[data-tag="fixture"]')!;
    fixtureChip.click();
    expect(onChange).toHaveBeenCalledOnce();
    const emitted = onChange.mock.calls[0][0];
    expect(emitted.selectedTags.has('fixture')).toBe(true);
    p.destroy();
  });

  it('setAvailableTags re-renders chips when the loaded tag set changes', () => {
    const root = document.createElement('div');
    const p = createFilterPanel(root, {
      initialState: defaultFilterState(),
      availableTags: ['a', 'b'],
      onChange: () => {},
    });
    expect(root.querySelectorAll('.mk-graph-filter-tag-chip').length).toBe(2);
    p.setAvailableTags(['x', 'y', 'z']);
    expect(root.querySelectorAll('.mk-graph-filter-tag-chip').length).toBe(3);
    p.destroy();
  });

  it('setVisible toggles the panel display', () => {
    const root = document.createElement('div');
    const p = createFilterPanel(root, {
      initialState: defaultFilterState(),
      availableTags: [],
      onChange: () => {},
    });
    const panel = root.querySelector<HTMLElement>('.mk-graph-filter-panel')!;
    expect(panel.classList.contains('is-hidden')).toBe(false);
    p.setVisible(false);
    expect(panel.classList.contains('is-hidden')).toBe(true);
    p.setVisible(true);
    expect(panel.classList.contains('is-hidden')).toBe(false);
    p.destroy();
  });

  it('destroy removes the panel from the parent', () => {
    const root = document.createElement('div');
    const p = createFilterPanel(root, {
      initialState: defaultFilterState(),
      availableTags: [],
      onChange: () => {},
    });
    expect(root.children.length).toBeGreaterThan(0);
    p.destroy();
    expect(root.children.length).toBe(0);
  });
});
```

- [ ] **Step 5.2: Run tests to verify they fail**

```bash
cd packages/obsidian-mk-graph && npx vitest run test/filter-panel.dom.test.ts
```

Expected: FAIL with "Cannot find module '../src/filter-panel.js'".

- [ ] **Step 5.3: Write `packages/obsidian-mk-graph/src/filter-panel.ts`**

```typescript
import { ATOM_TYPE_ORDER, ATOM_STATUS_ORDER, ATOM_CLASSIFICATION_ORDER } from './atom-types.js';
import type { FilterState } from './filter-state.js';

export interface FilterPanelOptions {
  initialState: FilterState;
  availableTags: string[];
  onChange: (state: FilterState) => void;
}

export interface FilterPanelHandle {
  setState(state: FilterState): void;
  setAvailableTags(tags: string[]): void;
  setVisible(visible: boolean): void;
  destroy(): void;
}

/**
 * Mount the filter panel into `parent`. Returns a handle for the view
 * to drive panel state from outside (e.g. when filter state is mutated
 * by a different code path, or when the available tags change after a
 * vault reload).
 *
 * Layout produced:
 *   <div class="mk-graph-filter-panel">
 *     <div class="mk-graph-filter-header">Filters</div>
 *     <input class="mk-graph-filter-search" type="search" placeholder="Search atoms…" />
 *     <section> Types        — 9 checkboxes
 *     <section> Status       — 8 checkboxes
 *     <section> Classification — 4 checkboxes
 *     <section> Tags         — chips (selectable)
 *     <section> Other        — orphans toggle
 *
 * The panel is a pure DOM component — it owns its own state copy
 * internally, fires `onChange(state)` after every interaction, and
 * accepts external state updates via `setState()`. The view reconciles
 * its single source of truth with this internal copy through the
 * onChange callback.
 */
export function createFilterPanel(parent: HTMLElement, opts: FilterPanelOptions): FilterPanelHandle {
  const doc = parent.ownerDocument;

  // Internal state: cloned from initialState so external mutations don't leak.
  let state: FilterState = cloneState(opts.initialState);
  let tags: string[] = [...opts.availableTags];

  const root = doc.createElement('div');
  root.classList.add('mk-graph-filter-panel');

  // Header
  const header = doc.createElement('div');
  header.classList.add('mk-graph-filter-header');
  header.textContent = 'Filters';
  root.appendChild(header);

  // Search
  const search = doc.createElement('input');
  search.type = 'search';
  search.classList.add('mk-graph-filter-search');
  search.placeholder = 'Search atoms…';
  search.value = state.search;
  search.addEventListener('input', () => {
    state = { ...state, search: search.value };
    opts.onChange(state);
  });
  root.appendChild(search);

  // Type checkboxes
  const typeSection = makeSection(doc, 'Types');
  for (const t of ATOM_TYPE_ORDER) {
    typeSection.body.appendChild(makeCheckbox(doc, {
      cls: 'mk-graph-filter-type-cb',
      value: t,
      label: t,
      checked: !state.hiddenTypes.has(t),
      onChange: (checked) => {
        const next = new Set(state.hiddenTypes);
        if (checked) next.delete(t); else next.add(t);
        state = { ...state, hiddenTypes: next };
        opts.onChange(state);
      },
    }));
  }
  root.appendChild(typeSection.root);

  // Status checkboxes
  const statusSection = makeSection(doc, 'Status');
  for (const s of ATOM_STATUS_ORDER) {
    statusSection.body.appendChild(makeCheckbox(doc, {
      cls: 'mk-graph-filter-status-cb',
      value: s,
      label: s,
      checked: !state.hiddenStatuses.has(s),
      onChange: (checked) => {
        const next = new Set(state.hiddenStatuses);
        if (checked) next.delete(s); else next.add(s);
        state = { ...state, hiddenStatuses: next };
        opts.onChange(state);
      },
    }));
  }
  root.appendChild(statusSection.root);

  // Classification checkboxes
  const classificationSection = makeSection(doc, 'Classification');
  for (const c of ATOM_CLASSIFICATION_ORDER) {
    classificationSection.body.appendChild(makeCheckbox(doc, {
      cls: 'mk-graph-filter-classification-cb',
      value: c,
      label: c,
      checked: !state.hiddenClassifications.has(c),
      onChange: (checked) => {
        const next = new Set(state.hiddenClassifications);
        if (checked) next.delete(c); else next.add(c);
        state = { ...state, hiddenClassifications: next };
        opts.onChange(state);
      },
    }));
  }
  root.appendChild(classificationSection.root);

  // Tags
  const tagsSection = makeSection(doc, 'Tags');
  const tagsBody = tagsSection.body;
  function renderTagChips(): void {
    tagsBody.replaceChildren();
    if (tags.length === 0) {
      const empty = doc.createElement('div');
      empty.classList.add('mk-graph-filter-tags-empty');
      empty.textContent = '(no tags)';
      tagsBody.appendChild(empty);
      return;
    }
    for (const t of tags) {
      const chip = doc.createElement('span');
      chip.classList.add('mk-graph-filter-tag-chip');
      chip.dataset.tag = t;
      chip.textContent = t;
      if (state.selectedTags.has(t)) chip.classList.add('is-active');
      chip.addEventListener('click', () => {
        const next = new Set(state.selectedTags);
        if (next.has(t)) next.delete(t); else next.add(t);
        state = { ...state, selectedTags: next };
        chip.classList.toggle('is-active', next.has(t));
        opts.onChange(state);
      });
      tagsBody.appendChild(chip);
    }
  }
  renderTagChips();
  root.appendChild(tagsSection.root);

  // Orphans toggle
  const otherSection = makeSection(doc, 'Other');
  otherSection.body.appendChild(makeCheckbox(doc, {
    cls: 'mk-graph-filter-orphans-cb',
    value: 'orphans',
    label: 'Orphans only',
    checked: state.orphansOnly,
    onChange: (checked) => {
      state = { ...state, orphansOnly: checked };
      opts.onChange(state);
    },
  }));
  root.appendChild(otherSection.root);

  parent.appendChild(root);

  function setState(newState: FilterState): void {
    state = cloneState(newState);
    search.value = state.search;
    syncCheckboxes(root, '.mk-graph-filter-type-cb', (cb) => !state.hiddenTypes.has(cb.dataset.value ?? ''));
    syncCheckboxes(root, '.mk-graph-filter-status-cb', (cb) => !state.hiddenStatuses.has(cb.dataset.value ?? ''));
    syncCheckboxes(root, '.mk-graph-filter-classification-cb', (cb) => !state.hiddenClassifications.has(cb.dataset.value ?? ''));
    const orphansCb = root.querySelector<HTMLInputElement>('.mk-graph-filter-orphans-cb');
    if (orphansCb) orphansCb.checked = state.orphansOnly;
    renderTagChips();
  }

  function setAvailableTags(newTags: string[]): void {
    tags = [...newTags];
    renderTagChips();
  }

  function setVisible(visible: boolean): void {
    root.classList.toggle('is-hidden', !visible);
  }

  function destroy(): void {
    if (root.parentNode === parent) parent.removeChild(root);
  }

  return { setState, setAvailableTags, setVisible, destroy };
}

// --- private helpers ---

function cloneState(s: FilterState): FilterState {
  return {
    search: s.search,
    hiddenTypes: new Set(s.hiddenTypes),
    hiddenStatuses: new Set(s.hiddenStatuses),
    hiddenClassifications: new Set(s.hiddenClassifications),
    selectedTags: new Set(s.selectedTags),
    orphansOnly: s.orphansOnly,
  };
}

function makeSection(doc: Document, title: string): { root: HTMLElement; body: HTMLElement } {
  const root = doc.createElement('section');
  root.classList.add('mk-graph-filter-section');
  const heading = doc.createElement('div');
  heading.classList.add('mk-graph-filter-section-heading');
  heading.textContent = title;
  root.appendChild(heading);
  const body = doc.createElement('div');
  body.classList.add('mk-graph-filter-section-body');
  root.appendChild(body);
  return { root, body };
}

interface CheckboxOpts {
  cls: string;
  value: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

function makeCheckbox(doc: Document, opts: CheckboxOpts): HTMLLabelElement {
  const label = doc.createElement('label');
  label.classList.add('mk-graph-filter-cb-label');
  const cb = doc.createElement('input');
  cb.type = 'checkbox';
  cb.classList.add(opts.cls);
  cb.dataset.value = opts.value;
  cb.checked = opts.checked;
  cb.addEventListener('change', () => opts.onChange(cb.checked));
  label.appendChild(cb);
  const text = doc.createElement('span');
  text.classList.add('mk-graph-filter-cb-text');
  text.textContent = opts.label;
  label.appendChild(text);
  return label;
}

function syncCheckboxes(root: HTMLElement, selector: string, isChecked: (cb: HTMLInputElement) => boolean): void {
  for (const cb of root.querySelectorAll<HTMLInputElement>(selector)) {
    cb.checked = isChecked(cb);
  }
}
```

- [ ] **Step 5.4: Run tests to verify they pass**

```bash
cd packages/obsidian-mk-graph && npx vitest run test/filter-panel.dom.test.ts
```

Expected: PASS — 8 it() blocks.

- [ ] **Step 5.5: Commit**

```bash
git add packages/obsidian-mk-graph/src/filter-panel.ts packages/obsidian-mk-graph/test/filter-panel.dom.test.ts
git commit -m "feat(obsidian-mk-graph): add filter-panel DOM component"
```

---

## Task 6: Filter panel CSS

**Files:**
- Modify: `packages/obsidian-mk-graph/styles.css`

Append the filter panel styles at the end of the existing CSS. Match the v0.2.5 scrubber's polish (vertical gradient background, accent-color affordances, smooth transitions).

- [ ] **Step 6.1: Append filter-panel styles to `styles.css`**

```css

/* --- Phase 4 / v0.3.0: filter panel (right-side overlay) --- */

.mk-graph-filter-panel {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 240px;
  max-height: calc(100% - 160px); /* leave room for scrubber at bottom */
  overflow-y: auto;
  padding: 12px;
  background: linear-gradient(
    180deg,
    var(--background-primary, rgba(18, 18, 22, 0.92)) 0%,
    var(--background-primary-alt, rgba(24, 24, 28, 0.92)) 100%
  );
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  border: 1px solid var(--background-modifier-border, rgba(255, 255, 255, 0.08));
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-normal, #ddd);
  pointer-events: auto;
  z-index: 50;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
}

.mk-graph-filter-panel.is-hidden {
  display: none;
}

.mk-graph-filter-header {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
  color: var(--text-normal, #ddd);
  letter-spacing: 0.02em;
}

.mk-graph-filter-search {
  width: 100%;
  margin-bottom: 12px;
  padding: 4px 8px;
  border: 1px solid var(--background-modifier-border, rgba(255, 255, 255, 0.14));
  background: var(--background-primary, #1b1d22);
  color: var(--text-normal, #ddd);
  border-radius: 4px;
  font-size: 12px;
  box-sizing: border-box;
}

.mk-graph-filter-search:focus {
  outline: 2px solid var(--interactive-accent, #3b82f6);
  outline-offset: 1px;
}

.mk-graph-filter-section {
  margin-bottom: 10px;
}

.mk-graph-filter-section-heading {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted, #aaa);
  margin-bottom: 4px;
  padding-bottom: 2px;
  border-bottom: 1px solid var(--background-modifier-border, rgba(255, 255, 255, 0.08));
}

.mk-graph-filter-section-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mk-graph-filter-cb-label {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
  padding: 1px 0;
}

.mk-graph-filter-cb-label input[type="checkbox"] {
  margin: 0;
  cursor: pointer;
  width: 12px;
  height: 12px;
}

.mk-graph-filter-cb-text {
  font-size: 11px;
  line-height: 1.4;
}

/* Tag chips */

.mk-graph-filter-section-body:has(.mk-graph-filter-tag-chip) {
  flex-direction: row;
  flex-wrap: wrap;
  gap: 4px;
}

.mk-graph-filter-tag-chip {
  display: inline-block;
  padding: 2px 8px;
  border: 1px solid var(--background-modifier-border, rgba(255, 255, 255, 0.14));
  background: transparent;
  color: var(--text-muted, #aaa);
  border-radius: 999px;
  font-size: 10px;
  cursor: pointer;
  user-select: none;
  transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease;
}

.mk-graph-filter-tag-chip:hover {
  background: var(--background-modifier-hover, rgba(255, 255, 255, 0.06));
  color: var(--text-normal, #ddd);
}

.mk-graph-filter-tag-chip.is-active {
  background: var(--interactive-accent, #3b82f6);
  color: var(--text-on-accent, #fff);
  border-color: transparent;
}

.mk-graph-filter-tags-empty {
  font-size: 10px;
  color: var(--text-faint, rgba(255, 255, 255, 0.35));
  font-style: italic;
}
```

- [ ] **Step 6.2: Commit**

```bash
git add packages/obsidian-mk-graph/styles.css
git commit -m "style(obsidian-mk-graph): add filter panel styles"
```

---

## Task 7: Wire the filter panel into the view

**Files:**
- Modify: `packages/obsidian-mk-graph/src/view.ts`

This is the integration step. The view:
1. Owns one `FilterState` instance (sourced from `settings.filters`).
2. Mounts the `createFilterPanel` into the body-attached overlay layer (where legend + tooltip already live).
3. Wraps the controller's `onState` callback so `state.atoms` is filtered before `state.replace()`.
4. Persists state changes back to `settings.filters` on every `onChange`.
5. Cleans up the panel in `onClose()`.

- [ ] **Step 7.1: Read the relevant chunks of view.ts**

```bash
sed -n '1,30p' packages/obsidian-mk-graph/src/view.ts          # imports + class fields
sed -n '60,110p' packages/obsidian-mk-graph/src/view.ts        # onOpen
sed -n '105,150p' packages/obsidian-mk-graph/src/view.ts       # onClose + reloadFromDisk
```

Note the existing `controller.onState` callback shape and the spot where `state.replace(s.atoms)` is called.

- [ ] **Step 7.2: Add imports + new private fields**

In `packages/obsidian-mk-graph/src/view.ts`, add to the existing imports:

```typescript
import { createFilterPanel, type FilterPanelHandle } from './filter-panel.js';
import {
  defaultFilterState,
  matchesFilter,
  serializeFilterState,
  deserializeFilterState,
  type FilterState,
} from './filter-state.js';
```

Add to the class private fields (alongside `state`, `renderer`, `watcher`, `eventsWatcher`, `scrubber`, `controller`, `events`):

```typescript
  private filterPanel: FilterPanelHandle | null = null;
  private filterState: FilterState = defaultFilterState();
```

- [ ] **Step 7.3: Initialize `filterState` from settings + mount the panel inside `onOpen`**

Inside `onOpen()`, BEFORE the existing `this.controller = new ReplayController({ ... })` call, deserialize the filter state from settings:

```typescript
    this.filterState = deserializeFilterState(this.host.settings.filters);
```

Inside the existing `onState` controller callback, **wrap the atoms** before passing them to `state.replace`. Replace:

```typescript
      onState: (s) => {
        this.state.replace(s.atoms);
        this.renderer?.setDiff(s.diff);
        if (this.scrubber && s.asOf) this.scrubber.setPlayhead(s.asOf);
      },
```

with:

```typescript
      onState: (s) => {
        const referenced = this.computeReferencedSet(s.atoms);
        const filtered = s.atoms.filter((a) => matchesFilter(a, this.filterState, (id) => referenced.has(id)));
        this.state.replace(filtered);
        this.renderer?.setDiff(s.diff);
        if (this.scrubber && s.asOf) this.scrubber.setPlayhead(s.asOf);
        // Refresh tag chips after a load — the available tag set might
        // have changed.
        this.filterPanel?.setAvailableTags(this.collectTags(s.atoms));
      },
```

After the `if (this.host.settings.showScrubber) { ... }` block (where the scrubber is mounted into the container), mount the filter panel into the body-attached overlay layer that the renderer already creates:

```typescript
    // Mount the filter panel inside the renderer's body-attached overlay
    // layer so it's positioned in screen space and not clobbered by
    // force-graph (same trick as the legend / tooltip — see renderer.ts).
    const overlayLayer = doc.body.querySelector<HTMLElement>('.mk-graph-overlay-layer');
    if (overlayLayer) {
      this.filterPanel = createFilterPanel(overlayLayer, {
        initialState: this.filterState,
        availableTags: [],
        onChange: (s) => this.handleFilterChange(s),
      });
      this.filterPanel.setVisible(this.host.settings.showFilterPanel);
    }
```

(`doc` is the renderer's owner document — add `const doc = container.ownerDocument;` at the top of `onOpen` if it's not already there.)

- [ ] **Step 7.4: Add the helper methods to the class**

Add these private methods anywhere on the `MkGraphView` class (e.g., before `resolveMemoryDirAbsolute`):

```typescript
  /** Computes the set of atom ids referenced (as relation targets) by
   *  any other atom in the supplied list. Used by the orphans filter. */
  private computeReferencedSet(atoms: ParsedAtom[]): Set<string> {
    const ref = new Set<string>();
    for (const a of atoms) {
      for (const r of a.relations) ref.add(r.target);
    }
    return ref;
  }

  /** Sorted unique tag set across the supplied atoms — used to populate
   *  the filter panel's tag chips. */
  private collectTags(atoms: ParsedAtom[]): string[] {
    const set = new Set<string>();
    for (const a of atoms) for (const t of a.tags) set.add(t);
    return [...set].sort();
  }

  /** Filter-panel onChange callback. Stores the new state, persists it,
   *  and triggers a re-emit so the graph re-renders with the new filter
   *  applied without waiting for the next file change. */
  private handleFilterChange(newState: FilterState): void {
    this.filterState = newState;
    this.host.settings.filters = serializeFilterState(newState);
    void this.host.saveSettings();
    // Re-emit the controller's current state so the renderer picks up
    // the new filter on the next animation frame. Cheap because the
    // replay engine memoises and the controller has no I/O.
    if (this.controller) {
      const current = this.controller.current();
      const referenced = this.computeReferencedSet(current.atoms);
      const filtered = current.atoms.filter((a) =>
        matchesFilter(a, this.filterState, (id) => referenced.has(id)),
      );
      this.state.replace(filtered);
      this.renderer?.setDiff(current.diff);
    }
  }
```

- [ ] **Step 7.5: Clean up the panel in `onClose`**

In the existing `onClose` method, add the panel cleanup alongside the others:

```typescript
    if (this.filterPanel) { this.filterPanel.destroy(); this.filterPanel = null; }
```

- [ ] **Step 7.6: Type-check and run tests**

```bash
cd packages/obsidian-mk-graph && npx tsc --noEmit 2>&1 | grep -E "view.ts" | head -10
cd packages/obsidian-mk-graph && npm test
```

Expected: 0 NEW errors in `view.ts`; full test suite passes (the smoke walks for the panel are manual; the unit tests for `filter-state.ts` and `filter-panel.ts` cover the panel itself).

- [ ] **Step 7.7: Commit**

```bash
git add packages/obsidian-mk-graph/src/view.ts
git commit -m "feat(obsidian-mk-graph): wire filter panel into view (filter atoms before render)"
```

---

## Task 8: "Toggle filter panel" command in `main.ts`

**Files:**
- Modify: `packages/obsidian-mk-graph/src/main.ts`

A command-palette entry to toggle the filter panel — handy for users who want a keybind, and for hiding the panel temporarily without flipping the setting toggle.

- [ ] **Step 8.1: Read the existing command registrations**

```bash
sed -n '1,80p' packages/obsidian-mk-graph/src/main.ts
```

You'll see existing commands like "Open Memory Kernel Graph", "Reload …", "Toggle Live / Scrubbed mode". Add the new command before the `addSettingTab` call.

- [ ] **Step 8.2: Add the toggle-filter-panel command**

Inside `MkGraphPlugin.onload()`, append (after the existing `mk-graph-toggle-live-scrubbed` command, before `this.addSettingTab(...)`):

```typescript
this.addCommand({
  id: 'mk-graph-toggle-filter-panel',
  name: 'Toggle filter panel',
  checkCallback: (checking) => {
    const view = this.getActiveGraphView();
    if (!view) return false;
    if (!checking) {
      this.settings.showFilterPanel = !this.settings.showFilterPanel;
      view.setFilterPanelVisible(this.settings.showFilterPanel);
      void this.saveSettings();
    }
    return true;
  },
});
```

- [ ] **Step 8.3: Add the public `setFilterPanelVisible` method on `MkGraphView`**

In `view.ts`, alongside `toggleLiveScrubbed` (also public, also command-invoked), add:

```typescript
  /** Public — invoked by the "Toggle filter panel" command. */
  setFilterPanelVisible(visible: boolean): void {
    this.filterPanel?.setVisible(visible);
  }
```

- [ ] **Step 8.4: Type-check + tests**

```bash
cd packages/obsidian-mk-graph && npx tsc --noEmit 2>&1 | grep -E "main.ts|view.ts" | head -5
cd packages/obsidian-mk-graph && npm test
```

Expected: 0 NEW errors; full test suite passes.

- [ ] **Step 8.5: Commit**

```bash
git add packages/obsidian-mk-graph/src/main.ts packages/obsidian-mk-graph/src/view.ts
git commit -m "feat(obsidian-mk-graph): add 'Toggle filter panel' command"
```

---

## Task 9: SMOKE_TEST update

**Files:**
- Modify: `packages/obsidian-mk-graph/SMOKE_TEST.md`

Add a single S15 walk for the filter panel.

- [ ] **Step 9.1: Read the SMOKE_TEST.md tail**

```bash
tail -30 packages/obsidian-mk-graph/SMOKE_TEST.md
```

The file ends with the v0.2.0 Phase 3 walks (S5–S9). Append S15 at the very end of the file.

- [ ] **Step 9.2: Append the S15 walk**

```markdown

### S15: filter panel — types / status / classification / search / tags / orphans (v0.3.0)

1. Build & install the plugin: `npm run build` in `<repo>/packages/obsidian-mk-graph/`. Hard-reload Obsidian (`Cmd+Shift+R` / `Ctrl+Shift+R`).
2. Open the Memory Kernel Graph view. Confirm a side overlay panel appears in the top-right, with sections: search input, **Types** (9 checkboxes), **Status** (8 checkboxes), **Classification** (4 checkboxes), **Tags** (chips), **Other** (orphans toggle).
3. Uncheck **belief** under Types. **Expect:** all blue (belief) atoms disappear from the graph immediately. Re-check it; they reappear.
4. Uncheck **archived** under Status. **Expect:** atoms with `status: archived` (the dimmest, around 0.2 opacity) disappear.
5. Uncheck **PUBLIC** under Classification. **Expect:** atoms with green-bordered nodes disappear.
6. Type `consensus` in the search input. **Expect:** only atoms whose id, body, or tags contain "consensus" remain.
7. Click the **fixture** chip under Tags. **Expect:** only atoms tagged `fixture` remain visible.
8. Click **fixture** again to deselect. **Expect:** all atoms come back.
9. Toggle **Orphans only** under Other. **Expect:** the graph empties unless you have an atom with no relations and not referenced — for the seed fixture this should result in 0–1 atoms visible.
10. Close Obsidian (`Cmd+Q`), reopen it. **Expect:** the filter state from step 6 (search "consensus") is restored — search box still contains the text and the graph reflects it.
11. Open command palette (`Cmd+P` / `Ctrl+P`), type "Toggle filter panel". **Expect:** the panel hides; running the command again shows it.
12. **Pass criteria:** every step above behaves as described, no console errors in DevTools, no atoms leak into the graph that shouldn't be visible per the active filters.
```

- [ ] **Step 9.3: Commit**

```bash
git add packages/obsidian-mk-graph/SMOKE_TEST.md
git commit -m "docs(obsidian-mk-graph): add S15 smoke walk for v0.3.0 filter panel"
```

---

## Task 10: Version bump + CHANGELOG + final verification

**Files:**
- Modify: `packages/obsidian-mk-graph/manifest.json`
- Modify: `packages/obsidian-mk-graph/package.json`
- Modify: `packages/obsidian-mk-graph/package-lock.json`
- Modify: `packages/obsidian-mk-graph/CHANGELOG.md`

- [ ] **Step 10.1: Bump version**

In `packages/obsidian-mk-graph/manifest.json`, change `"version": "0.2.11"` → `"version": "0.3.0"`.

In `packages/obsidian-mk-graph/package.json`, change `"version": "0.2.11"` → `"version": "0.3.0"`.

- [ ] **Step 10.2: Regenerate package-lock**

```bash
cd packages/obsidian-mk-graph && npm install --package-lock-only
```

- [ ] **Step 10.3: Prepend CHANGELOG section**

Insert this at the top of `packages/obsidian-mk-graph/CHANGELOG.md`, BETWEEN the "This file is independent…" preamble paragraph and the existing `## [0.2.11]` entry:

```markdown

## [0.3.0] — 2026-05-04

### Added — Filter & display panel
A side overlay (top-right of the graph view) lets you filter the rendered graph in real time without touching the underlying memory dir. Mirrors the spirit of Obsidian's native graph filter panel but specialized for the mk taxonomy.

**Sections:**
- **Search** — case-insensitive substring matched against atom id, body, and tags.
- **Types** — checkboxes for the 9 mk atom types (`fact`, `belief`, `decision`, `preference`, `constraint`, `procedure`, `entity_summary`, `open_question`, `conflict`). Uncheck to hide.
- **Status** — checkboxes for the 8 statuses (`active`, `accepted`, `draft`, `rejected`, `superseded`, `resolved`, `archived`, `expired`).
- **Classification** — checkboxes for `PUBLIC` / `TEAM` / `PERSONAL` / `SECRET`.
- **Tags** — chips for every tag present in the loaded vault. Click to add to the focus set; non-empty focus set means an atom must have at least one of these tags.
- **Other** — `Orphans only` toggle (atoms with zero outbound relations AND zero inbound references).

**Behavior:**
- Filters AND-combine across dimensions; first failing dimension short-circuits.
- Filtering happens in `view.onState` BEFORE `state.replace()`, so the renderer, scrubber, legend, and replay controller never see filtered-out atoms — keeps existing tests untouched.
- State persists in `settings.filters` (Sets serialised as arrays). Closing and reopening Obsidian restores all filter selections + the search query.
- Available tag chips refresh automatically on every reload — no manual rescan needed.
- New command-palette entry: **Toggle filter panel** (id `mk-graph-toggle-filter-panel`). The setting `Show filter panel` (default on) controls initial visibility.

**Architecture:**
- Pure-logic `filter-state.ts` (`FilterState` interface, `matchesFilter` predicate, JSON serialize / deserialize) is independently tested with 16 assertions.
- DOM `filter-panel.ts` (`createFilterPanel(parent, opts) → FilterPanelHandle`) is independently tested with 8 jsdom assertions.
- View integration adds `computeReferencedSet`, `collectTags`, and `handleFilterChange` helpers and wraps the controller's `onState` callback with a `.filter(matchesFilter)` pass.

### Tests
137 / 121 (was 121 — added 16 in `filter-state.test.ts`, 8 in `filter-panel.dom.test.ts`, 3 in `graph-state.test.ts`).

### Out of scope (deferred to v0.4+)
- **Forces** sliders (centre / repel / link / link distance) — exposes force-graph parameters; cosmetic.
- **Groups** (named filter sets that color-tint matching atoms) — needs design thought because Groups override the F2 type-fill encoding.
- **Arrow toggle** — currently `linkDirectionalArrowLength(0)` is hardcoded; one-line flip when implemented.
- **Text-fade threshold slider** — currently labels appear at force-graph `globalScale > 1.5`.
- **Animate / freeze button** for the simulation — force-graph already supports `pauseAnimation` / `resumeAnimation`.
- **Existing files only** / **Attachments** toggles from Obsidian's native panel — N/A here (atoms are always files; no attachments in mk's atom model).

```

- [ ] **Step 10.4: Run full suite + build**

```bash
cd packages/obsidian-mk-graph && npm test
cd packages/obsidian-mk-graph && npm run build
```

Expected: full suite green; clean esbuild output.

- [ ] **Step 10.5: Verify the test count**

```bash
cd packages/obsidian-mk-graph && npm test 2>&1 | grep "Tests"
```

Expected: `Tests  148 passed` (was 121; +27 new tests across filter-state, filter-panel.dom, and graph-state).

If the count differs by ±2 due to integration tests or fixture additions, re-check Tasks 2 / 3 / 5 to confirm test parity. (The CHANGELOG mention of 137 was a draft estimate; the real count after running the suite is authoritative — update CHANGELOG if needed.)

- [ ] **Step 10.6: Commit + tag**

```bash
git add packages/obsidian-mk-graph/manifest.json packages/obsidian-mk-graph/package.json packages/obsidian-mk-graph/package-lock.json packages/obsidian-mk-graph/CHANGELOG.md
git commit -m "chore(obsidian-mk-graph): release v0.3.0 — filter & display panel"
git tag obsidian-mk-graph-v0.3.0
```

(Push happens via the regular PR + merge flow, not in this task.)

---

## Self-review

### 1. Spec coverage

Cross-checked the spec (Filter / Display panel subset of Obsidian's native graph view) against tasks:

- **Search input** → Task 5 (renders), Task 2 (`matchesFilter` consumes), Task 7 (wires).
- **Atom-type checkboxes (9)** → Task 1 (constant), Task 5 (renders), Task 2 (predicate).
- **Status checkboxes (8)** → Task 1 (constant), Task 5 (renders), Task 2 (predicate).
- **Classification checkboxes (4)** → Task 1 (constant), Task 5 (renders), Task 2 (predicate).
- **Tag chips** → Task 3 (`getAvailableTags`), Task 5 (renders), Task 2 (predicate), Task 7 (refresh on reload).
- **Orphans-only toggle** → Task 5 (renders), Task 2 (predicate), Task 3 (`getReferencedIds`), Task 7 (`computeReferencedSet`).
- **Persistence** → Task 4 (settings shape), Task 2 (serialize/deserialize round-trip), Task 7 (saveSettings on each change).
- **Show / hide panel** → Task 4 (setting), Task 5 (`setVisible`), Task 8 (command).

No gaps in the v0.3.0 scope.

### 2. Placeholder scan

Searched for placeholder patterns:
- "TBD" / "TODO" / "implement later" — none.
- "Add appropriate error handling" — none. The predicate explicitly handles empty strings, empty Sets, and missing fields; the panel's `setAvailableTags` re-renders idempotently.
- "Similar to Task N" — only descriptive cross-references (e.g., "alongside `toggleLiveScrubbed`"), not code substitutions.
- "Write tests for the above" — every test case has explicit code.
- Code-block-required steps without code — none. Every step that touches code includes the full code or a concrete file path + line range.

### 3. Type consistency

- `FilterState` interface used identically in `filter-state.ts` (Task 2), `filter-panel.ts` (Task 5), `view.ts` (Task 7), `settings.ts` (Task 4).
- `SerializedFilterState` (the JSON-friendly shape) used in `filter-state.ts` (Task 2) and `settings.ts` (Task 4).
- `FilterPanelHandle` exposed from Task 5 and consumed identically in Task 7.
- Method names: `setState`, `setAvailableTags`, `setVisible`, `destroy` — same across panel definition (Task 5) and view consumer (Task 7).
- The view's helper trio `computeReferencedSet`, `collectTags`, `handleFilterChange` — names consistent across Task 7's two introduction points.

No drift detected.

---

## Out-of-scope follow-ups (v0.4+ inputs)

1. **Forces panel** (centre force / repel force / link force / link distance sliders). Exposes force-graph's `d3Force` settings. Easy to wire via `fg.d3Force('charge').strength(...)` etc.
2. **Groups** — named filter sets with color tints. Needs UX design — Groups would override the F2 type-fill, so they can't both be active. Either: (a) Groups replace the type fill entirely while active; (b) Groups are visualized as halos behind the F2-colored atoms; (c) Groups only apply to selected nodes. This is a v0.5+ design call.
3. **Arrow direction toggle** — flip `linkDirectionalArrowLength(0)` to a settings-driven value. One line.
4. **Text fade threshold slider** — replace the hardcoded `globalScale > 1.5` check in renderer with a setting-bound value. One line in renderer + one settings field.
5. **Animate / freeze button** — wire `fg.pauseAnimation()` / `fg.resumeAnimation()` to a header button. Two lines.
6. **Per-tag color overrides** — extend Tags section so chips can carry a custom color, applied as the F2 fill when the tag is the only selected one.
7. **Filter presets / Groups** — save the current filter state under a name; switch between named presets with a dropdown.

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-04-obsidian-mk-graph-v0.3.0-filter-panel.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
