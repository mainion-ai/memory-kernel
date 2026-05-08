# Obsidian mk-graph — Phase 3 (replay + timeline) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the obsidian-mk-graph plugin time-aware. Read `events.ndjson` directly, replay events deterministically to any timestamp T, and surface three modes through a scrubber UI: **Live** (file watcher tail, default), **Scrubbed** (graph frozen at chosen T), and **Diff** (T1↔T2 with added/removed/mutated coloring). Add a **timeline** layout (X = `created_at` over visible range, Y = type stratification). Ship as `obsidian-mk-graph@0.2.0`.

**Architecture:** Events.ndjson is the source of truth for replay. The plugin parses it directly (no `mk` subprocess in this phase — that arrives in Phase 4 for wander). A pure `replayEvents(events, T?)` function processes mutation events in timestamp order using `event.atom_snapshot` (V2 events) to populate a `Map<atomId, ParsedAtom>`; `atom_archived`/`atom_expired` removes; V1 events without snapshots fall back to current atom files for that ID. `GraphState.replace()` is unchanged — `view.ts` calls it with the replay output. A new `ReplayController` owns mode state (Live | Scrubbed | Diff), drives the renderer, and reads `lastScrubbedAt` from settings on startup. The scrubber lives below the graph as a fixed-position overlay (same body-attachment trick as legend/tooltip — force-graph clobbers sibling children). Timeline layout sets `fx`/`fy` on each node; the renderer toggles between force simulation and pinned positions per layout choice. Diff mode dual-replays at T1 and T2, computes a `DiffSet`, and the renderer overlays color (added=green, removed=red+ghost, mutated=amber) atop F2. SECRET decryption is not needed here — atom-file fallback covers redacted snapshots.

**Tech Stack:** TypeScript 5.x, esbuild (existing), Obsidian Plugin API (existing), `force-graph` (existing), `gray-matter` (existing — used by `parseAtomFile`), vitest with `node` and a new `jsdom` config for DOM-bound tests, `chokidar` is intentionally **not** added — `fs.watch` from Phase 2 is reused for `events.ndjson` via tail-on-change.

**Spec:** [docs/superpowers/specs/2026-04-28-obsidian-mk-graph-design.md](../specs/2026-04-28-obsidian-mk-graph-design.md) §3 (data flow, components), §5.1 (settings: `liveModeOnStartup`, `lastScrubbedAt`, `defaultLayout` adds `timeline`), §5.3 (timeline layout), §5.5 (replay UX — scrubber, density histogram, three modes), §6 (phase 3 row).

**Predecessor plans:**
- [docs/superpowers/plans/2026-04-29-obsidian-mk-graph-phase1-mk-core.md](2026-04-29-obsidian-mk-graph-phase1-mk-core.md) — shipped (memory-kernel v1.17.0/1.17.1).
- [docs/superpowers/plans/2026-04-30-obsidian-mk-graph-phase2-plugin-scaffold.md](2026-04-30-obsidian-mk-graph-phase2-plugin-scaffold.md) — shipped (obsidian-mk-graph v0.1.0–v0.1.10).

---

## File structure

| File | Action | Responsibility |
|---|---|---|
| `packages/obsidian-mk-graph/src/event-parser.ts` | Create | Parse one `events.ndjson` line into a `PluginEvent`; validate shape; classify mutation kind |
| `packages/obsidian-mk-graph/src/events-loader.ts` | Create | Read entire `events.ndjson` once + tail-watch; expose `EventsWatcher` with debounced change callback |
| `packages/obsidian-mk-graph/src/replay-engine.ts` | Create | Pure `replayEvents(events, opts?) → Map<id, ParsedAtom>`; supports target T cutoff + atom-file fallback for V1 events |
| `packages/obsidian-mk-graph/src/diff-state.ts` | Create | `diffStates(prev, next) → DiffSet { added, removed, mutated }`; mutation = same id, different `updated_at` |
| `packages/obsidian-mk-graph/src/density-histogram.ts` | Create | Bucket events by day/week/month based on visible range; emit `HistogramBucket[]` |
| `packages/obsidian-mk-graph/src/timeline-layout.ts` | Create | `computeTimelinePositions(atoms, opts) → Map<id, {x, y}>`; X = `created_at` mapped to width, Y = type-band index + jitter |
| `packages/obsidian-mk-graph/src/layout.ts` | Create | Layout enum (`force` \| `timeline`); dispatch + apply pinned positions to force-graph nodes |
| `packages/obsidian-mk-graph/src/scrubber.ts` | Create | DOM scrubber overlay — mode buttons, playhead slider, time readout, density bars |
| `packages/obsidian-mk-graph/src/replay-controller.ts` | Create | Owns mode + playhead state; subscribes to events-loader + atom-file watcher; produces `ParsedAtom[]` for `GraphState.replace()` |
| `packages/obsidian-mk-graph/src/diff-overlay.ts` | Create | Pure encoders: `diffNodeColor(atom, diff) → string`, `diffNodeOpacity(atom, diff) → number`, `diffEdgeColor(rel, diff) → string` |
| `packages/obsidian-mk-graph/src/atom-types.ts` | Create | Canonical atom-type ordering (9 types) for stratification — single source for timeline-layout band index and any future use |
| `packages/obsidian-mk-graph/src/view.ts` | Modify | Mount scrubber, instantiate `ReplayController`, replace direct `readVault()` flow with controller-driven `state.replace()` |
| `packages/obsidian-mk-graph/src/renderer.ts` | Modify | Accept `layout` option and `diff` option; switch between force simulation and pinned positions; apply `diff-overlay` encoders when `diff` is set |
| `packages/obsidian-mk-graph/src/data-loader.ts` | Modify | Refactor `watchVault` to also watch `events.ndjson`; export `watchEvents(memoryDir, onChange)` |
| `packages/obsidian-mk-graph/src/settings.ts` | Modify | Add `liveModeOnStartup`, `lastScrubbedAt`, `defaultLayout` widens to `'force' \| 'timeline'`, `showScrubber` toggle |
| `packages/obsidian-mk-graph/src/main.ts` | Modify | Add commands: "Toggle Live/Scrubbed", "Enter Diff mode" |
| `packages/obsidian-mk-graph/styles.css` | Modify | Scrubber styles (overlay positioning, histogram bars, mode buttons, playhead) |
| `packages/obsidian-mk-graph/package.json` | Modify | `"version": "0.2.0"`; add `"@types/jsdom"` + `"jsdom"` devDeps for DOM-bound tests |
| `packages/obsidian-mk-graph/manifest.json` | Modify | `"version": "0.2.0"` |
| `packages/obsidian-mk-graph/CHANGELOG.md` | Modify | Add `## [0.2.0] — 2026-05-03` section |
| `packages/obsidian-mk-graph/README.md` | Modify | Document new modes, scrubber, timeline layout; add "Phase 3" entry to feature list |
| `packages/obsidian-mk-graph/SMOKE_TEST.md` | Modify | Add S5–S9 walks for scrubber / Live tail / Scrubbed / Diff / timeline layout |
| `packages/obsidian-mk-graph/vitest.config.ts` | Modify | Switch to per-file environment via `// @vitest-environment` comments OR add `environmentMatchGlobs` for `*.dom.test.ts` |
| `packages/obsidian-mk-graph/test/event-parser.test.ts` | Create | Parse valid/invalid event lines; classify mutation kind |
| `packages/obsidian-mk-graph/test/events-loader.test.ts` | Create | Read full events.ndjson; tail returns only new lines; debounce |
| `packages/obsidian-mk-graph/test/replay-engine.test.ts` | Create | V2 snapshot replay; archive removes; T cutoff; V1 fallback to atom files |
| `packages/obsidian-mk-graph/test/diff-state.test.ts` | Create | Added / removed / mutated detection |
| `packages/obsidian-mk-graph/test/density-histogram.test.ts` | Create | Bucket selection by range; counts; empty range |
| `packages/obsidian-mk-graph/test/timeline-layout.test.ts` | Create | X mapping monotonic in `created_at`; Y stratified by type; deterministic jitter |
| `packages/obsidian-mk-graph/test/layout.test.ts` | Create | Force layout = no pins; timeline layout = `fx`/`fy` set on every node |
| `packages/obsidian-mk-graph/test/diff-overlay.test.ts` | Create | Color/opacity for added/removed/mutated/unchanged |
| `packages/obsidian-mk-graph/test/scrubber.dom.test.ts` | Create | jsdom — mode buttons fire callbacks; playhead emits ISO timestamps; histogram renders N bars |
| `packages/obsidian-mk-graph/test/replay-controller.test.ts` | Create | Live mode → atom-file path; Scrubbed → replay path; Diff → dual replay |
| `packages/obsidian-mk-graph/test/fixtures/small-vault/events.ndjson` | Create | Hand-crafted events covering the 20 fixture atoms (created_at sequence + 2 archives + 1 update) |
| `packages/obsidian-mk-graph/test/fixtures/generate-small-vault.mjs` | Modify | Append events.ndjson generation at end of script |

**Out of scope for this phase:**
- Wander viz layers (heatmap / ripple / constellation), `MkCliRunner` subprocess, radial-wander layout → Phase 4
- F3 togglable layers (tag halos, evidence badge, TTL pulse, agent stripe) → Phase 5
- Performance hardening to 10k atoms, BRAT auto-release, Community Plugins submission → Phase 5
- SECRET event decryption inside the plugin — atom-file fallback covers it; full decryption is delegated to `mk timeline --json` if/when needed in Phase 4
- Recall/wander event ticks on the timeline — spec §H confirms v1 = atom-mutation events only
- Episode nodes — out of v1 scope per spec §8
- Playwright-electron renderer tests — Phase 5

---

## Task 1: Add `atom-types.ts` canonical ordering

**Files:**
- Create: `packages/obsidian-mk-graph/src/atom-types.ts`

- [ ] **Step 1.1: Write `packages/obsidian-mk-graph/src/atom-types.ts`**

```typescript
/**
 * Canonical ordering of the 9 mk atom types. Used by the timeline layout
 * to assign a Y band per type (band index = position in this array).
 *
 * Order matches the visual hierarchy decided during phase 2 design:
 * facts and beliefs at top (most concrete / observed), conflicts at
 * bottom (synthesised). Don't reorder casually — fixture screenshots
 * and the legend depend on this sequence.
 */
export const ATOM_TYPE_ORDER: readonly string[] = [
  'fact',
  'belief',
  'decision',
  'preference',
  'constraint',
  'procedure',
  'entity_summary',
  'open_question',
  'conflict',
] as const;

/** Returns the band index 0..8 for a known type, or `ATOM_TYPE_ORDER.length`
 *  (i.e. one band below the bottom) for unknown types so they sort last but
 *  remain visible. Never throws. */
export function typeBandIndex(type: string): number {
  const i = ATOM_TYPE_ORDER.indexOf(type);
  return i === -1 ? ATOM_TYPE_ORDER.length : i;
}

/** Total number of bands the timeline layout needs to allocate vertical
 *  space for, including the unknown-types fallback row. */
export const TIMELINE_BAND_COUNT = ATOM_TYPE_ORDER.length + 1;
```

- [ ] **Step 1.2: Commit**

```bash
git add packages/obsidian-mk-graph/src/atom-types.ts
git commit -m "feat(obsidian-mk-graph): add canonical atom-type ordering for timeline stratification"
```

---

## Task 2: Event parser — `event-parser.ts`

**Files:**
- Create: `packages/obsidian-mk-graph/src/event-parser.ts`
- Create: `packages/obsidian-mk-graph/test/event-parser.test.ts`

- [ ] **Step 2.1: Write the failing test**

Create `packages/obsidian-mk-graph/test/event-parser.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseEventLine, isMutationEvent } from '../src/event-parser.js';

describe('parseEventLine', () => {
  it('parses a v2 atom_created event with snapshot', () => {
    const line = JSON.stringify({
      event_id: 'EVT-001',
      timestamp: '2026-04-01T10:00:00Z',
      agent_id: 'a',
      session_id: 's',
      action: 'atom_created',
      atom_refs: ['FACT-2026-04-01-X-aa00'],
      schema_version: 2,
      atom_snapshot: '---\nid: FACT-2026-04-01-X-aa00\n---\nbody',
    });
    const ev = parseEventLine(line);
    expect(ev).not.toBeNull();
    expect(ev!.action).toBe('atom_created');
    expect(ev!.atom_snapshot).toContain('FACT-2026-04-01-X-aa00');
    expect(ev!.timestamp).toBe('2026-04-01T10:00:00Z');
  });

  it('returns null for malformed JSON', () => {
    expect(parseEventLine('not json')).toBeNull();
    expect(parseEventLine('{')).toBeNull();
  });

  it('returns null when required fields missing', () => {
    expect(parseEventLine(JSON.stringify({ action: 'atom_created' }))).toBeNull();
    expect(parseEventLine(JSON.stringify({ event_id: 'X', action: 'x' }))).toBeNull();
  });

  it('returns null on empty / whitespace lines', () => {
    expect(parseEventLine('')).toBeNull();
    expect(parseEventLine('   ')).toBeNull();
  });
});

describe('isMutationEvent', () => {
  it('returns true for the five mutation actions', () => {
    for (const a of ['atom_created', 'atom_updated', 'atom_archived', 'atom_promoted', 'atom_expired']) {
      expect(isMutationEvent({ action: a } as never)).toBe(true);
    }
  });

  it('returns false for non-mutation actions', () => {
    expect(isMutationEvent({ action: 'recall' } as never)).toBe(false);
    expect(isMutationEvent({ action: 'wander' } as never)).toBe(false);
    expect(isMutationEvent({ action: 'compact' } as never)).toBe(false);
  });
});
```

- [ ] **Step 2.2: Run test to verify it fails**

```bash
cd packages/obsidian-mk-graph && npx vitest run test/event-parser.test.ts
```

Expected: FAIL with "Cannot find module '../src/event-parser.js'".

- [ ] **Step 2.3: Write `packages/obsidian-mk-graph/src/event-parser.ts`**

```typescript
/**
 * One line of `events.ndjson`, validated and narrowed to the fields the
 * plugin uses. Mirrors mk-core's `MemoryEvent` (src/types.ts) but stays
 * decoupled — the plugin must not import mk-core (drags in `better-sqlite3`).
 */
export interface PluginEvent {
  event_id: string;
  timestamp: string;        // ISO8601 — replay sorts by this
  agent_id: string;
  session_id: string;
  action: string;
  atom_refs?: string[];
  /** V2 events only. When present, the full atom .md content at the time
   *  of the event. Replay uses this to reconstruct historical state. */
  atom_snapshot?: string;
  /** V2 events only. SHA-256 of `atom_snapshot` if it lives in `evidence/`.
   *  The plugin doesn't resolve hashes — atom-file fallback covers V1/V2
   *  hash-only cases. Tracked for debugging. */
  atom_snapshot_hash?: string;
  schema_version?: number;
}

const MUTATION_ACTIONS = new Set([
  'atom_created',
  'atom_updated',
  'atom_archived',
  'atom_promoted',
  'atom_expired',
]);

/** Returns true when the event mutates atom state and therefore matters
 *  for replay. Non-mutation events (recall, wander, compact) are filtered
 *  out at parse time. */
export function isMutationEvent(ev: Pick<PluginEvent, 'action'>): boolean {
  return MUTATION_ACTIONS.has(ev.action);
}

/** Parse one NDJSON line into a `PluginEvent`. Returns null on:
 *  - empty / whitespace lines
 *  - JSON parse errors
 *  - missing required fields (event_id, timestamp, action)
 *  Never throws. The events-loader silently skips nulls so a single bad
 *  line can't break replay. */
export function parseEventLine(line: string): PluginEvent | null {
  if (!line.trim()) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object') return null;

  const o = raw as Record<string, unknown>;
  if (typeof o.event_id !== 'string' || !o.event_id) return null;
  if (typeof o.timestamp !== 'string' || !o.timestamp) return null;
  if (typeof o.action !== 'string' || !o.action) return null;

  const ev: PluginEvent = {
    event_id: o.event_id,
    timestamp: o.timestamp,
    agent_id: typeof o.agent_id === 'string' ? o.agent_id : '',
    session_id: typeof o.session_id === 'string' ? o.session_id : '',
    action: o.action,
  };
  if (Array.isArray(o.atom_refs)) {
    ev.atom_refs = o.atom_refs.filter((x): x is string => typeof x === 'string');
  }
  if (typeof o.atom_snapshot === 'string') ev.atom_snapshot = o.atom_snapshot;
  if (typeof o.atom_snapshot_hash === 'string') ev.atom_snapshot_hash = o.atom_snapshot_hash;
  if (typeof o.schema_version === 'number') ev.schema_version = o.schema_version;

  return ev;
}
```

- [ ] **Step 2.4: Run test to verify it passes**

```bash
cd packages/obsidian-mk-graph && npx vitest run test/event-parser.test.ts
```

Expected: PASS — 7 assertions across 2 describe blocks.

- [ ] **Step 2.5: Commit**

```bash
git add packages/obsidian-mk-graph/src/event-parser.ts packages/obsidian-mk-graph/test/event-parser.test.ts
git commit -m "feat(obsidian-mk-graph): add event-parser primitives for events.ndjson lines"
```

---

## Task 3: Fixture events.ndjson + generator update

**Files:**
- Modify: `packages/obsidian-mk-graph/test/fixtures/generate-small-vault.mjs`
- Create: `packages/obsidian-mk-graph/test/fixtures/small-vault/events.ndjson`

- [ ] **Step 3.1: Read the existing generator to find the insertion point**

```bash
tail -20 packages/obsidian-mk-graph/test/fixtures/generate-small-vault.mjs
```

You're appending an events-emission block after the existing atom-write loop. The script is run manually via `node test/fixtures/generate-small-vault.mjs` from the package root and is committed alongside its output.

- [ ] **Step 3.2: Append the events-generation block to `generate-small-vault.mjs`**

After the final closing brace of the atom-write loop (and the EPISODES write, if any), append:

```javascript
// --- events.ndjson ---
// Mirror the atoms array as a sequence of atom_created events at
// 2026-04-DD T 10:00:00Z (DD = atom.day). Add two archives at the end
// (atoms[2], atoms[5]) and one update for atoms[10]. Output is ordered
// by timestamp ascending so replay can stream-process line by line.

const events = [];
let evt = 0;
function evid() { return `EVT-${String(++evt).padStart(4, '0')}`; }

// Atom-created events, one per fixture atom.
for (const a of atoms) {
  const dd = String(a.day).padStart(2, '0');
  const ts = `2026-04-${dd}T10:00:00Z`;
  const file = path.join(ents, `${a.id}.md`);
  let snapshot = '';
  try {
    snapshot = require('node:fs').readFileSync(file, 'utf-8');
  } catch {
    snapshot = `---\nid: ${a.id}\ntype: ${a.type}\nstatus: ${a.status}\nclassification: ${a.classification}\ncreated_at: "${ts}"\nupdated_at: "${ts}"\nttl_days: null\n---\n\n`;
  }
  events.push({
    event_id: evid(),
    timestamp: ts,
    agent_id: 'fixture',
    session_id: 'fixture-seed',
    action: 'atom_created',
    atom_refs: [a.id],
    schema_version: 2,
    atom_snapshot: snapshot,
  });
}

// One update event for atoms[10] (bumps its updated_at).
const updTarget = atoms[10];
if (updTarget) {
  const ts = `2026-04-25T10:00:00Z`;
  events.push({
    event_id: evid(),
    timestamp: ts,
    agent_id: 'fixture',
    session_id: 'fixture-seed',
    action: 'atom_updated',
    atom_refs: [updTarget.id],
    schema_version: 2,
    atom_snapshot: `---\nid: ${updTarget.id}\ntype: ${updTarget.type}\nstatus: ${updTarget.status}\nclassification: ${updTarget.classification}\ncreated_at: "2026-04-${String(updTarget.day).padStart(2, '0')}T10:00:00Z"\nupdated_at: "${ts}"\nttl_days: null\n---\n\nUpdated body for ${updTarget.id}.\n`,
  });
}

// Two archive events at the very end.
for (const idx of [2, 5]) {
  const a = atoms[idx];
  if (!a) continue;
  events.push({
    event_id: evid(),
    timestamp: `2026-04-26T10:00:00Z`,
    agent_id: 'fixture',
    session_id: 'fixture-seed',
    action: 'atom_archived',
    atom_refs: [a.id],
    schema_version: 2,
    // Archived events typically lack a snapshot — replay just removes.
  });
}

events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
const ndjson = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
writeFileSync(path.join(root, 'events.ndjson'), ndjson);
console.log(`wrote ${events.length} events to ${path.join(root, 'events.ndjson')}`);
```

- [ ] **Step 3.3: Run the generator**

```bash
cd packages/obsidian-mk-graph && node test/fixtures/generate-small-vault.mjs
```

Expected: prints atom + episode counts (existing) and a new line like `wrote 23 events to .../small-vault/events.ndjson`.

- [ ] **Step 3.4: Verify the output shape**

```bash
head -3 packages/obsidian-mk-graph/test/fixtures/small-vault/events.ndjson
wc -l packages/obsidian-mk-graph/test/fixtures/small-vault/events.ndjson
```

Expected: 23 lines, each parseable as JSON, first line action `atom_created`.

- [ ] **Step 3.5: Commit**

```bash
git add packages/obsidian-mk-graph/test/fixtures/generate-small-vault.mjs packages/obsidian-mk-graph/test/fixtures/small-vault/events.ndjson
git commit -m "test(obsidian-mk-graph): add events.ndjson fixture for replay tests"
```

---

## Task 4: Events loader + tail watcher — `events-loader.ts`

**Files:**
- Create: `packages/obsidian-mk-graph/src/events-loader.ts`
- Create: `packages/obsidian-mk-graph/test/events-loader.test.ts`

- [ ] **Step 4.1: Write the failing test**

Create `packages/obsidian-mk-graph/test/events-loader.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readEvents, watchEvents } from '../src/events-loader.js';

const ev = (id: string, ts: string, action = 'atom_created') =>
  JSON.stringify({
    event_id: id,
    timestamp: ts,
    agent_id: 'a',
    session_id: 's',
    action,
    schema_version: 2,
    atom_snapshot: `---\nid: ${id}\ntype: fact\nstatus: active\ncreated_at: "${ts}"\nupdated_at: "${ts}"\nttl_days: null\n---\n\nbody\n`,
  });

describe('readEvents', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mk-graph-events-'));
  });
  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('returns [] when events.ndjson is missing', async () => {
    expect(await readEvents(dir)).toEqual([]);
  });

  it('parses lines in file order', async () => {
    const lines = [ev('E1', '2026-04-01T10:00:00Z'), ev('E2', '2026-04-02T10:00:00Z')];
    writeFileSync(path.join(dir, 'events.ndjson'), lines.join('\n') + '\n');
    const out = await readEvents(dir);
    expect(out.map((e) => e.event_id)).toEqual(['E1', 'E2']);
  });

  it('skips malformed lines but keeps valid ones', async () => {
    const lines = [ev('E1', '2026-04-01T10:00:00Z'), 'not json', ev('E2', '2026-04-02T10:00:00Z')];
    writeFileSync(path.join(dir, 'events.ndjson'), lines.join('\n') + '\n');
    const out = await readEvents(dir);
    expect(out.map((e) => e.event_id)).toEqual(['E1', 'E2']);
  });
});

describe('watchEvents', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mk-graph-events-watch-'));
    writeFileSync(path.join(dir, 'events.ndjson'), '');
  });
  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('fires onChange after a debounced append', async () => {
    let calls = 0;
    const w = watchEvents(dir, () => { calls++; }, 50);
    appendFileSync(path.join(dir, 'events.ndjson'), ev('E1', '2026-04-01T10:00:00Z') + '\n');
    appendFileSync(path.join(dir, 'events.ndjson'), ev('E2', '2026-04-02T10:00:00Z') + '\n');
    await new Promise((r) => setTimeout(r, 200));
    w.close();
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it('returns a no-op watcher when events.ndjson is absent', () => {
    rmSync(path.join(dir, 'events.ndjson'));
    const w = watchEvents(dir, () => {}, 50);
    // No throw, .close() safe.
    w.close();
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 4.2: Run test to verify it fails**

```bash
cd packages/obsidian-mk-graph && npx vitest run test/events-loader.test.ts
```

Expected: FAIL with "Cannot find module '../src/events-loader.js'".

- [ ] **Step 4.3: Write `packages/obsidian-mk-graph/src/events-loader.ts`**

```typescript
import { promises as fsp, existsSync, watch as fsWatch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { parseEventLine, type PluginEvent } from './event-parser.js';

const EVENTS_FILENAME = 'events.ndjson';

/** Read the entire events.ndjson once. Skips malformed lines. Returns
 *  events in file order (mk-core writes append-only timestamp-ascending,
 *  so file order = chronological). Never throws — missing file returns []. */
export async function readEvents(memoryDir: string): Promise<PluginEvent[]> {
  const file = path.join(memoryDir, EVENTS_FILENAME);
  if (!existsSync(file)) return [];

  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf-8');
  } catch {
    return [];
  }

  const out: PluginEvent[] = [];
  for (const line of raw.split('\n')) {
    const ev = parseEventLine(line);
    if (ev) out.push(ev);
  }
  return out;
}

export interface EventsWatcher {
  close(): void;
}

/**
 * Watch events.ndjson for appends. Coalesces rapid changes via the
 * supplied debounceMs (default 150 — same window as `watchVault` in
 * data-loader.ts so a CLI write that touches both atom files and the
 * event log only triggers one reload).
 *
 * Returns a no-op watcher when the file is absent — callers should
 * also watch the directory if they need to react to file creation.
 * (The view re-resolves the watcher on every reload, so this is fine
 * in practice.)
 */
export function watchEvents(
  memoryDir: string,
  onChange: () => void,
  debounceMs = 150,
): EventsWatcher {
  const file = path.join(memoryDir, EVENTS_FILENAME);
  if (!existsSync(file)) {
    return { close: () => {} };
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;
  try {
    watcher = fsWatch(file, { persistent: false }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        try { onChange(); } catch (e) { console.warn('mk-graph: watchEvents callback threw', e); }
      }, debounceMs);
    });
  } catch (e) {
    console.warn('mk-graph: watchEvents setup failed', e);
    return { close: () => {} };
  }

  return {
    close() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (watcher) { try { watcher.close(); } catch { /* ignore */ } watcher = null; }
    },
  };
}
```

- [ ] **Step 4.4: Run test to verify it passes**

```bash
cd packages/obsidian-mk-graph && npx vitest run test/events-loader.test.ts
```

Expected: PASS — 5 assertions across 2 describe blocks.

- [ ] **Step 4.5: Commit**

```bash
git add packages/obsidian-mk-graph/src/events-loader.ts packages/obsidian-mk-graph/test/events-loader.test.ts
git commit -m "feat(obsidian-mk-graph): add events.ndjson reader + tail watcher"
```

---

## Task 5: Replay engine — `replay-engine.ts`

**Files:**
- Create: `packages/obsidian-mk-graph/src/replay-engine.ts`
- Create: `packages/obsidian-mk-graph/test/replay-engine.test.ts`

- [ ] **Step 5.1: Write the failing test**

Create `packages/obsidian-mk-graph/test/replay-engine.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { replayEvents } from '../src/replay-engine.js';
import type { PluginEvent } from '../src/event-parser.js';
import type { ParsedAtom } from '../src/atom-parser.js';

const snap = (id: string, ts: string, body = 'b') =>
  `---\nid: ${id}\ntype: fact\nstatus: active\nclassification: TEAM\nconfidence: 0.9\ncreated_at: "${ts}"\nupdated_at: "${ts}"\nttl_days: null\n---\n\n${body}\n`;

const evCreate = (id: string, ts: string): PluginEvent => ({
  event_id: `EVT-${id}`,
  timestamp: ts,
  agent_id: 'a',
  session_id: 's',
  action: 'atom_created',
  atom_refs: [id],
  atom_snapshot: snap(id, ts),
  schema_version: 2,
});

const evArchive = (id: string, ts: string): PluginEvent => ({
  event_id: `EVT-A-${id}`,
  timestamp: ts,
  agent_id: 'a',
  session_id: 's',
  action: 'atom_archived',
  atom_refs: [id],
  schema_version: 2,
});

describe('replayEvents', () => {
  it('returns empty map for empty input', () => {
    expect(replayEvents([]).size).toBe(0);
  });

  it('reconstructs atoms from atom_created snapshots', () => {
    const out = replayEvents([
      evCreate('FACT-A', '2026-04-01T10:00:00Z'),
      evCreate('FACT-B', '2026-04-02T10:00:00Z'),
    ]);
    expect(out.size).toBe(2);
    expect(out.get('FACT-A')?.id).toBe('FACT-A');
    expect(out.get('FACT-B')?.id).toBe('FACT-B');
  });

  it('removes atoms on atom_archived', () => {
    const out = replayEvents([
      evCreate('FACT-A', '2026-04-01T10:00:00Z'),
      evArchive('FACT-A', '2026-04-02T10:00:00Z'),
    ]);
    expect(out.size).toBe(0);
  });

  it('atom_updated replaces snapshot', () => {
    const out = replayEvents([
      evCreate('FACT-A', '2026-04-01T10:00:00Z'),
      {
        ...evCreate('FACT-A', '2026-04-02T10:00:00Z'),
        action: 'atom_updated',
        atom_snapshot: snap('FACT-A', '2026-04-02T10:00:00Z', 'updated body'),
      },
    ]);
    expect(out.get('FACT-A')?.updatedAt).toBe('2026-04-02T10:00:00Z');
    expect(out.get('FACT-A')?.body).toContain('updated body');
  });

  it('honours target T cutoff (events with ts > T are ignored)', () => {
    const out = replayEvents(
      [
        evCreate('FACT-A', '2026-04-01T10:00:00Z'),
        evCreate('FACT-B', '2026-04-05T10:00:00Z'),
      ],
      { targetTimestamp: '2026-04-03T00:00:00Z' },
    );
    expect(out.size).toBe(1);
    expect(out.has('FACT-A')).toBe(true);
    expect(out.has('FACT-B')).toBe(false);
  });

  it('ignores non-mutation events', () => {
    const out = replayEvents([
      evCreate('FACT-A', '2026-04-01T10:00:00Z'),
      { event_id: 'X', timestamp: '2026-04-02T10:00:00Z', agent_id: 'a', session_id: 's', action: 'recall' },
      { event_id: 'Y', timestamp: '2026-04-03T10:00:00Z', agent_id: 'a', session_id: 's', action: 'wander' },
    ]);
    expect(out.size).toBe(1);
  });

  it('falls back to fallbackAtoms when snapshot is missing (V1 events)', () => {
    const fallback: ParsedAtom[] = [{
      id: 'FACT-LEGACY',
      type: 'fact',
      status: 'active',
      classification: 'TEAM',
      confidence: 1,
      createdAt: '2026-03-01T10:00:00Z',
      updatedAt: '2026-03-01T10:00:00Z',
      ttlDays: null,
      tags: [],
      relations: [],
      body: 'legacy body',
    }];
    const out = replayEvents(
      [
        // V1 event — no schema_version, no snapshot.
        { event_id: 'X', timestamp: '2026-03-01T10:00:00Z', agent_id: 'a', session_id: 's', action: 'atom_created', atom_refs: ['FACT-LEGACY'] },
      ],
      { fallbackAtoms: fallback },
    );
    expect(out.get('FACT-LEGACY')?.body).toBe('legacy body');
  });

  it('sorts events by timestamp before processing', () => {
    // Create with later ts, then archive with earlier ts — the create should
    // win because replay processes in timestamp order, not file order.
    const out = replayEvents([
      evArchive('FACT-A', '2026-04-01T10:00:00Z'),
      evCreate('FACT-A', '2026-04-02T10:00:00Z'),
    ]);
    expect(out.size).toBe(1);
    expect(out.has('FACT-A')).toBe(true);
  });
});
```

- [ ] **Step 5.2: Run test to verify it fails**

```bash
cd packages/obsidian-mk-graph && npx vitest run test/replay-engine.test.ts
```

Expected: FAIL with "Cannot find module '../src/replay-engine.js'".

- [ ] **Step 5.3: Write `packages/obsidian-mk-graph/src/replay-engine.ts`**

```typescript
import { parseAtomFile, type ParsedAtom } from './atom-parser.js';
import { isMutationEvent, type PluginEvent } from './event-parser.js';

export interface ReplayOptions {
  /** Stop processing events whose timestamp is strictly greater than this
   *  ISO8601 string. When omitted, replays the entire stream. */
  targetTimestamp?: string;
  /** Atoms read from disk. Used as a fallback for V1 events that lack a
   *  snapshot — replay can't reconstruct historical state but can at least
   *  show the atom in its current form. Keyed by atom id. */
  fallbackAtoms?: ParsedAtom[];
}

/**
 * Pure replay: events → atom map at time T (or "now" if no target).
 * Deterministic: same inputs → identical output.
 *
 * Algorithm:
 *  1. Filter to mutation events with timestamp ≤ targetTimestamp.
 *  2. Sort by timestamp ascending (file order is *usually* chronological
 *     but mk-core makes no hard guarantee, and merged event logs interleave).
 *  3. Walk events:
 *     - atom_created / atom_updated / atom_promoted with snapshot →
 *       parse via parseAtomFile, set in map (overwrites).
 *     - atom_created / atom_updated / atom_promoted without snapshot →
 *       try fallbackAtoms[atomId]; skip silently if not found (V1 limitation).
 *     - atom_archived / atom_expired → delete from map.
 *
 * V1 events without snapshots can't reconstruct historical content; we use
 * the current atom file as a best-effort proxy. Mismatch with historical
 * state is documented in CHANGELOG and the smoke checklist.
 */
export function replayEvents(
  events: PluginEvent[],
  opts: ReplayOptions = {},
): Map<string, ParsedAtom> {
  const fallbackById = new Map<string, ParsedAtom>();
  if (opts.fallbackAtoms) {
    for (const a of opts.fallbackAtoms) fallbackById.set(a.id, a);
  }

  const filtered = events.filter((ev) => {
    if (!isMutationEvent(ev)) return false;
    if (opts.targetTimestamp && ev.timestamp > opts.targetTimestamp) return false;
    return true;
  });
  filtered.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const out = new Map<string, ParsedAtom>();

  for (const ev of filtered) {
    const ids = ev.atom_refs ?? [];
    if (ev.action === 'atom_archived' || ev.action === 'atom_expired') {
      for (const id of ids) out.delete(id);
      continue;
    }

    // Created / updated / promoted — need a snapshot.
    if (ev.atom_snapshot) {
      const atom = parseAtomFile(ev.atom_snapshot);
      if (atom) {
        out.set(atom.id, atom);
        continue;
      }
      // Snapshot present but unparseable — fall through to fallback.
    }

    // V1 path or unparseable snapshot — try the on-disk fallback.
    for (const id of ids) {
      const fb = fallbackById.get(id);
      if (fb) out.set(id, fb);
    }
  }

  return out;
}
```

- [ ] **Step 5.4: Run test to verify it passes**

```bash
cd packages/obsidian-mk-graph && npx vitest run test/replay-engine.test.ts
```

Expected: PASS — 8 assertions.

- [ ] **Step 5.5: Add a fixture-driven integration test**

Append to `test/replay-engine.test.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseEventLine } from '../src/event-parser.js';

describe('replayEvents on small-vault fixture', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const eventsPath = path.join(here, 'fixtures', 'small-vault', 'events.ndjson');

  it('reconstructs the post-archive state (20 created − 2 archived = 18 atoms)', () => {
    const raw = readFileSync(eventsPath, 'utf-8');
    const events = raw.split('\n').map(parseEventLine).filter((e): e is NonNullable<typeof e> => e !== null);
    const out = replayEvents(events);
    expect(out.size).toBe(18);
  });

  it('reconstructs pre-archive state when T is set before archives', () => {
    const raw = readFileSync(eventsPath, 'utf-8');
    const events = raw.split('\n').map(parseEventLine).filter((e): e is NonNullable<typeof e> => e !== null);
    const out = replayEvents(events, { targetTimestamp: '2026-04-25T23:59:59Z' });
    expect(out.size).toBe(20);
  });
});
```

- [ ] **Step 5.6: Run fixture test to verify it passes**

```bash
cd packages/obsidian-mk-graph && npx vitest run test/replay-engine.test.ts
```

Expected: PASS — 10 assertions total.

- [ ] **Step 5.7: Commit**

```bash
git add packages/obsidian-mk-graph/src/replay-engine.ts packages/obsidian-mk-graph/test/replay-engine.test.ts
git commit -m "feat(obsidian-mk-graph): add deterministic replay engine for events.ndjson"
```

---

## Task 6: Diff state — `diff-state.ts`

**Files:**
- Create: `packages/obsidian-mk-graph/src/diff-state.ts`
- Create: `packages/obsidian-mk-graph/test/diff-state.test.ts`

- [ ] **Step 6.1: Write the failing test**

Create `packages/obsidian-mk-graph/test/diff-state.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { diffStates, type DiffSet } from '../src/diff-state.js';
import type { ParsedAtom } from '../src/atom-parser.js';

const atom = (id: string, updatedAt: string): ParsedAtom => ({
  id,
  type: 'fact',
  status: 'active',
  classification: 'TEAM',
  confidence: 1,
  createdAt: '2026-04-01T10:00:00Z',
  updatedAt,
  ttlDays: null,
  tags: [],
  relations: [],
  body: '',
});

const m = (...atoms: ParsedAtom[]) => new Map(atoms.map((a) => [a.id, a]));

describe('diffStates', () => {
  it('detects added atoms (in next, not prev)', () => {
    const d = diffStates(m(), m(atom('A', '2026-04-01T10:00:00Z')));
    expect([...d.added]).toEqual(['A']);
    expect([...d.removed]).toEqual([]);
    expect([...d.mutated]).toEqual([]);
  });

  it('detects removed atoms (in prev, not next)', () => {
    const d = diffStates(m(atom('A', '2026-04-01T10:00:00Z')), m());
    expect([...d.removed]).toEqual(['A']);
    expect([...d.added]).toEqual([]);
  });

  it('detects mutated atoms (same id, different updated_at)', () => {
    const d = diffStates(
      m(atom('A', '2026-04-01T10:00:00Z')),
      m(atom('A', '2026-04-02T10:00:00Z')),
    );
    expect([...d.mutated]).toEqual(['A']);
  });

  it('does not flag unchanged atoms (same id, same updated_at)', () => {
    const d = diffStates(
      m(atom('A', '2026-04-01T10:00:00Z')),
      m(atom('A', '2026-04-01T10:00:00Z')),
    );
    expect([...d.added]).toEqual([]);
    expect([...d.removed]).toEqual([]);
    expect([...d.mutated]).toEqual([]);
  });

  it('handles a mix in one diff', () => {
    const d = diffStates(
      m(atom('A', '2026-04-01T10:00:00Z'), atom('B', '2026-04-01T10:00:00Z'), atom('C', '2026-04-01T10:00:00Z')),
      m(atom('A', '2026-04-01T10:00:00Z'), atom('B', '2026-04-02T10:00:00Z'), atom('D', '2026-04-03T10:00:00Z')),
    );
    expect([...d.added].sort()).toEqual(['D']);
    expect([...d.removed].sort()).toEqual(['C']);
    expect([...d.mutated].sort()).toEqual(['B']);
  });

  it('classify(id) returns the right tag', () => {
    const d: DiffSet = diffStates(
      m(atom('REM', '2026-04-01T10:00:00Z'), atom('MUT', '2026-04-01T10:00:00Z')),
      m(atom('ADD', '2026-04-01T10:00:00Z'), atom('MUT', '2026-04-02T10:00:00Z')),
    );
    expect(d.classify('ADD')).toBe('added');
    expect(d.classify('REM')).toBe('removed');
    expect(d.classify('MUT')).toBe('mutated');
    expect(d.classify('UNKNOWN')).toBe('unchanged');
  });
});
```

- [ ] **Step 6.2: Run test to verify it fails**

```bash
cd packages/obsidian-mk-graph && npx vitest run test/diff-state.test.ts
```

Expected: FAIL with "Cannot find module '../src/diff-state.js'".

- [ ] **Step 6.3: Write `packages/obsidian-mk-graph/src/diff-state.ts`**

```typescript
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
```

- [ ] **Step 6.4: Run test to verify it passes**

```bash
cd packages/obsidian-mk-graph && npx vitest run test/diff-state.test.ts
```

Expected: PASS — 6 assertions.

- [ ] **Step 6.5: Commit**

```bash
git add packages/obsidian-mk-graph/src/diff-state.ts packages/obsidian-mk-graph/test/diff-state.test.ts
git commit -m "feat(obsidian-mk-graph): add diff-state computation for Diff mode"
```

---

## Task 7: Density histogram — `density-histogram.ts`

**Files:**
- Create: `packages/obsidian-mk-graph/src/density-histogram.ts`
- Create: `packages/obsidian-mk-graph/test/density-histogram.test.ts`

- [ ] **Step 7.1: Write the failing test**

Create `packages/obsidian-mk-graph/test/density-histogram.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { computeHistogram, pickBucketUnit } from '../src/density-histogram.js';
import type { PluginEvent } from '../src/event-parser.js';

const ev = (ts: string): PluginEvent => ({
  event_id: ts, timestamp: ts, agent_id: 'a', session_id: 's', action: 'atom_created',
});

describe('pickBucketUnit', () => {
  it('returns "day" for ranges ≤ 60 days', () => {
    expect(pickBucketUnit('2026-04-01T00:00:00Z', '2026-04-15T00:00:00Z')).toBe('day');
  });

  it('returns "week" for ranges 61..365 days', () => {
    expect(pickBucketUnit('2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z')).toBe('week');
  });

  it('returns "month" for ranges > 365 days', () => {
    expect(pickBucketUnit('2024-01-01T00:00:00Z', '2026-01-01T00:00:00Z')).toBe('month');
  });
});

describe('computeHistogram', () => {
  it('returns one bucket per day for a 5-day daily-resolution range', () => {
    const events = [
      ev('2026-04-01T08:00:00Z'),
      ev('2026-04-01T15:00:00Z'),
      ev('2026-04-03T10:00:00Z'),
      ev('2026-04-05T10:00:00Z'),
    ];
    const h = computeHistogram(events, '2026-04-01T00:00:00Z', '2026-04-05T23:59:59Z');
    expect(h.unit).toBe('day');
    expect(h.buckets).toHaveLength(5);
    expect(h.buckets[0].count).toBe(2); // 04-01: two events
    expect(h.buckets[1].count).toBe(0); // 04-02: empty bucket still emitted
    expect(h.buckets[2].count).toBe(1); // 04-03
    expect(h.buckets[3].count).toBe(0);
    expect(h.buckets[4].count).toBe(1); // 04-05
  });

  it('returns an empty buckets array when no events fall in range', () => {
    const events = [ev('2026-01-01T00:00:00Z')];
    const h = computeHistogram(events, '2026-04-01T00:00:00Z', '2026-04-05T00:00:00Z');
    expect(h.buckets.every((b) => b.count === 0)).toBe(true);
  });

  it('skips events outside the range', () => {
    const events = [
      ev('2026-03-31T23:59:59Z'),
      ev('2026-04-01T10:00:00Z'),
      ev('2026-04-06T00:00:00Z'),
    ];
    const h = computeHistogram(events, '2026-04-01T00:00:00Z', '2026-04-05T23:59:59Z');
    const total = h.buckets.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(1);
  });
});
```

- [ ] **Step 7.2: Run test to verify it fails**

```bash
cd packages/obsidian-mk-graph && npx vitest run test/density-histogram.test.ts
```

Expected: FAIL with "Cannot find module '../src/density-histogram.js'".

- [ ] **Step 7.3: Write `packages/obsidian-mk-graph/src/density-histogram.ts`**

```typescript
import type { PluginEvent } from './event-parser.js';

export type BucketUnit = 'day' | 'week' | 'month';

export interface HistogramBucket {
  /** Inclusive lower bound (ISO8601, midnight UTC for day/week, first-of-month for month). */
  start: string;
  /** Number of events whose timestamp falls in [start, nextStart). */
  count: number;
}

export interface Histogram {
  unit: BucketUnit;
  buckets: HistogramBucket[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Choose a bucket unit so there are roughly 30..120 buckets across the
 *  visible range. Day for short ranges, week for a year-or-less, month
 *  beyond. */
export function pickBucketUnit(fromIso: string, toIso: string): BucketUnit {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 'day';
  const days = (to - from) / DAY_MS;
  if (days <= 60) return 'day';
  if (days <= 365) return 'week';
  return 'month';
}

function startOfDayUtc(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function startOfWeekUtc(ms: number): number {
  // ISO week starts Monday. JavaScript: 0 = Sunday → shift by ((day + 6) % 7).
  const d = new Date(ms);
  const day = d.getUTCDay();
  const shift = (day + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - shift);
}

function startOfMonthUtc(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function nextBucket(ms: number, unit: BucketUnit): number {
  if (unit === 'day') return ms + DAY_MS;
  if (unit === 'week') return ms + 7 * DAY_MS;
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

function alignStart(ms: number, unit: BucketUnit): number {
  if (unit === 'day') return startOfDayUtc(ms);
  if (unit === 'week') return startOfWeekUtc(ms);
  return startOfMonthUtc(ms);
}

/**
 * Bucket events by [from, to] inclusive at the unit chosen by `pickBucketUnit`.
 * Empty buckets are kept so the renderer can draw a continuous histogram.
 * Events outside the range are silently skipped.
 */
export function computeHistogram(
  events: PluginEvent[],
  fromIso: string,
  toIso: string,
): Histogram {
  const unit = pickBucketUnit(fromIso, toIso);
  const fromMs = Date.parse(fromIso);
  const toMs = Date.parse(toIso);

  const buckets: HistogramBucket[] = [];
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
    return { unit, buckets };
  }

  let cursor = alignStart(fromMs, unit);
  while (cursor <= toMs) {
    buckets.push({ start: new Date(cursor).toISOString(), count: 0 });
    cursor = nextBucket(cursor, unit);
  }

  for (const ev of events) {
    const ts = Date.parse(ev.timestamp);
    if (!Number.isFinite(ts) || ts < fromMs || ts > toMs) continue;
    // Find the bucket index by aligned-start subtraction. Linear scan is
    // fine — buckets count is bounded by ~120, and event count by ~10k.
    for (let i = 0; i < buckets.length; i++) {
      const startMs = Date.parse(buckets[i].start);
      const nextMs = i + 1 < buckets.length ? Date.parse(buckets[i + 1].start) : nextBucket(startMs, unit);
      if (ts >= startMs && ts < nextMs) { buckets[i].count++; break; }
    }
  }

  return { unit, buckets };
}
```

- [ ] **Step 7.4: Run test to verify it passes**

```bash
cd packages/obsidian-mk-graph && npx vitest run test/density-histogram.test.ts
```

Expected: PASS — 6 assertions.

- [ ] **Step 7.5: Commit**

```bash
git add packages/obsidian-mk-graph/src/density-histogram.ts packages/obsidian-mk-graph/test/density-histogram.test.ts
git commit -m "feat(obsidian-mk-graph): add density-histogram bucketing for scrubber"
```

---

## Task 8: Timeline layout — `timeline-layout.ts`

**Files:**
- Create: `packages/obsidian-mk-graph/src/timeline-layout.ts`
- Create: `packages/obsidian-mk-graph/test/timeline-layout.test.ts`

- [ ] **Step 8.1: Write the failing test**

Create `packages/obsidian-mk-graph/test/timeline-layout.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { computeTimelinePositions } from '../src/timeline-layout.js';
import type { ParsedAtom } from '../src/atom-parser.js';

const atom = (id: string, type: string, createdAt: string): ParsedAtom => ({
  id, type, status: 'active', classification: 'TEAM',
  confidence: 1, createdAt, updatedAt: createdAt, ttlDays: null,
  tags: [], relations: [], body: '',
});

describe('computeTimelinePositions', () => {
  const opts = { width: 1000, height: 600, fromIso: '2026-04-01T00:00:00Z', toIso: '2026-04-30T23:59:59Z' };

  it('places atoms in monotonically increasing X by created_at', () => {
    const atoms = [
      atom('A', 'fact', '2026-04-05T10:00:00Z'),
      atom('B', 'fact', '2026-04-15T10:00:00Z'),
      atom('C', 'fact', '2026-04-25T10:00:00Z'),
    ];
    const pos = computeTimelinePositions(atoms, opts);
    const xa = pos.get('A')!.x;
    const xb = pos.get('B')!.x;
    const xc = pos.get('C')!.x;
    expect(xa).toBeLessThan(xb);
    expect(xb).toBeLessThan(xc);
  });

  it('stratifies Y by atom type — fact band ≠ conflict band', () => {
    const atoms = [
      atom('F', 'fact', '2026-04-10T10:00:00Z'),
      atom('C', 'conflict', '2026-04-10T10:00:00Z'),
    ];
    const pos = computeTimelinePositions(atoms, opts);
    expect(pos.get('F')!.y).not.toBe(pos.get('C')!.y);
  });

  it('clamps X to [margin, width-margin]', () => {
    const atoms = [
      atom('EARLY', 'fact', '2025-01-01T10:00:00Z'), // outside range
      atom('LATE', 'fact', '2027-01-01T10:00:00Z'),  // outside range
      atom('MID', 'fact', '2026-04-15T10:00:00Z'),
    ];
    const pos = computeTimelinePositions(atoms, opts);
    expect(pos.get('EARLY')!.x).toBeGreaterThanOrEqual(0);
    expect(pos.get('LATE')!.x).toBeLessThanOrEqual(opts.width);
  });

  it('is deterministic — same input → identical output', () => {
    const atoms = [
      atom('A', 'fact', '2026-04-05T10:00:00Z'),
      atom('B', 'belief', '2026-04-15T10:00:00Z'),
      atom('C', 'decision', '2026-04-25T10:00:00Z'),
    ];
    const a = computeTimelinePositions(atoms, opts);
    const b = computeTimelinePositions(atoms, opts);
    for (const id of ['A', 'B', 'C']) {
      expect(a.get(id)).toEqual(b.get(id));
    }
  });

  it('returns empty map for empty atom array', () => {
    expect(computeTimelinePositions([], opts).size).toBe(0);
  });

  it('places unknown-type atoms in the fallback band (last row)', () => {
    const atoms = [
      atom('F', 'fact', '2026-04-15T10:00:00Z'),
      atom('U', 'made_up_type', '2026-04-15T10:00:00Z'),
    ];
    const pos = computeTimelinePositions(atoms, opts);
    expect(pos.get('U')!.y).toBeGreaterThan(pos.get('F')!.y);
  });
});
```

- [ ] **Step 8.2: Run test to verify it fails**

```bash
cd packages/obsidian-mk-graph && npx vitest run test/timeline-layout.test.ts
```

Expected: FAIL with "Cannot find module '../src/timeline-layout.js'".

- [ ] **Step 8.3: Write `packages/obsidian-mk-graph/src/timeline-layout.ts`**

```typescript
import type { ParsedAtom } from './atom-parser.js';
import { typeBandIndex, TIMELINE_BAND_COUNT } from './atom-types.js';

export interface TimelineLayoutOptions {
  width: number;
  height: number;
  /** Inclusive lower bound for the X axis. Atoms older than this clamp to the left margin. */
  fromIso: string;
  /** Inclusive upper bound for the X axis. Atoms newer than this clamp to the right margin. */
  toIso: string;
  /** Horizontal padding inside the view. Default 40px. */
  marginX?: number;
  /** Vertical padding inside the view. Default 32px. */
  marginY?: number;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Place atoms on a timeline:
 *  - X = (createdAt - from) / (to - from) * (width - 2*margin) + margin
 *  - Y = bandTop + bandHeight * jitter(id)
 *  - bandTop = marginY + bandIndex * bandHeight
 *  - bandHeight = (height - 2*marginY) / TIMELINE_BAND_COUNT
 *
 * Jitter is deterministic (seeded by atom id) so re-renders don't shuffle
 * Y positions. Range [0.2, 0.8] of band height to keep nodes off the
 * band boundaries.
 */
export function computeTimelinePositions(
  atoms: ParsedAtom[],
  opts: TimelineLayoutOptions,
): Map<string, Point> {
  const out = new Map<string, Point>();
  if (atoms.length === 0) return out;

  const marginX = opts.marginX ?? 40;
  const marginY = opts.marginY ?? 32;
  const usableW = Math.max(1, opts.width - 2 * marginX);
  const usableH = Math.max(1, opts.height - 2 * marginY);
  const bandHeight = usableH / TIMELINE_BAND_COUNT;

  const fromMs = Date.parse(opts.fromIso);
  const toMs = Date.parse(opts.toIso);
  const span = Math.max(1, toMs - fromMs);

  for (const a of atoms) {
    const tMs = Date.parse(a.createdAt);
    let xFrac = Number.isFinite(tMs) ? (tMs - fromMs) / span : 0.5;
    if (xFrac < 0) xFrac = 0;
    if (xFrac > 1) xFrac = 1;
    const x = marginX + xFrac * usableW;

    const band = typeBandIndex(a.type);
    const bandTop = marginY + band * bandHeight;
    const jitter = idJitter(a.id); // [0..1)
    const y = bandTop + bandHeight * (0.2 + 0.6 * jitter);

    out.set(a.id, { x, y });
  }

  return out;
}

/** Tiny deterministic 32-bit hash → [0..1). Stable across runs and platforms. */
function idJitter(id: string): number {
  let h = 2166136261 >>> 0; // FNV-1a basis
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0) / 4294967296;
}
```

- [ ] **Step 8.4: Run test to verify it passes**

```bash
cd packages/obsidian-mk-graph && npx vitest run test/timeline-layout.test.ts
```

Expected: PASS — 6 assertions.

- [ ] **Step 8.5: Commit**

```bash
git add packages/obsidian-mk-graph/src/timeline-layout.ts packages/obsidian-mk-graph/test/timeline-layout.test.ts
git commit -m "feat(obsidian-mk-graph): add timeline layout (X=created_at, Y=type band)"
```

---

## Task 9: Layout dispatch — `layout.ts`

**Files:**
- Create: `packages/obsidian-mk-graph/src/layout.ts`
- Create: `packages/obsidian-mk-graph/test/layout.test.ts`

- [ ] **Step 9.1: Write the failing test**

Create `packages/obsidian-mk-graph/test/layout.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { applyLayout, type LayoutKind } from '../src/layout.js';
import type { GraphNode } from '../src/graph-state.js';

const node = (id: string, type: string, createdAt: string): GraphNode => ({
  id, type, status: 'active', classification: 'TEAM',
  confidence: 1, createdAt, updatedAt: createdAt, ttlDays: null,
  tags: [], relations: [], body: '',
});

describe('applyLayout', () => {
  const nodes = [
    node('A', 'fact', '2026-04-05T10:00:00Z'),
    node('B', 'belief', '2026-04-15T10:00:00Z'),
  ];

  it('force layout clears any pinned positions', () => {
    nodes[0].fx = 100; nodes[0].fy = 100;
    applyLayout(nodes as GraphNode[], { kind: 'force', width: 800, height: 600, fromIso: '', toIso: '' });
    expect(nodes[0].fx).toBeUndefined();
    expect(nodes[0].fy).toBeUndefined();
  });

  it('timeline layout pins fx/fy on every node', () => {
    applyLayout(nodes as GraphNode[], {
      kind: 'timeline',
      width: 800, height: 600,
      fromIso: '2026-04-01T00:00:00Z', toIso: '2026-04-30T00:00:00Z',
    });
    for (const n of nodes) {
      expect(typeof n.fx).toBe('number');
      expect(typeof n.fy).toBe('number');
    }
  });

  it('passes width/height through to timeline layout', () => {
    applyLayout(nodes as GraphNode[], {
      kind: 'timeline',
      width: 800, height: 600,
      fromIso: '2026-04-01T00:00:00Z', toIso: '2026-04-30T00:00:00Z',
    });
    for (const n of nodes) {
      expect(n.fx!).toBeGreaterThanOrEqual(0);
      expect(n.fx!).toBeLessThanOrEqual(800);
      expect(n.fy!).toBeGreaterThanOrEqual(0);
      expect(n.fy!).toBeLessThanOrEqual(600);
    }
  });
});

describe('LayoutKind type', () => {
  it('accepts force and timeline strings (compile-time check via cast)', () => {
    const kinds: LayoutKind[] = ['force', 'timeline'];
    expect(kinds).toHaveLength(2);
  });
});
```

- [ ] **Step 9.2: Run test to verify it fails**

```bash
cd packages/obsidian-mk-graph && npx vitest run test/layout.test.ts
```

Expected: FAIL with "Cannot find module '../src/layout.js'".

- [ ] **Step 9.3: Write `packages/obsidian-mk-graph/src/layout.ts`**

```typescript
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
```

- [ ] **Step 9.4: Run test to verify it passes**

```bash
cd packages/obsidian-mk-graph && npx vitest run test/layout.test.ts
```

Expected: PASS — 4 assertions.

- [ ] **Step 9.5: Extend `GraphNode` with optional `fx`/`fy`**

Read `packages/obsidian-mk-graph/src/graph-state.ts:6-12`. The interface currently declares `x?, y?, vx?, vy?` but not `fx, fy`. Add them:

Edit `packages/obsidian-mk-graph/src/graph-state.ts:6-12` from:

```typescript
export interface GraphNode extends ParsedAtom {
  // force-graph mutates these; declared here so TS allows them.
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}
```

to:

```typescript
export interface GraphNode extends ParsedAtom {
  // force-graph mutates these; declared here so TS allows them.
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  /** Pinned position. When set, force-graph treats the node as fixed.
   *  Used by the timeline layout. Cleared by the force layout. */
  fx?: number;
  fy?: number;
}
```

- [ ] **Step 9.6: Re-run layout tests**

```bash
cd packages/obsidian-mk-graph && npx vitest run test/layout.test.ts test/graph-state.test.ts
```

Expected: PASS for both files (graph-state tests should still pass — we only widened the type).

- [ ] **Step 9.7: Commit**

```bash
git add packages/obsidian-mk-graph/src/layout.ts packages/obsidian-mk-graph/src/graph-state.ts packages/obsidian-mk-graph/test/layout.test.ts
git commit -m "feat(obsidian-mk-graph): add layout dispatch (force | timeline) with pinned positions"
```

---

## Task 10: Diff overlay encoders — `diff-overlay.ts`

**Files:**
- Create: `packages/obsidian-mk-graph/src/diff-overlay.ts`
- Create: `packages/obsidian-mk-graph/test/diff-overlay.test.ts`

- [ ] **Step 10.1: Write the failing test**

Create `packages/obsidian-mk-graph/test/diff-overlay.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  DIFF_COLORS,
  diffNodeColor,
  diffNodeOpacity,
  diffEdgeColor,
} from '../src/diff-overlay.js';

describe('diffNodeColor', () => {
  it('returns the added color for added atoms', () => {
    expect(diffNodeColor('added', '#fallback')).toBe(DIFF_COLORS.added);
  });

  it('returns the removed color for removed atoms', () => {
    expect(diffNodeColor('removed', '#fallback')).toBe(DIFF_COLORS.removed);
  });

  it('returns the mutated color for mutated atoms', () => {
    expect(diffNodeColor('mutated', '#fallback')).toBe(DIFF_COLORS.mutated);
  });

  it('returns the fallback (F2 type color) for unchanged atoms', () => {
    expect(diffNodeColor('unchanged', '#fallback')).toBe('#fallback');
  });
});

describe('diffNodeOpacity', () => {
  it('removed atoms render as ghosts (low opacity)', () => {
    expect(diffNodeOpacity('removed', 1.0)).toBeLessThan(0.5);
  });

  it('added/mutated/unchanged keep the F2 opacity', () => {
    expect(diffNodeOpacity('added', 1.0)).toBe(1.0);
    expect(diffNodeOpacity('mutated', 0.5)).toBe(0.5);
    expect(diffNodeOpacity('unchanged', 0.7)).toBe(0.7);
  });
});

describe('diffEdgeColor', () => {
  it('uses the source node tag if it is non-unchanged', () => {
    expect(diffEdgeColor('added', 'unchanged', '#f2')).toBe(DIFF_COLORS.added);
    expect(diffEdgeColor('removed', 'unchanged', '#f2')).toBe(DIFF_COLORS.removed);
  });

  it('uses the target tag when source is unchanged', () => {
    expect(diffEdgeColor('unchanged', 'mutated', '#f2')).toBe(DIFF_COLORS.mutated);
  });

  it('falls back to F2 edge color when both endpoints are unchanged', () => {
    expect(diffEdgeColor('unchanged', 'unchanged', '#f2')).toBe('#f2');
  });
});
```

- [ ] **Step 10.2: Run test to verify it fails**

```bash
cd packages/obsidian-mk-graph && npx vitest run test/diff-overlay.test.ts
```

Expected: FAIL with "Cannot find module '../src/diff-overlay.js'".

- [ ] **Step 10.3: Write `packages/obsidian-mk-graph/src/diff-overlay.ts`**

```typescript
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
```

- [ ] **Step 10.4: Run test to verify it passes**

```bash
cd packages/obsidian-mk-graph && npx vitest run test/diff-overlay.test.ts
```

Expected: PASS — 9 assertions.

- [ ] **Step 10.5: Commit**

```bash
git add packages/obsidian-mk-graph/src/diff-overlay.ts packages/obsidian-mk-graph/test/diff-overlay.test.ts
git commit -m "feat(obsidian-mk-graph): add diff-overlay encoders (added/removed/mutated colors)"
```

---

## Task 11: Vitest jsdom environment for DOM tests

**Files:**
- Modify: `packages/obsidian-mk-graph/vitest.config.ts`
- Modify: `packages/obsidian-mk-graph/package.json`

- [ ] **Step 11.1: Install jsdom devDeps**

```bash
cd packages/obsidian-mk-graph && npm install --save-dev jsdom @types/jsdom
```

Expected: `package.json` and `package-lock.json` updated.

- [ ] **Step 11.2: Edit `packages/obsidian-mk-graph/vitest.config.ts`**

Replace the current contents with:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
    // Per-file environment override: anything ending in `.dom.test.ts`
    // runs under jsdom for DOM-dependent UI components (scrubber, etc.).
    environmentMatchGlobs: [
      ['test/**/*.dom.test.ts', 'jsdom'],
    ],
  },
});
```

- [ ] **Step 11.3: Verify all existing tests still pass**

```bash
cd packages/obsidian-mk-graph && npm test
```

Expected: all existing Phase 2 + Tasks 1–10 tests pass under the unchanged `node` environment.

- [ ] **Step 11.4: Commit**

```bash
git add packages/obsidian-mk-graph/vitest.config.ts packages/obsidian-mk-graph/package.json packages/obsidian-mk-graph/package-lock.json
git commit -m "build(obsidian-mk-graph): add jsdom env for *.dom.test.ts via environmentMatchGlobs"
```

---

## Task 12: Scrubber DOM component — `scrubber.ts`

**Files:**
- Create: `packages/obsidian-mk-graph/src/scrubber.ts`
- Create: `packages/obsidian-mk-graph/test/scrubber.dom.test.ts`

- [ ] **Step 12.1: Write the failing test**

Create `packages/obsidian-mk-graph/test/scrubber.dom.test.ts`:

```typescript
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createScrubber } from '../src/scrubber.js';
import type { Histogram } from '../src/density-histogram.js';

const sampleHist: Histogram = {
  unit: 'day',
  buckets: [
    { start: '2026-04-01T00:00:00Z', count: 0 },
    { start: '2026-04-02T00:00:00Z', count: 3 },
    { start: '2026-04-03T00:00:00Z', count: 1 },
  ],
};

describe('createScrubber', () => {
  it('mounts a scrubber DOM tree with the three mode buttons', () => {
    const root = document.createElement('div');
    const s = createScrubber(root, {
      fromIso: '2026-04-01T00:00:00Z',
      toIso: '2026-04-03T23:59:59Z',
      onModeChange: () => {},
      onPlayheadChange: () => {},
    });
    expect(root.querySelectorAll('.mk-graph-scrubber-mode-btn').length).toBe(3);
    expect(root.querySelector('.mk-graph-scrubber-playhead')).not.toBeNull();
    expect(root.querySelector('.mk-graph-scrubber-time')).not.toBeNull();
    s.destroy();
  });

  it('fires onModeChange with the chosen mode when a mode button is clicked', () => {
    const root = document.createElement('div');
    const onModeChange = vi.fn();
    const s = createScrubber(root, {
      fromIso: '2026-04-01T00:00:00Z',
      toIso: '2026-04-03T23:59:59Z',
      onModeChange,
      onPlayheadChange: () => {},
    });
    const buttons = root.querySelectorAll<HTMLButtonElement>('.mk-graph-scrubber-mode-btn');
    const scrubbed = Array.from(buttons).find((b) => b.dataset.mode === 'scrubbed')!;
    scrubbed.click();
    expect(onModeChange).toHaveBeenCalledWith('scrubbed');
    s.destroy();
  });

  it('renders one bar per histogram bucket on setHistogram', () => {
    const root = document.createElement('div');
    const s = createScrubber(root, {
      fromIso: '2026-04-01T00:00:00Z',
      toIso: '2026-04-03T23:59:59Z',
      onModeChange: () => {},
      onPlayheadChange: () => {},
    });
    s.setHistogram(sampleHist);
    expect(root.querySelectorAll('.mk-graph-scrubber-bar').length).toBe(3);
    s.destroy();
  });

  it('updates the time readout via setPlayhead', () => {
    const root = document.createElement('div');
    const s = createScrubber(root, {
      fromIso: '2026-04-01T00:00:00Z',
      toIso: '2026-04-03T23:59:59Z',
      onModeChange: () => {},
      onPlayheadChange: () => {},
    });
    s.setPlayhead('2026-04-02T12:00:00Z');
    const readout = root.querySelector<HTMLElement>('.mk-graph-scrubber-time');
    expect(readout!.textContent).toContain('2026-04-02');
    s.destroy();
  });

  it('destroy() removes the scrubber tree from the parent', () => {
    const root = document.createElement('div');
    const s = createScrubber(root, {
      fromIso: '2026-04-01T00:00:00Z',
      toIso: '2026-04-03T23:59:59Z',
      onModeChange: () => {},
      onPlayheadChange: () => {},
    });
    expect(root.children.length).toBeGreaterThan(0);
    s.destroy();
    expect(root.children.length).toBe(0);
  });
});
```

- [ ] **Step 12.2: Run test to verify it fails**

```bash
cd packages/obsidian-mk-graph && npx vitest run test/scrubber.dom.test.ts
```

Expected: FAIL with "Cannot find module '../src/scrubber.js'".

- [ ] **Step 12.3: Write `packages/obsidian-mk-graph/src/scrubber.ts`**

```typescript
import type { Histogram } from './density-histogram.js';

export type ReplayMode = 'live' | 'scrubbed' | 'diff';

export interface ScrubberOptions {
  fromIso: string;
  toIso: string;
  onModeChange: (mode: ReplayMode) => void;
  /** Fired with an ISO8601 timestamp as the user drags. Throttle on the
   *  callback side if needed — the slider fires on every input event. */
  onPlayheadChange: (iso: string) => void;
  initialMode?: ReplayMode;
  initialPlayheadIso?: string;
}

export interface ScrubberHandle {
  setHistogram(h: Histogram): void;
  setPlayhead(iso: string): void;
  setMode(mode: ReplayMode): void;
  destroy(): void;
}

const MODES: ReplayMode[] = ['live', 'scrubbed', 'diff'];

/**
 * Mount the scrubber overlay into `parent`. The scrubber draws:
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ [Live] [Scrubbed] [Diff]   2026-04-15T10:30:00Z              │
 *   │ ▁▁▃▅▂▁▁▃▇▅▃▁▁▁  ← density histogram                          │
 *   │ ━━━━━━●━━━━━━━━━━━━━━━━━━  ← playhead range slider           │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Returns a handle for setting state from the controller. `destroy()`
 * removes every DOM node it created and detaches its listeners.
 */
export function createScrubber(parent: HTMLElement, opts: ScrubberOptions): ScrubberHandle {
  const fromMs = Date.parse(opts.fromIso);
  const toMs = Date.parse(opts.toIso);

  const root = parent.ownerDocument.createElement('div');
  root.classList.add('mk-graph-scrubber');

  // Header row: mode buttons + time readout
  const header = root.ownerDocument.createElement('div');
  header.classList.add('mk-graph-scrubber-header');
  root.appendChild(header);

  const modeGroup = root.ownerDocument.createElement('div');
  modeGroup.classList.add('mk-graph-scrubber-modes');
  header.appendChild(modeGroup);

  const buttons = new Map<ReplayMode, HTMLButtonElement>();
  for (const mode of MODES) {
    const btn = root.ownerDocument.createElement('button');
    btn.classList.add('mk-graph-scrubber-mode-btn');
    btn.dataset.mode = mode;
    btn.textContent = mode[0].toUpperCase() + mode.slice(1);
    btn.addEventListener('click', () => {
      setActiveMode(mode);
      opts.onModeChange(mode);
    });
    modeGroup.appendChild(btn);
    buttons.set(mode, btn);
  }

  const time = root.ownerDocument.createElement('div');
  time.classList.add('mk-graph-scrubber-time');
  header.appendChild(time);

  // Histogram row
  const histRow = root.ownerDocument.createElement('div');
  histRow.classList.add('mk-graph-scrubber-histogram');
  root.appendChild(histRow);

  // Playhead slider
  const slider = root.ownerDocument.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '1000';
  slider.step = '1';
  slider.value = '1000';
  slider.classList.add('mk-graph-scrubber-playhead');
  slider.addEventListener('input', () => {
    const frac = parseInt(slider.value, 10) / 1000;
    const ms = fromMs + frac * Math.max(1, toMs - fromMs);
    const iso = new Date(ms).toISOString();
    setReadout(iso);
    opts.onPlayheadChange(iso);
  });
  root.appendChild(slider);

  parent.appendChild(root);

  function setActiveMode(mode: ReplayMode): void {
    for (const [m, btn] of buttons) {
      btn.classList.toggle('is-active', m === mode);
    }
  }

  function setReadout(iso: string): void {
    time.textContent = iso;
  }

  function setHistogram(h: Histogram): void {
    histRow.replaceChildren();
    const max = h.buckets.reduce((m, b) => Math.max(m, b.count), 1);
    for (const b of h.buckets) {
      const bar = root.ownerDocument.createElement('div');
      bar.classList.add('mk-graph-scrubber-bar');
      const heightPct = (b.count / max) * 100;
      bar.style.height = `${heightPct}%`;
      bar.title = `${b.start}: ${b.count}`;
      histRow.appendChild(bar);
    }
  }

  function setPlayhead(iso: string): void {
    const ms = Date.parse(iso);
    if (Number.isFinite(ms) && toMs > fromMs) {
      const frac = Math.min(1, Math.max(0, (ms - fromMs) / (toMs - fromMs)));
      slider.value = String(Math.round(frac * 1000));
    }
    setReadout(iso);
  }

  function setMode(mode: ReplayMode): void {
    setActiveMode(mode);
  }

  // Initial state
  setActiveMode(opts.initialMode ?? 'live');
  setReadout(opts.initialPlayheadIso ?? opts.toIso);

  function destroy(): void {
    if (root.parentNode === parent) parent.removeChild(root);
  }

  return { setHistogram, setPlayhead, setMode, destroy };
}
```

- [ ] **Step 12.4: Run test to verify it passes**

```bash
cd packages/obsidian-mk-graph && npx vitest run test/scrubber.dom.test.ts
```

Expected: PASS — 5 assertions.

- [ ] **Step 12.5: Commit**

```bash
git add packages/obsidian-mk-graph/src/scrubber.ts packages/obsidian-mk-graph/test/scrubber.dom.test.ts
git commit -m "feat(obsidian-mk-graph): add scrubber DOM overlay (modes, histogram, playhead)"
```

---

## Task 13: Replay controller — `replay-controller.ts`

**Files:**
- Create: `packages/obsidian-mk-graph/src/replay-controller.ts`
- Create: `packages/obsidian-mk-graph/test/replay-controller.test.ts`

- [ ] **Step 13.1: Write the failing test**

Create `packages/obsidian-mk-graph/test/replay-controller.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { ReplayController } from '../src/replay-controller.js';
import type { ParsedAtom } from '../src/atom-parser.js';
import type { PluginEvent } from '../src/event-parser.js';

const atom = (id: string, updatedAt = '2026-04-01T10:00:00Z'): ParsedAtom => ({
  id, type: 'fact', status: 'active', classification: 'TEAM',
  confidence: 1, createdAt: updatedAt, updatedAt, ttlDays: null,
  tags: [], relations: [], body: '',
});

const ev = (id: string, ts: string, action = 'atom_created'): PluginEvent => ({
  event_id: id, timestamp: ts, agent_id: 'a', session_id: 's',
  action,
  atom_refs: [id],
  atom_snapshot: action === 'atom_archived'
    ? undefined
    : `---\nid: ${id}\ntype: fact\nstatus: active\nclassification: TEAM\nconfidence: 1\ncreated_at: "${ts}"\nupdated_at: "${ts}"\nttl_days: null\n---\n\n`,
  schema_version: 2,
});

describe('ReplayController', () => {
  it('Live mode emits the current atom set from fallbackAtoms', () => {
    const onState = vi.fn();
    const c = new ReplayController({ onState });
    c.setEvents([ev('A', '2026-04-01T10:00:00Z'), ev('B', '2026-04-02T10:00:00Z')]);
    c.setFallbackAtoms([atom('A'), atom('B')]);
    c.setMode('live');
    expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ atoms: expect.any(Array) }));
    const last = onState.mock.calls[onState.mock.calls.length - 1][0];
    expect(last.atoms.map((a: ParsedAtom) => a.id).sort()).toEqual(['A', 'B']);
    expect(last.diff).toBeUndefined();
  });

  it('Scrubbed mode replays events to the playhead', () => {
    const onState = vi.fn();
    const c = new ReplayController({ onState });
    c.setEvents([
      ev('A', '2026-04-01T10:00:00Z'),
      ev('B', '2026-04-05T10:00:00Z'),
    ]);
    c.setMode('scrubbed');
    c.setPlayhead('2026-04-03T00:00:00Z');
    const last = onState.mock.calls[onState.mock.calls.length - 1][0];
    expect(last.atoms.map((a: ParsedAtom) => a.id)).toEqual(['A']);
  });

  it('Diff mode replays at T1 and T2 and emits a DiffSet', () => {
    const onState = vi.fn();
    const c = new ReplayController({ onState });
    c.setEvents([
      ev('A', '2026-04-01T10:00:00Z'),
      ev('B', '2026-04-05T10:00:00Z'),
      ev('A', '2026-04-10T10:00:00Z', 'atom_archived'),
    ]);
    c.setDiffRange('2026-04-02T00:00:00Z', '2026-04-15T00:00:00Z');
    c.setMode('diff');
    const last = onState.mock.calls[onState.mock.calls.length - 1][0];
    expect(last.diff).toBeDefined();
    expect([...last.diff.added]).toEqual(['B']);
    expect([...last.diff.removed]).toEqual(['A']);
  });

  it('switching mode re-emits state', () => {
    const onState = vi.fn();
    const c = new ReplayController({ onState });
    c.setEvents([ev('A', '2026-04-01T10:00:00Z')]);
    c.setFallbackAtoms([atom('A')]);
    onState.mockClear();
    c.setMode('live');
    c.setMode('scrubbed');
    expect(onState).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 13.2: Run test to verify it fails**

```bash
cd packages/obsidian-mk-graph && npx vitest run test/replay-controller.test.ts
```

Expected: FAIL with "Cannot find module '../src/replay-controller.js'".

- [ ] **Step 13.3: Write `packages/obsidian-mk-graph/src/replay-controller.ts`**

```typescript
import type { ParsedAtom } from './atom-parser.js';
import type { PluginEvent } from './event-parser.js';
import { replayEvents } from './replay-engine.js';
import { diffStates, type DiffSet } from './diff-state.js';
import type { ReplayMode } from './scrubber.js';

export interface ReplayState {
  atoms: ParsedAtom[];
  /** Set only in Diff mode. */
  diff?: DiffSet;
  /** ISO8601 the renderer should display as "as of". For Live mode this
   *  is "now" (the controller fills it with the latest event timestamp,
   *  or `undefined` if there are no events). */
  asOf?: string;
}

export interface ReplayControllerOptions {
  onState: (s: ReplayState) => void;
}

/**
 * Owns the replay-mode state machine. Inputs (events, fallback atoms,
 * mode, playhead, diff range) come from the view; output is a single
 * `ReplayState` emitted via `onState` on every change.
 *
 * Modes:
 *  - `live`: emit fallbackAtoms directly. `replayEvents` is bypassed
 *    because atom files are the live source of truth (and they're cheap
 *    to read; the view already watches them).
 *  - `scrubbed`: emit `replayEvents(events, { targetTimestamp: playhead })`.
 *    Falls back to `fallbackAtoms` for V1 events that lack snapshots.
 *  - `diff`: dual-replay at `t1` and `t2`, compute `diffStates`, emit
 *    the union of both states with the `DiffSet`.
 */
export class ReplayController {
  private events: PluginEvent[] = [];
  private fallback: ParsedAtom[] = [];
  private mode: ReplayMode = 'live';
  private playhead: string | undefined;
  private diffT1: string | undefined;
  private diffT2: string | undefined;

  constructor(private readonly opts: ReplayControllerOptions) {}

  setEvents(events: PluginEvent[]): void { this.events = events; this.emit(); }
  setFallbackAtoms(atoms: ParsedAtom[]): void { this.fallback = atoms; this.emit(); }
  setMode(mode: ReplayMode): void { this.mode = mode; this.emit(); }
  setPlayhead(iso: string): void { this.playhead = iso; this.emit(); }
  setDiffRange(t1: string, t2: string): void { this.diffT1 = t1; this.diffT2 = t2; this.emit(); }

  /** Snapshot the current state without emitting (used by tests). */
  current(): ReplayState { return this.compute(); }

  private emit(): void {
    this.opts.onState(this.compute());
  }

  private compute(): ReplayState {
    if (this.mode === 'live') {
      return { atoms: this.fallback, asOf: this.lastEventTs() };
    }

    if (this.mode === 'scrubbed') {
      const target = this.playhead ?? this.lastEventTs();
      const map = replayEvents(this.events, {
        targetTimestamp: target,
        fallbackAtoms: this.fallback,
      });
      return { atoms: [...map.values()], asOf: target };
    }

    // diff
    const t1 = this.diffT1;
    const t2 = this.diffT2;
    if (!t1 || !t2) {
      // Diff range not set yet — render empty state rather than crash.
      return { atoms: [], asOf: undefined };
    }
    const prev = replayEvents(this.events, { targetTimestamp: t1, fallbackAtoms: this.fallback });
    const next = replayEvents(this.events, { targetTimestamp: t2, fallbackAtoms: this.fallback });
    const diff = diffStates(prev, next);
    return { atoms: diff.union(), diff, asOf: t2 };
  }

  private lastEventTs(): string | undefined {
    if (this.events.length === 0) return undefined;
    let max = this.events[0].timestamp;
    for (const e of this.events) {
      if (e.timestamp > max) max = e.timestamp;
    }
    return max;
  }
}
```

- [ ] **Step 13.4: Run test to verify it passes**

```bash
cd packages/obsidian-mk-graph && npx vitest run test/replay-controller.test.ts
```

Expected: PASS — 4 assertions.

- [ ] **Step 13.5: Commit**

```bash
git add packages/obsidian-mk-graph/src/replay-controller.ts packages/obsidian-mk-graph/test/replay-controller.test.ts
git commit -m "feat(obsidian-mk-graph): add replay controller (Live/Scrubbed/Diff state machine)"
```

---

## Task 14: Settings additions

**Files:**
- Modify: `packages/obsidian-mk-graph/src/settings.ts`

- [ ] **Step 14.1: Read the current `MkGraphSettings` interface**

```bash
sed -n '1,60p' packages/obsidian-mk-graph/src/settings.ts
```

The fields you'll add: `liveModeOnStartup` (boolean), `lastScrubbedAt` (string | null), `defaultLayout` widens to `'force' | 'timeline'`, `showScrubber` (boolean).

- [ ] **Step 14.2: Edit the `MkGraphSettings` interface**

In `packages/obsidian-mk-graph/src/settings.ts`, edit the interface and `DEFAULT_SETTINGS` to widen `defaultLayout` and add the four new fields. Replace the interface block (lines starting at `export interface MkGraphSettings`) with:

```typescript
export interface MkGraphSettings {
  /** Path to memory-kernel root dir. Relative paths resolve under the vault. */
  memoryDir: string;
  /** When true, memoryDir may be an absolute path outside the vault. */
  memoryDirOutsideVault: boolean;
  /** Empty string = shared mode (intentional and meaningful). Otherwise
   *  routed via agents/<id>/. The data loader rejects path-separator and
   *  dot-segment IDs at read time; the SettingTab also warns the user
   *  inline so they see why their agent isn't loading. */
  agentId: string;
  /** Phase 3 widens this from `'force'` to include `'timeline'`. Phase 4
   *  will add `'radial-wander'`. */
  defaultLayout: 'force' | 'timeline';
  /** F2 channel toggles — fill (color by type) is always on. */
  nodeChannels: NodeChannels;
  /** Hard cap on nodes rendered before graceful degrade kicks in. */
  maxNodesShown: number;
  /** Show the F2-encoding legend overlay in the graph view. */
  showLegend: boolean;
  /** Show the scrubber overlay (mode buttons + histogram + playhead). */
  showScrubber: boolean;
  /** Default replay mode on view-open. Spec §H1: true until the user
   *  scrubs once; thereafter `false` so we restore `lastScrubbedAt`. */
  liveModeOnStartup: boolean;
  /** ISO8601 last scrubbed-to timestamp. Restored on view-open when
   *  `liveModeOnStartup === false`. Null until the user scrubs once. */
  lastScrubbedAt: string | null;
}
```

And replace `DEFAULT_SETTINGS`:

```typescript
export const DEFAULT_SETTINGS: MkGraphSettings = {
  memoryDir: '.mk',
  memoryDirOutsideVault: false,
  agentId: '',
  defaultLayout: 'force',
  nodeChannels: { border: true, opacity: true, size: true },
  maxNodesShown: 5000,
  showLegend: true,
  showScrubber: true,
  liveModeOnStartup: true,
  lastScrubbedAt: null,
};
```

- [ ] **Step 14.3: Add settings UI rows for the new fields**

Find the `MkGraphSettingTab.display()` method in `settings.ts`. Append the following rows after the existing `showLegend` row (or in the closest equivalent UI grouping):

```typescript
new Setting(containerEl)
  .setName('Show scrubber')
  .setDesc('Display the bottom-of-view scrubber with mode buttons and event-density histogram.')
  .addToggle((t) =>
    t.setValue(this.host.settings.showScrubber).onChange(async (v) => {
      this.host.settings.showScrubber = v;
      await this.host.saveSettings();
    }),
  );

new Setting(containerEl)
  .setName('Default layout')
  .setDesc('Graph layout used when the view opens. Force-directed packs nodes by relation; timeline maps the X axis to created_at, Y to atom type.')
  .addDropdown((dd) =>
    dd
      .addOption('force', 'Force-directed')
      .addOption('timeline', 'Timeline')
      .setValue(this.host.settings.defaultLayout)
      .onChange(async (v) => {
        this.host.settings.defaultLayout = (v as MkGraphSettings['defaultLayout']);
        await this.host.saveSettings();
      }),
  );

new Setting(containerEl)
  .setName('Live mode on startup')
  .setDesc('Open the view in Live mode. When off, the view restores your last-scrubbed timestamp instead.')
  .addToggle((t) =>
    t.setValue(this.host.settings.liveModeOnStartup).onChange(async (v) => {
      this.host.settings.liveModeOnStartup = v;
      await this.host.saveSettings();
    }),
  );
```

- [ ] **Step 14.4: Verify the settings file still type-checks**

```bash
cd packages/obsidian-mk-graph && npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 14.5: Commit**

```bash
git add packages/obsidian-mk-graph/src/settings.ts
git commit -m "feat(obsidian-mk-graph): add scrubber + timeline-layout + live-mode-on-startup settings"
```

---

## Task 15: Renderer accepts layout + diff options

**Files:**
- Modify: `packages/obsidian-mk-graph/src/renderer.ts`

- [ ] **Step 15.1: Read the current `RendererOpts` and `createRenderer` signatures**

```bash
sed -n '20,90p' packages/obsidian-mk-graph/src/renderer.ts
```

You're adding two optional fields to `RendererOpts`: `layout: LayoutKind` and `diff: DiffSet | undefined`. The handle gets two new methods: `setLayout(kind)` and `setDiff(diff | undefined)`.

- [ ] **Step 15.2: Update `RendererOpts` and `RendererHandle` in `renderer.ts`**

Add imports at the top (alongside the existing imports):

```typescript
import { applyLayout, type LayoutKind } from './layout.js';
import { diffNodeColor, diffNodeOpacity, diffEdgeColor } from './diff-overlay.js';
import type { DiffSet } from './diff-state.js';
```

Replace the `RendererOpts` interface with:

```typescript
export interface RendererOpts {
  state: GraphState;
  settings: MkGraphSettings;
  onNodeClick: (atom: ParsedAtom) => void;
  /** Initial layout. Defaults to settings.defaultLayout. */
  layout?: LayoutKind;
  /** Visible time range used by the timeline layout. Falls back to
   *  the createdAt min/max of the loaded atoms when omitted. */
  fromIso?: string;
  toIso?: string;
  /** When set, renders in Diff mode with overlay colors. */
  diff?: DiffSet;
}
```

Replace `RendererHandle`:

```typescript
export interface RendererHandle {
  setLayout(kind: LayoutKind, fromIso?: string, toIso?: string): void;
  setDiff(diff: DiffSet | undefined): void;
  destroy(): void;
}
```

- [ ] **Step 15.3: Wire layout + diff into the render path**

Inside `createRenderer`, after the force-graph instance (`fg`) is constructed but before the first `state.subscribe`, add:

```typescript
let currentLayout: LayoutKind = opts.layout ?? opts.settings.defaultLayout ?? 'force';
let currentFromIso: string | undefined = opts.fromIso;
let currentToIso: string | undefined = opts.toIso;
let currentDiff: DiffSet | undefined = opts.diff;

function rangeFromAtoms(atoms: ParsedAtom[]): { from: string; to: string } {
  if (atoms.length === 0) {
    const now = new Date().toISOString();
    return { from: now, to: now };
  }
  let min = atoms[0].createdAt;
  let max = atoms[0].createdAt;
  for (const a of atoms) {
    if (a.createdAt < min) min = a.createdAt;
    if (a.createdAt > max) max = a.createdAt;
  }
  return { from: min, to: max };
}

function applyCurrentLayout(): void {
  const data = opts.state.toGraphData();
  const fallback = rangeFromAtoms(data.nodes);
  const fromIso = currentFromIso ?? fallback.from;
  const toIso = currentToIso ?? fallback.to;
  const rect = container.getBoundingClientRect();
  applyLayout(data.nodes, {
    kind: currentLayout,
    width: Math.max(100, rect.width),
    height: Math.max(100, rect.height),
    fromIso,
    toIso,
  });
  fg.graphData(data);
  // Force layout: warm the simulation. Timeline: freeze.
  if (currentLayout === 'force') {
    fg.cooldownTicks(Infinity).d3AlphaDecay(0.0228).resumeAnimation?.();
  } else {
    fg.cooldownTicks(0).pauseAnimation?.();
  }
}
```

- [ ] **Step 15.4: Replace the existing `state.subscribe(...)` body to call `applyCurrentLayout()`**

Find the existing `state.subscribe(() => { fg.graphData(state.toGraphData()); ... })` block in `renderer.ts`. Replace its body with:

```typescript
const unsubscribe = opts.state.subscribe(() => {
  applyCurrentLayout();
});
applyCurrentLayout(); // initial render
```

- [ ] **Step 15.5: Patch the node-color / node-opacity / link-color callbacks to honour `currentDiff`**

Where the renderer currently sets `fg.nodeColor((n) => f2NodeColor(n))` (or similar), wrap with the diff-aware variant:

```typescript
fg.nodeColor((n: GraphNode) => {
  const base = f2NodeColor(n);
  if (!currentDiff) return base;
  return diffNodeColor(currentDiff.classify(n.id), base);
});

fg.nodeOpacity?.((n: GraphNode) => {
  const base = f2NodeOpacity(n, opts.settings);
  if (!currentDiff) return base;
  return diffNodeOpacity(currentDiff.classify(n.id), base);
});

fg.linkColor((l: GraphLink) => {
  const base = f2EdgeColor(l);
  if (!currentDiff) return base;
  const sId = typeof l.source === 'string' ? l.source : (l.source as GraphNode).id;
  const tId = typeof l.target === 'string' ? l.target : (l.target as GraphNode).id;
  return diffEdgeColor(currentDiff.classify(sId), currentDiff.classify(tId), base);
});
```

(If `f2NodeOpacity` already takes only `(node)` in the existing renderer, omit the `opts.settings` argument — the diff wrapper just adapts whatever signature is already there.)

- [ ] **Step 15.6: Add `setLayout` and `setDiff` to the returned handle**

Locate the `return { destroy: ... }` at the bottom of `createRenderer`. Replace it with:

```typescript
return {
  setLayout(kind: LayoutKind, fromIso?: string, toIso?: string): void {
    currentLayout = kind;
    currentFromIso = fromIso;
    currentToIso = toIso;
    applyCurrentLayout();
  },
  setDiff(diff: DiffSet | undefined): void {
    currentDiff = diff;
    // Trigger a re-paint without a graphData rebuild — force-graph reads
    // nodeColor/linkColor on the next animation frame.
    fg.refresh?.() ?? fg.graphData(opts.state.toGraphData());
  },
  destroy(): void {
    unsubscribe();
    /* existing destroy logic — overlay layer cleanup, ResizeObserver, etc. */
  },
};
```

(Preserve the existing destroy body — only the surrounding object literal changes.)

- [ ] **Step 15.7: Type-check**

```bash
cd packages/obsidian-mk-graph && npx tsc --noEmit
```

Expected: 0 errors. If `force-graph`'s typings complain about `pauseAnimation` or `refresh`, the project already uses `any` for the `fg` handle (see Phase 2 renderer head); keep that pattern.

- [ ] **Step 15.8: Run all tests to confirm Phase 2 tests still pass**

```bash
cd packages/obsidian-mk-graph && npm test
```

Expected: full suite green.

- [ ] **Step 15.9: Commit**

```bash
git add packages/obsidian-mk-graph/src/renderer.ts
git commit -m "feat(obsidian-mk-graph): renderer accepts layout + diff options, adds setLayout/setDiff"
```

---

## Task 16: View wires the controller, scrubber, and renderer together

**Files:**
- Modify: `packages/obsidian-mk-graph/src/view.ts`
- Modify: `packages/obsidian-mk-graph/src/data-loader.ts`
- Modify: `packages/obsidian-mk-graph/src/main.ts`

- [ ] **Step 16.1: Export `watchEvents` re-export from `data-loader.ts`**

So callers can import everything from one place. At the end of `packages/obsidian-mk-graph/src/data-loader.ts`, add:

```typescript
export { watchEvents } from './events-loader.js';
export { readEvents } from './events-loader.js';
```

- [ ] **Step 16.2: Edit `packages/obsidian-mk-graph/src/view.ts`**

At the top, replace the existing imports with:

```typescript
import { ItemView, Notice, WorkspaceLeaf, normalizePath, type App } from 'obsidian';
import path from 'node:path';
import { GraphState } from './graph-state.js';
import {
  readVault,
  watchVault,
  resolveMemoryDir,
  readEvents,
  watchEvents,
  type Watcher,
} from './data-loader.js';
import { createRenderer, type RendererHandle } from './renderer.js';
import type { MkGraphSettings } from './settings.js';
import type { ParsedAtom } from './atom-parser.js';
import { ReplayController } from './replay-controller.js';
import { createScrubber, type ScrubberHandle, type ReplayMode } from './scrubber.js';
import { computeHistogram } from './density-histogram.js';
import type { EventsWatcher } from './events-loader.js';
import type { PluginEvent } from './event-parser.js';
```

Inside the `MkGraphView` class, add new private fields next to `state`, `renderer`, `watcher`:

```typescript
private eventsWatcher: EventsWatcher | null = null;
private scrubber: ScrubberHandle | null = null;
private controller: ReplayController | null = null;
private events: PluginEvent[] = [];
```

Replace the `onOpen` method body with:

```typescript
async onOpen(): Promise<void> {
  const container = this.containerEl.children[1] as HTMLElement;
  container.empty();
  container.classList.add('mk-graph-view-container');

  this.controller = new ReplayController({
    onState: (s) => {
      this.state.replace(s.atoms);
      this.renderer?.setDiff(s.diff);
      if (this.scrubber && s.asOf) this.scrubber.setPlayhead(s.asOf);
    },
  });

  const initialMode: ReplayMode = this.host.settings.liveModeOnStartup ? 'live' : 'scrubbed';
  this.controller.setMode(initialMode);

  this.renderer = createRenderer(container, {
    state: this.state,
    settings: this.host.settings,
    onNodeClick: (atom) => this.openAtom(atom),
    layout: this.host.settings.defaultLayout,
  });

  if (this.host.settings.showScrubber) {
    const scrubberHost = container.ownerDocument.createElement('div');
    scrubberHost.classList.add('mk-graph-scrubber-host');
    container.appendChild(scrubberHost);
    this.scrubber = createScrubber(scrubberHost, {
      fromIso: '1970-01-01T00:00:00Z',
      toIso: new Date().toISOString(),
      initialMode,
      initialPlayheadIso: this.host.settings.lastScrubbedAt ?? new Date().toISOString(),
      onModeChange: (mode) => this.handleModeChange(mode),
      onPlayheadChange: (iso) => this.handlePlayheadChange(iso),
    });
  }

  await this.reloadFromDisk();

  const memDir = this.resolveMemoryDirAbsolute();
  if (memDir) {
    this.watcher = watchVault(memDir, () => { void this.reloadFromDisk(); });
    this.eventsWatcher = watchEvents(memDir, () => { void this.reloadEvents(); });
  }
}
```

Replace the `onClose` method body with:

```typescript
async onClose(): Promise<void> {
  if (this.watcher) { this.watcher.close(); this.watcher = null; }
  if (this.eventsWatcher) { this.eventsWatcher.close(); this.eventsWatcher = null; }
  if (this.scrubber) { this.scrubber.destroy(); this.scrubber = null; }
  if (this.renderer) { this.renderer.destroy(); this.renderer = null; }
  this.controller = null;
}
```

Replace the existing `reloadFromDisk` method with:

```typescript
async reloadFromDisk(): Promise<void> {
  try {
    const memDir = this.resolveMemoryDirAbsolute();
    if (!memDir) {
      this.controller?.setFallbackAtoms([]);
      this.controller?.setEvents([]);
      this.events = [];
      return;
    }
    const [atoms, events] = await Promise.all([readVault(memDir), readEvents(memDir)]);
    this.events = events;
    this.controller?.setFallbackAtoms(atoms);
    this.controller?.setEvents(events);
    if (this.scrubber && events.length > 0) {
      const from = events[0].timestamp;
      const to = events[events.length - 1].timestamp;
      const hist = computeHistogram(events, from, to);
      this.scrubber.setHistogram(hist);
    }
  } catch (err) {
    console.warn('mk-graph: reloadFromDisk failed', err);
    this.controller?.setFallbackAtoms([]);
    this.controller?.setEvents([]);
  }
}
```

Add a helper alongside `reloadFromDisk`:

```typescript
private async reloadEvents(): Promise<void> {
  const memDir = this.resolveMemoryDirAbsolute();
  if (!memDir) return;
  const events = await readEvents(memDir);
  this.events = events;
  this.controller?.setEvents(events);
  if (this.scrubber && events.length > 0) {
    const from = events[0].timestamp;
    const to = events[events.length - 1].timestamp;
    this.scrubber.setHistogram(computeHistogram(events, from, to));
  }
}

private handleModeChange(mode: ReplayMode): void {
  this.controller?.setMode(mode);
  if (mode === 'scrubbed' || mode === 'diff') {
    // First scrub flips the user out of "always-live on startup".
    if (this.host.settings.liveModeOnStartup) {
      this.host.settings.liveModeOnStartup = false;
      void this.host.saveSettings();
    }
  }
}

private handlePlayheadChange(iso: string): void {
  this.controller?.setPlayhead(iso);
  this.host.settings.lastScrubbedAt = iso;
  void this.host.saveSettings();
}
```

- [ ] **Step 16.3: Add commands to `main.ts`**

In `packages/obsidian-mk-graph/src/main.ts`, append these inside `onload()` after the existing `addCommand` blocks:

```typescript
this.addCommand({
  id: 'mk-graph-toggle-live-scrubbed',
  name: 'Toggle Live / Scrubbed mode',
  checkCallback: (checking) => {
    const view = this.getActiveGraphView();
    if (!view) return false;
    if (!checking) view.toggleLiveScrubbed();
    return true;
  },
});
```

In `view.ts`, add the public method that command relies on:

```typescript
/** Public — invoked by the "Toggle Live / Scrubbed mode" command. */
toggleLiveScrubbed(): void {
  if (!this.controller) return;
  // Read current mode by looking at the scrubber state — the controller
  // doesn't expose `mode`, but the scrubber's active button is the source
  // of UI truth. Default to scrubbed when no scrubber is mounted.
  const active = this.scrubber
    ? (this.containerEl.querySelector('.mk-graph-scrubber-mode-btn.is-active') as HTMLButtonElement | null)
    : null;
  const next: ReplayMode = active?.dataset.mode === 'live' ? 'scrubbed' : 'live';
  this.handleModeChange(next);
  this.scrubber?.setMode(next);
}
```

- [ ] **Step 16.4: Type-check**

```bash
cd packages/obsidian-mk-graph && npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 16.5: Run all tests**

```bash
cd packages/obsidian-mk-graph && npm test
```

Expected: full suite green. View / main are not unit-tested directly — the smoke checklist in Task 18 covers them.

- [ ] **Step 16.6: Commit**

```bash
git add packages/obsidian-mk-graph/src/view.ts packages/obsidian-mk-graph/src/main.ts packages/obsidian-mk-graph/src/data-loader.ts
git commit -m "feat(obsidian-mk-graph): wire ReplayController + scrubber + events watcher into the view"
```

---

## Task 17: Scrubber styles

**Files:**
- Modify: `packages/obsidian-mk-graph/styles.css`

- [ ] **Step 17.1: Append scrubber styles to `styles.css`**

```css
/* --- Phase 3: scrubber overlay --- */

.mk-graph-scrubber-host {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 92px;
  pointer-events: auto;
  z-index: 9998; /* below tooltip (9999) but above the canvas */
}

.mk-graph-scrubber {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 8px 12px;
  background: var(--background-primary-alt, rgba(20, 20, 24, 0.85));
  border-top: 1px solid var(--background-modifier-border, rgba(255, 255, 255, 0.1));
  font-size: 12px;
  gap: 4px;
}

.mk-graph-scrubber-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.mk-graph-scrubber-modes {
  display: flex;
  gap: 4px;
}

.mk-graph-scrubber-mode-btn {
  padding: 2px 10px;
  border: 1px solid var(--background-modifier-border, #444);
  background: transparent;
  color: var(--text-muted, #aaa);
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
  line-height: 1.4;
}

.mk-graph-scrubber-mode-btn.is-active {
  background: var(--interactive-accent, #3b82f6);
  color: var(--text-on-accent, #fff);
  border-color: transparent;
}

.mk-graph-scrubber-time {
  font-family: var(--font-monospace, monospace);
  font-size: 11px;
  color: var(--text-muted, #aaa);
}

.mk-graph-scrubber-histogram {
  display: flex;
  align-items: flex-end;
  height: 28px;
  gap: 1px;
}

.mk-graph-scrubber-bar {
  flex: 1 1 0;
  min-width: 1px;
  background: var(--text-faint, rgba(255, 255, 255, 0.25));
  border-radius: 1px;
  transition: background-color 100ms;
}

.mk-graph-scrubber-bar:hover {
  background: var(--interactive-accent, #3b82f6);
}

.mk-graph-scrubber-playhead {
  width: 100%;
  margin: 0;
}
```

- [ ] **Step 17.2: Commit**

```bash
git add packages/obsidian-mk-graph/styles.css
git commit -m "style(obsidian-mk-graph): add scrubber overlay styles"
```

---

## Task 18: Update SMOKE_TEST.md with Phase 3 walks

**Files:**
- Modify: `packages/obsidian-mk-graph/SMOKE_TEST.md`

- [ ] **Step 18.1: Read the existing file to find the insertion point**

```bash
tail -40 packages/obsidian-mk-graph/SMOKE_TEST.md
```

You're appending walks S5–S9 at the end (S1–S4 already cover Phase 2 paths).

- [ ] **Step 18.2: Append walks to `SMOKE_TEST.md`**

```markdown

## Phase 3 walks (introduced in v0.2.0)

### S5: scrubber renders with histogram

1. Build & install the plugin: `npm run build` in `packages/obsidian-mk-graph/`, copy `main.js`, `manifest.json`, `styles.css` into `<vault>/.obsidian/plugins/obsidian-mk-graph/`.
2. Hard-reload Obsidian (`Cmd+Shift+R` / `Ctrl+Shift+R`) — the plugin-bundle cache trap from v0.1.8 still applies.
3. Open the Memory Kernel Graph view.
4. **Expect:** a scrubber appears at the bottom of the view with three buttons (Live / Scrubbed / Diff), an event-density histogram (gray bars, taller bars = more events that day), and a playhead range slider. The "Live" button is highlighted.

### S6: scrubbed mode freezes the graph at T

1. Click "Scrubbed".
2. Drag the playhead leftwards.
3. **Expect:** the time readout updates as you drag. Atoms whose `created_at` is later than the playhead disappear from the graph. Releasing the mouse leaves the graph at the chosen T.
4. Drag back to the far right.
5. **Expect:** all atoms are restored.

### S7: live mode reflects new atoms

1. Switch back to "Live" mode.
2. In a separate terminal, append a new atom to the memory dir: `mk add fact "smoke test S7" --memory-dir <vault>/.mk`.
3. **Expect:** within ~250ms, the new atom appears in the graph. The histogram gains a bar for the current day (or the height of today's bar increases).

### S8: diff mode shows added/removed/mutated

1. Click "Diff". Set the diff range to span the last archive event (Phase 3 ships with two fixture archives at 2026-04-26).
2. **Expect:** the two archived atoms render in red (ghost opacity), any atoms created within the range render in green, the one updated atom (atoms[10] from the fixture) renders in amber. Edges connecting an added or removed node take the same color.

### S9: timeline layout

1. Switch to "Force-directed" → "Timeline" via the layout dropdown in plugin settings (or the layout toggle if present in the view header).
2. **Expect:** atoms snap to a left-to-right timeline: oldest on the left, newest on the right. Vertical bands separate atom types — facts at the top, conflicts at the bottom. Edges are straight lines. The force simulation is paused (no jitter).
3. Switch back to "Force-directed".
4. **Expect:** atoms unsnap; the simulation resumes packing them by relation.
```

- [ ] **Step 18.3: Commit**

```bash
git add packages/obsidian-mk-graph/SMOKE_TEST.md
git commit -m "docs(obsidian-mk-graph): add S5–S9 smoke walks for scrubber + modes + timeline"
```

---

## Task 19: README, CHANGELOG, version bump to 0.2.0

**Files:**
- Modify: `packages/obsidian-mk-graph/manifest.json`
- Modify: `packages/obsidian-mk-graph/package.json`
- Modify: `packages/obsidian-mk-graph/CHANGELOG.md`
- Modify: `packages/obsidian-mk-graph/README.md`

- [ ] **Step 19.1: Bump `manifest.json`**

In `packages/obsidian-mk-graph/manifest.json`, change `"version": "0.1.10"` → `"version": "0.2.0"`.

- [ ] **Step 19.2: Bump `package.json`**

In `packages/obsidian-mk-graph/package.json`, change `"version": "0.1.10"` → `"version": "0.2.0"`. Also add `jsdom` and `@types/jsdom` to `devDependencies` if Task 11.1 didn't already (it should have).

- [ ] **Step 19.3: Regenerate package-lock**

```bash
cd packages/obsidian-mk-graph && npm install --package-lock-only
```

- [ ] **Step 19.4: Add the v0.2.0 CHANGELOG entry**

Prepend to `packages/obsidian-mk-graph/CHANGELOG.md` (above the `## [0.1.10]` header):

```markdown
## [0.2.0] — 2026-05-03

### Added — Replay + timeline (Phase 3)
- **Three replay modes** via a new scrubber overlay at the bottom of the graph view.
  - **Live** (default): file watcher tails `events.ndjson`; new atoms animate in.
  - **Scrubbed**: graph frozen at a chosen timestamp T. Drag the playhead to reconstruct historical state.
  - **Diff**: pick T1 and T2; added atoms render green, removed atoms ghost out in red, mutated atoms render amber. Edges follow their endpoints.
- **Event-density histogram** in the scrubber — bar per day (≤60-day range), week (≤365 days), or month (longer ranges) with `count` of mutation events per bucket.
- **Timeline layout** — X = `created_at` mapped to view width, Y = type-stratified bands (fact→conflict ordering). Pinned positions (`fx`/`fy`) freeze the simulation. Toggle via the new "Default layout" setting.
- Settings: `showScrubber` (default on), `defaultLayout` (`force` | `timeline`), `liveModeOnStartup` (default on; flips off after the first scrub), `lastScrubbedAt` (auto-persisted on every playhead change).
- Commands: "Toggle Live / Scrubbed mode" command-palette entry.

### Architecture
- Pure `replayEvents(events, opts?)` engine reconstructs `Map<id, ParsedAtom>` deterministically from `events.ndjson`. V2 events use `event.atom_snapshot`; V1 events without snapshots fall back to current atom files (best-effort proxy for historical content).
- New module split: `event-parser.ts` (NDJSON line → PluginEvent), `events-loader.ts` (read + tail-watch), `replay-engine.ts` (events → atom map at T), `diff-state.ts` (DiffSet computation), `density-histogram.ts` (bucketing), `timeline-layout.ts` (timeline positions), `layout.ts` (force/timeline dispatch), `scrubber.ts` (DOM overlay), `replay-controller.ts` (mode + playhead state machine), `diff-overlay.ts` (color encoders), `atom-types.ts` (canonical type ordering).
- Renderer extended with `setLayout(kind, fromIso?, toIso?)` and `setDiff(diff | undefined)` — keeps the F2 baseline encoders pure and overlays diff colors on top.

### Tests
- vitest: 60+ new assertions across 10 new test files (event-parser, events-loader, replay-engine, diff-state, density-histogram, timeline-layout, layout, diff-overlay, scrubber.dom, replay-controller).
- jsdom environment added via `environmentMatchGlobs` for `*.dom.test.ts`.
- Fixture `events.ndjson` (23 events: 20 created + 1 updated + 2 archived) drives integration tests.

### Known caveats
- V1 events (no snapshot) replay using current atom-file content — historical scrub may show present-day content for atoms created before the V2 snapshot rollout.
- SECRET atoms render via current atom-file fallback in scrubbed/diff modes (no in-plugin decryption); when `MEMORY_ENCRYPTION_KEY` is unset, SECRET atoms appear with their redacted body, same as in Live mode.
- The plugin still does not shell out to `mk` — wander viz arrives in v0.3 (Phase 4) and brings `MkCliRunner` with it.
```

- [ ] **Step 19.5: Update README**

In `packages/obsidian-mk-graph/README.md`, find the "Features" or feature-bullet section. Add these bullets:

```markdown
- **Time-aware exploration (Phase 3)** — three modes via the bottom scrubber: **Live** (file-watcher tail), **Scrubbed** (graph frozen at T), **Diff** (T1↔T2 with added/removed/mutated highlighting).
- **Event-density histogram** above the playhead — at-a-glance "where the activity is" view of your memory log.
- **Timeline layout** — X axis maps to `created_at`, Y axis stratifies by atom type. Toggle via plugin settings.
```

If a "Settings" subsection lists individual settings, add `showScrubber`, `defaultLayout`, `liveModeOnStartup`, `lastScrubbedAt` rows.

- [ ] **Step 19.6: Build the plugin to confirm bundling still works**

```bash
cd packages/obsidian-mk-graph && npm run build
```

Expected: `main.js` is regenerated. No esbuild errors.

- [ ] **Step 19.7: Run the full test suite one more time**

```bash
cd packages/obsidian-mk-graph && npm test
```

Expected: all green.

- [ ] **Step 19.8: Commit**

```bash
git add packages/obsidian-mk-graph/manifest.json packages/obsidian-mk-graph/package.json packages/obsidian-mk-graph/package-lock.json packages/obsidian-mk-graph/CHANGELOG.md packages/obsidian-mk-graph/README.md packages/obsidian-mk-graph/main.js
git commit -m "chore(obsidian-mk-graph): release v0.2.0 — replay + timeline (Phase 3)"
```

- [ ] **Step 19.9: Tag the release**

The plugin's manifest version is independent of mk-core (CLAUDE.md convention). Tag it with the package-scoped form so it doesn't collide with mk-core's `v1.x.x` tags:

```bash
git tag obsidian-mk-graph-v0.2.0
```

Push happens via the normal PR + merge flow — not in this plan.

---

## Task 20: Verify the full file tree, run smoke checklist, hand off

**Files:**
- (no code changes — this is a final verification gate)

- [ ] **Step 20.1: Confirm every Phase 3 file is present**

```bash
ls -1 packages/obsidian-mk-graph/src | sort
ls -1 packages/obsidian-mk-graph/test | sort
```

Expected new files in `src/`: `atom-types.ts`, `event-parser.ts`, `events-loader.ts`, `replay-engine.ts`, `diff-state.ts`, `density-histogram.ts`, `timeline-layout.ts`, `layout.ts`, `scrubber.ts`, `replay-controller.ts`, `diff-overlay.ts`.

Expected new files in `test/`: matching `*.test.ts` for each plus `scrubber.dom.test.ts`.

- [ ] **Step 20.2: Run the full test suite**

```bash
cd packages/obsidian-mk-graph && npm test
```

Expected: all green. Note the assertion count in your handoff message — Phase 2 baseline + ~60 new ≈ ~110 total.

- [ ] **Step 20.3: Walk S5–S9 from `SMOKE_TEST.md` against a fresh build**

This is a manual gate. The plan does not pass without all five smoke walks succeeding. Document any deviations in a follow-up CHANGELOG patch (e.g., a v0.2.1 fix).

- [ ] **Step 20.4: Open a PR**

```bash
git push -u origin <branch-name>
gh pr create --title "obsidian-mk-graph v0.2.0 — replay + timeline (Phase 3)" --body "$(cat <<'EOF'
## Summary
- Adds the Phase 3 deliverables from [docs/superpowers/specs/2026-04-28-obsidian-mk-graph-design.md](docs/superpowers/specs/2026-04-28-obsidian-mk-graph-design.md): events.ndjson replay engine, three replay modes (Live / Scrubbed / Diff), scrubber overlay with event-density histogram, timeline layout.
- Pure-logic modules (replay-engine, diff-state, timeline-layout, density-histogram, diff-overlay) covered by vitest; scrubber covered by jsdom DOM tests.
- Plugin-only — no mk-core changes in this phase. v0.3 (Phase 4) brings the `mk` subprocess for wander viz.

## Test plan
- [ ] `npm test` in `packages/obsidian-mk-graph/` — all tests pass
- [ ] Smoke walks S5–S9 from `SMOKE_TEST.md` pass against a hard-reloaded Obsidian instance
- [ ] BRAT install of v0.2.0 from a tagged commit on a clean vault renders the fixture vault correctly in all three modes
EOF
)"
```

---

## Self-review

After writing the plan above, here's the spec-coverage check (spec §3, §5, §6 phase 3 row):

**Spec §3.1 data flow → covered:**
- DataLoader reads atom files + events.ndjson → `data-loader.ts` (existing) + `events-loader.ts` (Task 4).
- ReplayEngine events→T → `replay-engine.ts` (Task 5).
- GraphState reactive map → unchanged (Phase 2 already fits).
- LayoutEngine pluggable → `layout.ts` + `timeline-layout.ts` (Tasks 8–9).
- Renderer wraps force-graph with F2/F3 → renderer extended in Task 15.
- ScrubberUI bottom-of-view → `scrubber.ts` (Task 12).

**Spec §5.1 settings → covered:**
- `liveModeOnStartup`, `lastScrubbedAt`, `defaultLayout` (now `force | timeline`) — Task 14.
- `showScrubber` added as a UX courtesy (not in spec but spec implies a toggle).

**Spec §5.3 timeline layout → covered:**
- X = `created_at` mapped to view width — `timeline-layout.ts` Task 8.
- Y = 9 horizontal type bands + jitter — `atom-types.ts` Task 1 + `timeline-layout.ts`.
- Bézier edges for timeline — **deferred**: not in v1 acceptance criteria (§10), straight lines are sufficient. Documented as out-of-scope at the top of this plan? **No — gap. Adding follow-up note.**

**Spec §5.5 replay UX → covered:**
- Scrubber, density histogram, mode toggle, "as of" timestamp — Task 12 + Task 16 wiring.
- Live / Scrubbed / Diff — `replay-controller.ts` Task 13.
- File watcher pause in Scrubbed/Diff — wiring in Task 16 leaves the watcher running and just suppresses the controller's reactive emission via mode dispatch. **Acceptable**: the watcher fires a `reloadEvents()`, which calls `controller.setEvents()`; `compute()` for `scrubbed` recomputes from the larger event log but only emits atoms ≤ playhead. The user perception ("graph frozen") holds.
- Initial state: `liveModeOnStartup` true on first run; flips false after first scrub via `handleModeChange` in Task 16.

**Spec §6 phase 3 row → covered:**
- events.ndjson ingestion ✅
- ReplayEngine ✅
- scrubber UX (Live/Scrubbed/Diff) ✅
- timeline layout ✅
- density histogram ✅

**Gap fix — Bézier curves for timeline edges:** the spec says "Edges drawn as cubic Bézier curves" but force-graph's default link rendering is straight; a custom curvature requires `linkCurvature` plus a per-link curvature value. Adding a follow-up note rather than expanding the plan: edge curvature is a v0.2.1 polish — track in `Out of scope for this phase` and the Phase 5 CHANGELOG.

(Adding this clarification by re-opening the file structure block and Out-of-scope list is unnecessary churn — recording it here in the self-review is the artefact.)

**Placeholder scan:** No "TBD", "TODO", "implement later", or vague "add appropriate error handling" instructions in any task. Every code step shows real code.

**Type consistency:** `PluginEvent`, `ParsedAtom`, `DiffSet`, `DiffTag`, `ReplayMode`, `LayoutKind`, `Histogram`, `RendererHandle`, `ScrubberHandle`, `EventsWatcher` — names are stable across all tasks that reference them.

---

## Out of scope follow-ups (Phase 4/5 inputs)

- Bézier-curve link rendering in timeline layout (deferred — straight lines render correctly).
- Wander overlay layers (heatmap, ripple, constellation) → Phase 4 with `MkCliRunner`.
- F3 togglable layers (tag halos, evidence badge, TTL pulse, agent stripe) → Phase 5.
- 10k-atom performance hardening + `maxNodesShown` graceful degrade UI → Phase 5.
- BRAT auto-release pipeline + Community Plugins submission → Phase 5.
- Refactor `parseAtomFile` upstream into a runtime-free `memory-kernel/parse` entrypoint and remove the plugin's local copy → tracked task before Phase 5 distribution.

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-03-obsidian-mk-graph-phase3-replay-timeline.md`.**

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
