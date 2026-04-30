# Obsidian mk-graph plugin — design spec

**Date:** 2026-04-28
**Status:** Draft (pending user review)
**Authors:** brainstorming session, NePav
**Supersedes:** PR #28 decision to defer Juggl/typed-link visualization (revisited with stronger requirements)

---

## 1. Context

memory-kernel ships an event-sourced typed knowledge graph: 9 atom types, 7 relation types, per-atom decay/TTL, ACT-R-inspired wander (spreading activation with type-weighted edges), and per-agent isolation. PR #28 (2026-04-26) removed Juggl integration in favour of native Obsidian graph + wikilinks. The native graph cannot represent mk's typed structure; Juggl was deprioritised, not rejected.

This spec is for a **new first-party Obsidian plugin** (`obsidian-mk-graph`) that does what neither native nor Juggl can do: typed-edge styling, wander animation, event-sourced replay, and the full mk visual language.

### Use cases (in priority order)
1. **Daily exploration** — the user navigates their own memory graph
2. **Wander/spreading-activation visualization** — see *why* an atom surfaced, not just *that* it did
3. **Stakeholder demos** — show what a typed event-sourced agent memory looks like

### Audience
End-users of memory-kernel installations (not just maintainers). The plugin must install cleanly without compiling native modules.

### Non-goals
- Editing atoms or relations from the graph (read-only — confirmed Q4)
- Replacing the native Obsidian graph (complementary, not a substitute)
- Mobile parity (desktop is primary; mobile may degrade gracefully)
- 3D rendering in v1 (architecture must be 3D-ready for v1.1)
- Hierarchical and domain-cluster layouts in v1 (deferred to v1.1)

### Why none of the existing options work
| Option | Disqualified by |
|---|---|
| Native Obsidian graph | No typed edges, no wander viz, no schema-aware encoding |
| Juggl | Dormant since Nov 2023; cannot animate wander; ~2k node ceiling below 10k requirement; requires Breadcrumbs companion plugin; YAML typed-link form unreliable in practice |
| 3D Graph plugins (AlexW00 / HananoshikaYomaru / Apoo711) | None support typed edges, edge labels, or frontmatter-driven styling — orthogonal to the actual gap |
| Graph Link Types + native | Typed edge labels only; no wander, no replay, no encoding richness |
| Extended Graph (ElsaTam) | Augments native graph; doesn't address wander or typed-edge color systems at the depth needed |

---

## 2. Decisions summary (A–H)

| # | Topic | Decision |
|---|---|---|
| **A** | Integration shape | Plugin reads atom `.md` files + `events.ndjson` directly, shells out to `mk` CLI for live wander/recall queries (`mk wander --json --as-of <ts>`). Add a small `mk timeline --json` CLI command for replay-ready event streams (handles SECRET decryption + evidence-hash deref). No native modules in the Obsidian plugin. |
| **B** | Renderer | 2D WebGL via the [vasturiano/force-graph](https://github.com/vasturiano/force-graph) family. Library family chosen specifically because [3d-force-graph](https://github.com/vasturiano/3d-force-graph) shares an API surface — 3D mode can be added in v1.1 without rewriting. |
| **C** | Wander viz layers | Heatmap (always-on encoding when wander has run) + Animated ripple (opt-in, scrubbable per step) + Constellation overlay (opt-in, dims everything except surfaced collisions). |
| **D** | Layouts in v1 | Force-directed (default), Timeline (x = `created_at`, y = type stratification, paired with the scrubber), Radial-wander (seed-centered, ring per step, activates when wander runs). Hierarchical and domain-cluster deferred to v1.1. |
| **E** | `Relation` schema extension | Add five fields: `created_at`, `confidence`, `weight`, `source` (`'manual' \| 'extracted' \| 'enriched' \| 'unknown'`), `evidence` (string[]). All required in v1; backward-compatible defaults applied on parse for legacy `{target, type}`-only relations. |
| **F** | Visual encoding | F2 default: node color=type · size=citation count (log) · border=classification · opacity=status. Edge color=type · width=weight · dash=source · opacity=confidence. F3 layers (tag halos, evidence badge, TTL pulse, agent stripe) togglable in settings. |
| **G** | Distribution | Code at `packages/obsidian-mk-graph/` in mk monorepo. BRAT for v0.1.x beta, Obsidian Community Plugins submission for v1.0. Vault layout: memory dir as subfolder of vault by default (`vault/.mk/`), outside-vault as configurable fallback. Plugin `manifest.json` version is independent of mk core (same convention as `src/mcp/server.ts`). |
| **H** | Replay UX | Three modes (Live / Scrubbed / Diff). Event-density histogram on the scrubber. Wander runs against state-as-of-playhead. File watcher active in Live, paused in Scrubbed/Diff. v1: atom-mutation events only on timeline; v1.1: recall/wander event ticks. Initial state: Live mode for first-time users; once user has scrubbed, last position is restored on next open. |

---

## 3. Architecture

### 3.1 High-level data flow

```
┌────────────────────────────────────────────────────────────────────┐
│ memory-kernel core (Node, mk CLI)                                  │
│  ├── events.ndjson   ← append-only event log                       │
│  ├── ENTITIES/<id>.md ← atom files (frontmatter + body + Relations)│
│  ├── EPISODES/<id>.md ← episode files                              │
│  └── evidence/        ← snapshot blobs (for SECRET / hash refs)    │
└────────────────────────────────────────────────────────────────────┘
        ▲ (read-only fs)         ▲ (subprocess: spawn `mk …`)
        │                        │
┌────────────────────────────────────────────────────────────────────┐
│ obsidian-mk-graph plugin (Obsidian renderer process)               │
│                                                                    │
│  ┌─────────────┐   ┌──────────────┐   ┌────────────────────────┐   │
│  │ DataLoader  │──▶│ ReplayEngine │──▶│ GraphState (Map<id,A>) │   │
│  │ (fs+watch)  │   │ (events→T)   │   │ + RelationGraph         │   │
│  └─────────────┘   └──────────────┘   └────────────────────────┘   │
│                                                       │            │
│  ┌─────────────┐   ┌──────────────┐                   │            │
│  │ MkCliRunner │──▶│ WanderResult │───────────────────┤            │
│  │ (subprocess)│   │ overlay      │                   ▼            │
│  └─────────────┘   └──────────────┘   ┌────────────────────────┐   │
│                                       │ LayoutEngine           │   │
│                                       │ (force / timeline /    │   │
│                                       │  radial-wander)        │   │
│                                       └────────────────────────┘   │
│                                                       │            │
│                                                       ▼            │
│                                       ┌────────────────────────┐   │
│                                       │ Renderer (force-graph) │   │
│                                       │ + Encoding (F2/F3)     │   │
│                                       │ + ScrubberUI           │   │
│                                       └────────────────────────┘   │
└────────────────────────────────────────────────────────────────────┘
```

### 3.2 Component responsibilities

- **DataLoader** — parses atom `.md` files (existing `parseAtom` shape) and reads `events.ndjson` lines. Watches the memory dir via Obsidian `Vault.adapter` for Live mode.
- **ReplayEngine** — given an array of events and a target timestamp `T`, returns the set of live atoms and relations as of `T`. Stateless and memoised. Encryption-aware: SECRET atoms appear as redacted nodes when `MEMORY_ENCRYPTION_KEY` is not configured (atom exists, body hidden).
- **MkCliRunner** — spawns `mk` subprocess for live computational queries (wander, recall). Communicates over stdout JSON. ~100–500ms latency, acceptable for human-in-the-loop.
- **GraphState** — typed in-memory representation: `Map<atomId, Atom>` + `Map<sourceId, Relation[]>`. Reactive — observers re-render on change.
- **LayoutEngine** — three pluggable layouts in v1 (force / timeline / radial-wander). Each is a function `(GraphState) → Map<atomId, {x, y}>`.
- **Renderer** — wraps `force-graph` with mk's F2/F3 encoding rules. Handles hover/click/drag.
- **ScrubberUI** — bottom-of-view replay controls. Drives `ReplayEngine.computeAt(T)` and updates layout/render.

### 3.3 Why no native modules

Obsidian plugins run in Electron's renderer. Native modules (e.g., `better-sqlite3`) require ABI matching the host Electron version, which is fragile across Obsidian releases and cumbersome to ship. By delegating SQLite/FTS/embedding queries to a `mk` subprocess (option A1), the plugin stays pure JS/TS, ships as a single bundled `main.js`, and works on any platform Obsidian supports.

---

## 4. mk core changes

### 4.1 `Relation` schema extension (file: `src/types.ts`)

```typescript
interface Relation {
  target: string;
  type: RelationType;
  // New in v1:
  created_at?: string;          // ISO8601; default = source atom's created_at
  confidence?: number;          // 0..1; default = 1.0
  weight?: number;              // overrides type-level wander weight when set
  source?: 'manual' | 'extracted' | 'enriched' | 'unknown';  // default = 'unknown'
  evidence?: string[];          // atom IDs / episode IDs / evidence hashes; default = []
}
```

**Backward compatibility:**
- `parseAtom` applies defaults when fields are missing (no migration of existing atom files required).
- `serializeFrontmatter` emits all populated fields. Atoms get the new fields opportunistically as they're touched (read-write cycle).
- The `LEGACY_TYPED_LINK_KEYS` stripper from PR #28 stays — these new fields live inside the `relations[]` array, not as Juggl-style top-level frontmatter keys, so there is no conflict.

**Where new fields are populated at write time:**
- `retain.ts` auto-relink → `source: 'extracted'`
- `enrich-relations.ts` proposals → `source: 'enriched'`, `confidence` from the enrichment score
- Manual edits / explicit caller → `source: 'manual'`
- All three populate `created_at` from current `now()`

### 4.2 New CLI: `mk timeline --json`

```bash
mk timeline --json [--from <iso>] [--to <iso>] [--include-evidence]
```

Emits a JSON document with an `events` array (matches existing `--json` flag convention from CLAUDE.md: `JSON.stringify(result, null, 2)`). Differs from existing `mk replay --from <file>` in that it:
- Decrypts SECRET snapshots when `MEMORY_ENCRYPTION_KEY` is set (otherwise marks them as `[redacted]`)
- Resolves `atom_snapshot_hash` via the evidence dir
- Filters by time range (so plugins reading large stores can paginate)
- Returns events in a denormalised shape (no need for the consumer to read `evidence/` separately)

**Versioning impact:** new CLI command → MINOR bump per CLAUDE.md convention (e.g., 1.16.x → 1.17.0).

### 4.3 Wander as-of-time flag

Extend existing `mk wander` to accept `--as-of <iso>`. When set, runs against state reconstructed via `replay()` to the specified timestamp instead of current state. Required for "wander × time" interaction in H.

---

## 5. Plugin spec details

### 5.1 Settings

| Setting | Type | Default | Purpose |
|---|---|---|---|
| `memoryDir` | path | `<vault>/.mk` | Where atom files + events.ndjson live |
| `memoryDirOutsideVault` | boolean | `false` | When true, `memoryDir` may be outside the vault |
| `mkCliPath` | string | `mk` | Path to the mk binary (PATH lookup by default) |
| `agentId` | string | `''` (shared mode) | Per-agent isolation routing |
| `defaultLayout` | enum | `force` | force / timeline / radial-wander |
| `nodeChannels` | object | F2 set | Toggle border, opacity, size per channel |
| `f3Layers` | object | all off | Tag halos, evidence badge, TTL pulse, agent stripe |
| `wanderPreset` | enum | `constitution` | constitution / tension / narrative / custom |
| `maxNodesShown` | number | 5000 | Auto-degrade for performance |
| `liveModeOnStartup` | boolean | `true` | H1 default; flips to `false` once user has scrubbed once |
| `lastScrubbedAt` | ISO8601 | `null` | H2 — restored when `liveModeOnStartup === false` |

### 5.2 Visual encoding (F2 + F3 toggles)

**Nodes (F2 baseline):**
- Color = atom type (reuse `TYPE_COLORS` from `src/cli/export-obsidian.ts`)
- Size = `4 + 6 * log10(citation_count + 1)` pixels (4px floor, ~16px at 100 citations)
- Border color = classification: PUBLIC=green, TEAM=blue (default), PERSONAL=orange, SECRET=red + 🔒 glyph
- Opacity = status: draft 0.5, active 1.0, accepted 1.0, rejected 0.4 (struck), superseded 0.3, resolved 0.7, archived 0.2, expired hidden

**F3 togglable layers:**
- Tag halos: top-N tags rendered as colored ellipses behind their cluster
- Evidence badge: small circle with count when `relation.evidence.length > 0` (on incident edges, aggregated to source node)
- TTL pulse: animated halo when `now > updated_at + 0.8 * ttl_days * 24h`
- Agent stripe: thin colored bar on edge for `relation.created_by` (deferred until `created_by` field added in v1.1)

**Edges (F2 baseline):**
- Color = relation type (7-palette, distinct from node palette)
- Width = `1 + 2 * (relation.weight ?? type_default_weight)`; clamp [0.5, 8]
- Dash style = source: manual solid, extracted dashed (5,3), enriched dotted (2,3), unknown solid-thin
- Opacity = `0.3 + 0.7 * (relation.confidence ?? 1.0)` — never below 0.3 so faint edges remain visible

**Wander mode override:** when wander has run and `wanderResult` is loaded, baseline F2 dims to 30% opacity globally; wander layers (heatmap on activated atoms, ripple on edges, constellation when toggled) take over.

### 5.3 Layouts

**Force-directed (default).** Standard d3-force via `force-graph`. Tuned defaults: charge -100, link distance 60, collision radius 14. User-adjustable via settings.

**Timeline.** X = `created_at` mapped to view width over the visible time range (driven by scrubber zoom). Y = type stratification (9 horizontal bands, one per atom type), with within-band jitter for readability. Edges drawn as cubic Bézier curves connecting (sourceX, sourceY) to (targetX, targetY).

**Radial wander.** Activates automatically when wander runs. Seed atoms placed at center. Ring N = atoms first activated at step N. Radius `R(N) = 80 * (1 + N)`. Within-ring angle by activation magnitude (highest-activated → top, descending counter-clockwise).

### 5.4 Wander visualization (C: 1+3+4)

**Layer 1 — Heatmap (always-on after wander runs):**
- Activated atoms tinted via `interpolateTurbo` (red=hot, yellow=mid, blue=cold, gray=inactive)
- Tint multiplied with type color so type still readable

**Layer 3 — Animated ripple (opt-in, scrubbable):**
- "Run wander" button executes `mk wander --json --as-of <playheadTs> --seeds <selected>`
- Ripple animation steps through `wanderResult.activated` in order of activation timestamp
- Scrubber under the wander panel lets user replay step-by-step
- Edges along which activation flowed light up sequentially (white pulse traveling source→target)

**Layer 4 — Constellation (opt-in toggle):**
- All non-collision atoms dim to 15% opacity
- Each `Collision` from `wanderResult.collisions` drawn as a bright bridge edge between `atom_a` and `atom_b`
- Tooltip shows shared tags, jaccard similarity, distance

### 5.5 Replay UX (H)

- **Scrubber bar** at bottom of graph view: playhead, density histogram, mode toggle (Live / Scrubbed / Diff), filter chips, "as of" timestamp display.
- **Density histogram** — bar per time bucket (auto: day / week / month based on visible range), height = event count.
- **Live mode** — file watcher + `events.ndjson` tail; new atoms animate in.
- **Scrubbed mode** — file watcher paused; graph frozen at chosen `T`. Wander queries run with `--as-of <T>`.
- **Diff mode** — pick T1, T2. Atoms/relations in T2 but not T1 = green. In T1 but not T2 = red. Mutated = amber.
- **Initial state** — `liveModeOnStartup = true` until first scrub; thereafter, restore `lastScrubbedAt`.

### 5.6 Performance budget

- Read `events.ndjson` once on plugin load: ~1MB per 10k atoms (NDJSON), parsed in <500ms.
- Re-replay on scrub: O(events) ≤ 50ms for 10k events on commodity hardware (target).
- Render 10k nodes with F2 encoding: WebGL, target 30fps idle.
- Wander subprocess: ≤ 500ms per run; rendered async with loading state.
- Graceful degradation: when `nodeCount > maxNodesShown`, show only the highest-activation 5k or the user's local-graph subset.

---

## 6. Phased implementation

This spec covers a single feature but the implementation naturally decomposes. Each phase delivers user-visible value and gets its own implementation plan.

| Phase | Scope | Unblocks |
|---|---|---|
| **1. mk core** | `Relation` schema extension + `mk timeline --json` CLI + `mk wander --as-of` flag + tests | Plugin development |
| **2. Plugin scaffold + static graph** | `packages/obsidian-mk-graph/` scaffold, manifest, settings UI, DataLoader, force layout, F2 encoding, hover/click | First usable graph in Obsidian |
| **3. Replay + timeline** | `events.ndjson` ingestion, ReplayEngine, scrubber UX (Live/Scrubbed/Diff), timeline layout, density histogram | Time-aware exploration |
| **4. Wander visualization** | MkCliRunner, radial-wander layout, heatmap encoding, ripple animation, constellation overlay | The differentiating capability |
| **5. Polish + distribution** | F3 layers, performance hardening at 10k, BRAT release, Community Plugins submission | Public availability |

Each phase will be specified in a separate `writing-plans` session.

---

## 7. Testing strategy

- **mk core (phase 1)** — unit tests for `Relation` schema parse/serialise (legacy + new), `mk timeline --json` golden-file tests, `mk wander --as-of` determinism tests, all to fit the existing 1100+ test suite via vitest.
- **Plugin (phases 2–5)** — vitest for pure logic (ReplayEngine, LayoutEngine, encoding); jsdom + playwright-electron for renderer interactions; manual visual QA against a fixture vault of ~200 atoms.
- **Performance** — fixture vaults at 1k / 5k / 10k atoms; FPS and replay latency measured; documented in a results table per release.
- **Backward compat** — replay against historical event logs (the 189-atom dump from PR #28's resync) must produce identical state with old vs new schema.

---

## 8. Risks & open items

- **10k node ceiling on low-end hardware.** Force-graph WebGL handles 10k comfortably on modern laptops; older machines may struggle. Mitigation: `maxNodesShown` setting (default 5000), graceful local-graph fallback.
- **Native module avoidance is a hard constraint.** If a future requirement (e.g., embedding-similarity edges) needs SQLite directly, we delegate to `mk` subprocess rather than bundling `better-sqlite3`.
- **Plugin manifest version drift.** Per CLAUDE.md convention, plugin version is independent of mk core. CI should not cross-bump them automatically.
- **Schema migration.** New `Relation` fields default at parse time — no on-disk migration runs. Atoms gain fields only when written. This is fast but means visualisation of historical relations uses defaults until they're touched.
- **PR #28 alignment.** Confirm with maintainers that PR #28's `LEGACY_TYPED_LINK_KEYS` stays in place — these new fields are not Juggl-style top-level keys, so there should be no conflict, but a regression test asserting "round-trip stable + no new top-level Juggl keys emitted" is part of phase 1.
- **Episodes.** Out of scope for v1 visualisation. Atoms reference episodes via `provenance.episodes`, but episode nodes don't render in v1. Hover tooltip can show episode IDs.

---

## 9. Out of scope (deferred to v1.1+)

- 3D rendering toggle (architecture is 3D-ready)
- Hierarchical and domain-cluster layouts
- Recall/wander event ticks on the timeline (only atom-mutation events in v1)
- Episode nodes in the graph
- `created_by` agent stripe encoding (field deferred to v1.1)
- Edge interaction beyond hover (no click-to-follow, no edit-from-graph — read-only confirmed)
- Mobile parity
- Gating v1 release on Obsidian Community Plugins approval (BRAT is sufficient for v1; Community Plugins submission proceeds in parallel as part of phase 5)

---

## 10. Acceptance criteria (v1)

A v1 release is ready when:

1. mk core ships `Relation` schema extension + `mk timeline --json` + `mk wander --as-of` with passing tests, MINOR-version bump.
2. `packages/obsidian-mk-graph/` builds via the existing monorepo tooling and ships a single `main.js` + `manifest.json` + `styles.css` artefact.
3. The plugin loads a 200-atom fixture vault and renders force / timeline / radial-wander layouts with F2 encoding.
4. Wander panel: select seeds, run wander, observe heatmap + ripple + constellation toggles working against the playhead-aware state.
5. Scrubber: scrub through the 189-atom history (PR #28 resync as fixture), Diff mode highlights the Juggl-removal mutation set.
6. Performance: 10k-atom synthetic vault renders at ≥30fps with `maxNodesShown=5000` graceful degrade.
7. BRAT release published; install instructions in `packages/obsidian-mk-graph/README.md`. Community Plugins submission filed (approval not required for v1).
