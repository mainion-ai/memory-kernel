# obsidian-mk-graph changelog

This file is independent of the `memory-kernel` core changelog (per project convention — plugin manifest version drifts with the plugin only).

## [0.3.1] — 2026-05-08

### Changed — PR #62 review follow-ups (cleanup, no new features)
- **Watcher errors are now logged.** Both `events-loader.ts` and `data-loader.ts` previously had empty `watcher.on('error', () => {})` handlers. They now `console.warn` the error so silent watcher death (directory deletion, permission loss, watch-limit exhaustion) is debuggable. UX is unchanged on success paths.
- **Agent ID validator aligned with mk-core.** Both `data-loader.ts:isSafeAgentId` and `settings.ts:isUnsafeAgentId` now use mk-core's allowlist `^[a-zA-Z0-9_-]+$`. Previously characters like spaces, colons, `@`, etc. passed the plugin's path-traversal check but were rejected by mk-core, causing silent fallback to shared mode. The SettingTab warning now fires for the same set of inputs that mk-core would reject.
- **`rangeFromAtoms` no longer collapses to "now/now" when the first atom has empty createdAt.** The lexicographic comparison `'2026-04-01' < ''` returns `false`, so subsequent valid timestamps were never used to update `min`. Refactored to seed from the first atom with a non-empty createdAt. Affects timeline layout for hand-crafted atom files missing `created_at`; mk-core-written atoms were unaffected.
- **Scrubber keydown handler only stops playback on scrub-relevant keys.** Previously any keydown (Tab, Escape, Shift) paused auto-playback. Now filters to ←/→ / Page Up·Down / Home / End — the keys that actually move the playhead.

### Tests
150 / 150 unchanged.

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
- Pure-logic `filter-state.ts` (`FilterState` interface, `matchesFilter` predicate, JSON serialize / deserialize) — independently tested with 18 assertions.
- DOM `filter-panel.ts` (`createFilterPanel(parent, opts) → FilterPanelHandle`) — independently tested with 8 jsdom assertions.
- View integration adds `computeReferencedSet`, `collectTags`, and `handleFilterChange` helpers and wraps the controller's `onState` callback with a `.filter(matchesFilter)` pass.

### Tests
150 / 121 — added 29 new tests across `filter-state.test.ts`, `filter-panel.dom.test.ts`, and `graph-state.test.ts`.

### Out of scope (deferred to v0.4+)
- **Forces** sliders (centre / repel / link / link distance) — exposes force-graph parameters; cosmetic.
- **Groups** (named filter sets that color-tint matching atoms) — needs design thought because Groups override the F2 type-fill encoding.
- **Arrow toggle** — currently `linkDirectionalArrowLength(0)` is hardcoded; one-line flip when implemented.
- **Text-fade threshold slider** — currently labels appear at force-graph `globalScale > 1.5`.
- **Animate / freeze button** for the simulation — force-graph already supports `pauseAnimation` / `resumeAnimation`.
- **Existing files only** / **Attachments** toggles from Obsidian's native panel — N/A here (atoms are always files; no attachments in mk's atom model).

## [0.2.11] — 2026-05-04

### Changed — tooltip metadata is one-field-per-line
Hover-tooltip's meta line was previously `classification: TEAM · citations: 4 · tags: foo, bar` joined with `·` separators on a single wrapping line — hard to scan, especially with longer atom IDs in the title. Each field now gets its own row (`classification:`, `citations:`, `tags:`) for an instantly-scannable layout. CSS adds 2px gaps between rows.

## [0.2.10] — 2026-05-04

### Changed — edge dash patterns + thin unknown
- **`extracted` (dashed) is now `[8, 4]`** (was `[5, 3]`) — clearer dashed pattern with longer "on" segments and more visible gaps.
- **`enriched` (dotted) is now `[1, 5]`** (was `[2, 3]`) — actual dot-like marks with wide gaps instead of short dashes. The 1px on / 5px off ratio reads as discrete dots rather than a fine dashed line.
- **`unknown` source renders at half-width.** `edgeWidth` multiplies by 0.5 when `rel.source === 'unknown'`, with the floor still clamped at 0.5px. Both `manual` and `unknown` are solid lines, but `unknown` is now visibly thinner, distinguishing the two.
- **Legend updated to match.** The `unknown` swatch's height drops to 1px so the legend visually shows it as a thinner solid line, and its label is now `unknown (solid, thin)`.

### Tests
121 / 120 (was 120) — added `edgeWidth halves for source: unknown so it renders thinner than manual`. Existing `edgeDash returns the source pattern...` updated to the new `[8, 4]` and `[1, 5]` patterns.

## [0.2.9] — 2026-05-04

### Fixed — Diff mode produced an all-green view that was visually identical to Scrubbed
The user reported that Scrubbed and Diff "show exactly the same atoms, just different colors". They were right: the v0.2.3 default for Diff was `T1 = '1970-01-01'` (epoch) — so `prev` was always empty, and every atom in `next` got classified as "added" (green). The user couldn't see the actual mix of red ghosts (archived), amber (mutated), and unchanged F2-colored atoms that Diff is supposed to surface.

New defaults flip the relationship between the playhead and the diff window:

- **`T1 = playhead`** (the user-controlled start of the diff window).
- **`T2 = lastEventTs()`** (the latest known state).
- **`asOf = T1`** so the readout and slider position match what the user is dragging.

What you see at different playhead positions, with the fixture's 23 events spanning Apr 1 → Apr 26:

| Playhead | T1 → T2 | Visible diff |
|---|---|---|
| Far right (Apr 26) | T1 == T2 | Empty diff — all atoms in normal F2 colors (intentional zero-state). |
| Apr 15 (mid) | mid → end | atoms[15..19] green (added since), atoms[2] + [5] red ghost (archived since), atoms[10] amber (updated since), rest F2. |
| Far left (Apr 1) | start → end | nearly everything green; atoms[2]/[5]/[10] colored as above. |

### Auto-snap on first Diff entry
When entering Diff mode with the playhead at the right end (the default after Live's snap-right), the view auto-snaps it to `events[0].timestamp`. The user immediately sees a meaningful "full history" diff instead of an empty one. From there they can drag right to narrow the window.

### Tests
120 / 120. The existing diff test (`Diff mode replays at T1 and T2 and emits a DiffSet`) sets `diffT1` and `diffT2` explicitly via `setDiffRange()`, so the new defaults don't affect it.

## [0.2.8] — 2026-05-04

### Fixed — slider was visible-but-not-draggable in v0.2.7
**v0.2.7 layered a transparent native input on top of the visible track for interaction. The intent was that clicks would pass through `pointer-events: none` decorations into the input below — but in practice clicks were getting eaten somewhere between the track and the input, leaving the slider visually correct but completely unresponsive.**

Switched to direct pointer handling on the wrapper:

- **The wrapper itself is now the interaction surface.** `pointerdown`, `pointermove`, `pointerup`, and `pointercancel` listeners are attached to `.mk-graph-scrubber-playhead-wrapper`. Click anywhere along the slider area to jump to that position; drag to scrub. Pointer capture (`setPointerCapture`) lets the drag continue even if the cursor leaves the wrapper.
- **The native input gets `pointer-events: none`** so it doesn't fight the wrapper for clicks. It's still in the DOM for two reasons: (1) tests dispatch `input` events on it directly, and (2) Tab focuses it so native ←/→ / Page Up·Down / Home / End keyboard navigation still works — its `input` event routes through the same `applySliderValue()` path as the pointer handlers.
- **Single source of truth for value updates.** `applySliderValue(v, fireChange)` is called from both code paths (wrapper pointer handlers and input's `input` event). It keeps `slider.value`, the `--mk-frac` CSS variable, and `onPlayheadChange` in sync.
- **Bonus:** `touch-action: none` on the wrapper prevents touchscreen scroll/zoom from stealing drags. Disabled state shows `cursor: not-allowed` on the wrapper.

Tests unchanged; all existing scrubber DOM tests still pass without modification because the native input is still there, accepting `slider.value = 'X'; slider.dispatchEvent(new Event('input'))` exactly as before.

## [0.2.7] — 2026-05-04

### Changed — switched the playhead slider from native styling to a hybrid custom-visual approach
**Three previous attempts (v0.2.4 / v0.2.5 / v0.2.6) tried to make WebKit's native `<input type="range">` render its track at exactly 100% width.** Each version stripped padding, set `box-sizing: border-box`, forced `::-webkit-slider-runnable-track { width: 100% }`, and reset all UA defaults. The visible track still came out narrower than the histogram in Obsidian's Electron renderer — likely from WebKit's thumb-aware track inset that `appearance: none` doesn't fully eliminate.

This release abandons that path and uses a hybrid layout:

- **Visible track / fill / thumb are absolutely-positioned divs** inside a wrapper. Track uses `position: absolute; left: 0; right: 0;` so its width is provably identical to the wrapper's content width — and since the wrapper is `flex: 1` of the same column that holds the histogram, the track is provably the same width as the histogram. No browser quirks possible.
- **A transparent native `<input type="range">` layered on top** receives all interaction (click-to-position, drag, focus, keyboard ←/→ / Page Up·Down / Home / End). The native track and thumb are stripped to zero (`width: 1px; background: transparent`), so only the custom divs render. The input itself is `opacity: 0` and stretched over the whole wrapper.
- **A `--mk-frac` CSS variable** drives the visible thumb's `left` and the fill's `width`. JS updates it on every `input` event and on programmatic value changes (from `setPlayhead` and `setActiveMode` snap-right).
- **Tests are unchanged** because the native input still exists with the same id/class/value/disabled semantics. All 9 scrubber DOM tests + the full suite (120 / 120) pass.

### Bonus polish
- The fill div animates 80ms linear when the playhead moves so playback (▶) feels smoother instead of stuttery.
- Thumb now grows 1.15× on wrapper-hover (any part of the slider area), not just on direct thumb hover.
- Disabled state fades the entire visible playhead (track + fill + thumb) to 35% rather than relying on the input's `:disabled` opacity which didn't apply to the custom layer.

## [0.2.6] — 2026-05-04

### Changed — scrubber layout: Play/Loop on slider's row, histogram = slider width
- **Reorganized the scrubber DOM into a header + body, where body is a flex row of `timeline` (flex: 1) and `controls` (flex: 0 0 auto).** The `timeline` column stacks the histogram and slider, so both inherit the same `flex: 1` width — they are guaranteed to be visually identical in horizontal extent. The `controls` column (Play + Loop) sits to the right of the slider on the same row via `align-self: flex-end`, instead of on a separate row below the slider.

  ```
  [Live][Scrubbed][Diff]                                       2026-04-26T...
  ░░░▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃░░░▇░░░
  ─────────●──────── playhead ─────────────────  [▶] [☐ LOOP]
  ```

- **Slider element width now reliably matches the histogram.** Reset padding/border/margin to 0, set `box-sizing: border-box`, and forced `::-webkit-slider-runnable-track { width: 100%; }` so the slider's drawable track is exactly the same width as the histogram's bars.
- **Slider track bumped back to 6px** (was 3px in v0.2.5) and slider element height to 22px so the slider has visual weight comparable to the histogram instead of looking like a thin afterthought.
- **Scrubber-host height reduced 132 → 110px** since the controls no longer need their own row. Legend `with-scrubber-clearance` adjusted to 122px.

### Tests
120 / 120 — no test changes (existing scrubber DOM tests don't depend on the body/controls structure).

## [0.2.5] — 2026-05-04

### Changed — scrubber visual + layout polish
- **Histogram and slider now span exactly the events range, same length.** Removed the v0.2.3 `nowIso` extension so the histogram doesn't have empty trailing buckets (Apr 27 → today were ghost padding before). Both the histogram and the playhead slider map `[events[0].timestamp, events[last].timestamp]`, so they're always the same horizontal extent. Live-mode "now" still snaps the slider to value 1000 via `setPlayhead`'s clamp.
- **Empty histogram buckets are now visible as a 2px baseline.** Previously a 0-event bucket rendered with `height: 0%` and disappeared. The histogram now reads as a continuous timeline rather than a sparse pile of taller bars.
- **Histogram bars accent-color when populated.** Buckets with `count > 0` get a `has-events` class and render in the Obsidian accent color (faded to 55% opacity). Empty buckets stay faint gray. Hovering any bar pops it to full opacity with a subtle vertical scale.
- **Play / Pause button + Loop checkbox moved to a dedicated controls row below the slider, right-aligned.** Frees the slider track to be visually full-width, matching the histogram. Play button is now a 22px circular icon (was a wider text-padded button); hover fills it with the accent color.
- **Slider thumb halved to 14px** with an accent-color fill and a 2px background-color border ring (no more "white pill on blue"). Track is 3px (was 6px). Hover scales the thumb 1.15×; active scales 1.2×; focused thumb gets a soft 3px accent halo. Cleaner, more proportional with the smaller play button.
- **Overall styling:** subtle vertical gradient + backdrop blur on the scrubber background, top edge shadow, mode-button pills (rounded full) with a soft accent halo when active, monospace timestamp readout with light letter-spacing. Scrubber-host height bumped 116 → 132px to fit the new controls row; legend `with-scrubber-clearance` adjusted to 144px.

### Tests
120 tests across 17 files (no test changes — all existing scrubber tests still pass with the new layout).

## [0.2.4] — 2026-05-04

### Added — scrubber UX polish + click-to-open everywhere
- **Click-to-open atom files now works in Scrubbed and Diff modes.** Snapshot-derived atoms (parsed from `event.atom_snapshot` inside `replayEvents`) had no `filePath`, so clicking them in non-Live modes silently no-op'd. The replay engine now inherits `filePath` from the on-disk fallback by atom id, so any atom that still exists on disk is openable from any mode. Atoms archived after the playhead position remain un-clickable (their files may not exist).
- **Play button + Loop checkbox in the scrubber header.** ▶ animates the playhead from current position to the end over 15s; ⏸ pauses. The Loop checkbox wraps from end back to start. Manual drag, arrow-key, or mode change pauses playback. The button is disabled in Live mode (the slider is read-only there). Mode determines the visual outcome — Scrubbed shows historical state, Diff shows cumulative diff.
- **Slider keyboard navigation.** Native `<input type="range">` already supported ←/→ / Page Up·Down / Home / End once focused; v0.2.4 adds an explicit `tabindex` plus a visible focus ring so users can find the focused state.
- **Live mode: slider is now disabled and snapped to the far right.** Previously Live mode let users drag the slider, persisting `lastScrubbedAt` even though the controller ignored it. Now both the user-driven mode-button click and the external `setMode('live')` path go through `setActiveMode()`, which disables the slider, disables Play, snaps the knob to value `1000`, and halts any ongoing playback.
- **Slider styling.** Custom track (6px) + thumb (18px circle, accent-colored ring) for clearer affordance and easier grabbing. Scrubber-host height bumped from 92px → 116px to fit; legend `with-scrubber-clearance` adjusted to 128px.

### Test count
120 tests across 17 files (was 116 — added one for replay-engine `filePath` inheritance and three for scrubber Live-disable / Play / Loop).

## [0.2.3] — 2026-05-04

### Fixed — scrubber playhead actually scrubs now
- **Slider range now matches the events range, not 1970-to-now.** The scrubber was constructed with `fromIso: '1970-01-01T00:00:00Z'` and `toIso: new Date().toISOString()` and never re-anchored to the loaded events. With a fixture spanning 26 days inside a ~56-year slider track, the useful interaction range was ~0.16% of the slider — so dragging the playhead in Scrubbed mode landed in the dead zone and the v0.2.1 `iso < range.from` guard silently dropped every emission. After loading events, the view now calls `scrubber.setRange(events[0].timestamp, max(events[last].timestamp, now))` so the entire slider track maps to the actual data range.
- **`ScrubberHandle.setRange(fromIso, toIso)` is a new public method.** Updates `fromMs`/`toMs` (now `let`-bound so the slider's `input` handler closes over the current values) and re-anchors the slider knob to the existing readout. Covered by a new jsdom test.
- **Diff mode no longer renders empty when no T1/T2 is set.** The controller now defaults `T1 = '1970-01-01T00:00:00.000Z'` (so `prev` is always empty) and `T2 = playhead ?? lastEventTs() ?? now`. Drag the playhead in Diff mode to see what's been added/removed/mutated up to that point. The explicit `setDiffRange()` path still overrides these defaults.

### Test count
116 tests across 17 files (was 115 — added one for `setRange`).

## [0.2.2] — 2026-05-03

### Fixed — single-atom views and stale playhead readout
- **Graph auto-zooms-to-fit on the first non-empty render.** A single-atom store (e.g. an agent dir with one file) was rendering as an invisible ~4px dot at canvas origin. The renderer now calls `zoomToFit(400, 60)` once after the first render that has at least one node — 600ms after for force layout (lets the simulation settle) or immediately for timeline layout (positions are pinned).
- **Live mode `asOf` falls back to `new Date().toISOString()` when no events exist.** The scrubber readout was getting stuck at a stale `lastScrubbedAt` (e.g. an old `1970-01-01...` value persisted before the v0.2.1 guard) when an agent dir without an `events.ndjson` was opened. Live mode now always emits a non-stale `asOf`, so the scrubber reflects current time.

### Documentation
- `SMOKE_TEST.md` S11 now warns that a single-atom view is easy to miss visually and includes a DevTools Console check for `agentId` and `maxNodesShown`.

## [0.2.1] — 2026-05-03

### Fixed — v0.2.0 smoke walk follow-ups
- **Legend no longer overlaps the scrubber.** The legend was anchored at `bottom: 12px` while the new Phase 3 scrubber sits at `bottom: 0` with height 92px, so the two overlays collided in the bottom-left of the graph view. The renderer now adds `with-scrubber-clearance` to the legend root when `showScrubber === true`, pushing `bottom` to 104px (= scrubber 92 + 12 gap).
- **Legend no longer sits on top of Obsidian's settings / preferences modal.** The body-attached overlay layer (z-index 9999, kept high so it stays above force-graph's canvas) was obscuring modals. The renderer now observes `document.body` for the `.modal-container > .modal` element and toggles `is-modal-suppressed` on the overlay layer to hide it while a modal is open.

### Documentation
- `SMOKE_TEST.md` S14 search now uses `class="mk-graph-tooltip"` (with the equals + quote) so DOM-element matches don't get inflated by the inlined `<style>` block. Also notes the side-pane convention so close-via-`Cmd+W` isn't surprising.

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

## [0.1.10] — 2026-05-03

### Fixed — PR #61 code-review follow-up
- **Atom body no longer contains the `<!-- mk:relations -->` sentinel.** The previous regex stripped from the `## Relations` heading onward, but mk-core (post-v1.17.0) writes the sentinel comment one line above the heading, so the sentinel survived in `atom.body`. Now mirrors mk-core's `stripRelationsSection` (`src/obsidian.ts`): slice at the sentinel when present, fall back to the heading regex for hand-written files without one.
- **Comma-separated tag strings are now split into individual tags.** Older mk CLI versions wrote `--tags "a,b,c"` as a single-element array (`["a,b,c"]`) instead of three entries. The plugin now mirrors mk-core's `normalizeTags` (`src/format.ts`, fix `146a23e`): split on commas, trim, dedupe, sort. Stores written before mk-core v1.15.0 will display tags correctly.

## [0.1.9] — 2026-05-03

### Changed
- Removed v0.1.8's diagnostic console logs and visible red overlay border. The v0.1.7 body-attached overlay was working correctly all along — the smoke walker's earlier reports of invisibility (across v0.1.4–v0.1.7) were a stale Obsidian plugin-bundle cache that `Cmd+P → Reload` doesn't invalidate. Hard-reload (`Cmd+Shift+R`) fixes it.
- Restored overlay `z-index` from `99999` (v0.1.8 diagnostic value) back to `9999`.

### Documentation
- README "Known caveats" now mentions Obsidian's plugin-bundle cache and the `Cmd+Shift+R` workaround.
- `SMOKE_TEST.md` setup adds an explicit hard-reload step so future walkers don't repeat the cache trap.

## [0.1.8] — 2026-05-03 (diagnostic)

### Diagnostic
- Temporary: console.log markers at every renderer step, plus a visible red border on the overlay layer. Lets the smoke walker pinpoint exactly where the overlay-attachment chain breaks. v0.1.9 will be the clean fix.

## [0.1.7] — 2026-05-03

### Fixed
- **Tooltip and legend now actually render.** v0.1.6's overlay-layer-as-container-sibling never made it into the DOM (smoke walker's console diagnostic showed the container had only `force-graph-container` as a child even after an explicit `appendChild`). force-graph's mount sequence in Obsidian's Electron renderer appears to clear sibling children async during init. Move the overlay to `document.body` with `position: fixed`, tracking the container's bounding rect via `ResizeObserver` + window listeners. force-graph can't touch the body.

## [0.1.6] — 2026-05-03

### Fixed
- **Tooltip and legend now visible.** v0.1.5's cursor-based tooltip positioning was correct on its own merits, but neither tooltip nor legend were rendering in the user's smoke walk because force-graph's canvas wrapper sometimes creates a stacking context in Obsidian's Electron renderer that traps absolute-positioned siblings beneath it. Mount both overlays in a dedicated layer (`.mk-graph-overlay-layer`) that's a later sibling of force-graph's wrapper, with `isolation: isolate` so the layer is self-contained. (Found by smoke walker: S3 still failing in v0.1.5 + legend never visible since v0.1.4.)

## [0.1.5] — 2026-05-03

### Fixed
- **Hover tooltip now appears at the cursor.** v0.1.3 fixed hit-testing (`nodePointerAreaPaint`) and v0.1.4 added the legend, but the tooltip still didn't visually show in v0.1.4 because `fg.graph2ScreenCoords`'s reference frame in Obsidian's Electron renderer doesn't reliably match the container origin (force-graph's wrapper div introduces an offset). Track cursor position via mousemove on the container and place the tooltip at the cursor — robust regardless of any internal coordinate transforms. (Found by smoke walker: S3 still failing after v0.1.4.)

## [0.1.4] — 2026-05-03

### Added
- **Legend overlay** in the graph view's bottom-left, explaining every F2 encoding channel (atom-type colors, classification rings, status opacities, relation colors, edge dash patterns, and node-size citation scale). Collapsible header. Toggleable via new `Show legend` setting (default on). Reading visual constants directly from `visual.ts` keeps it in sync with the renderer.

### Changed
- New setting `showLegend: boolean` (default `true`). Toggle takes effect on next view-open.

## [0.1.3] — 2026-05-02

### Fixed
- **Hover tooltip now actually shows.** v0.1.2 set `nodeVal` to fix hit-testing, but with `nodeCanvasObjectMode('replace')` force-graph also requires an explicit `nodePointerAreaPaint` callback to populate its off-screen hit-test mask. Without it, `onNodeHover` never fires regardless of `nodeVal`. Paint the same circle into the supplied hit-test color. (Found by smoke walker: S3 still failing after v0.1.2.)

### Documentation
- `SMOKE_TEST.md` now uses `~/mk-graph-smoke/` instead of `/tmp/mk-graph-smoke/` (macOS reaps `/tmp/` between sessions).
- S10 rewritten as a sleep+create-new-atom test with visible SECRET node pop-in (was an append-newline that made no visible change).
- S11 adds an `ls` verification step before the routing test (a walker's heredoc silently failed and the missing file was hard to diagnose).
- S14 rewritten with explicit DevTools step-by-step instructions including the Elements-tab overflow note.

## [0.1.2] — 2026-05-02

### Fixed
- **Hover tooltip now shows.** Force-graph hit-testing requires `node.val` to compute the hover radius; the renderer's custom `nodeCanvasObject` had been painting visuals without setting `val`, so `onNodeHover` never fired. Set `nodeVal` to the squared visual radius. (Found by smoke walker: S3.)
- **Click on atom now surfaces a clear Notice when the file is in a dot-folder** instead of silently failing with Obsidian's "Folder already exists" error. (Found by smoke walker: S8.)
- Bumped tooltip `z-index` from 10 to 1000 as defense-in-depth against force-graph stacking contexts.

### Documentation
- Rewrote `SMOKE_TEST.md` with explicit CLI for every step (S10/S11), literal Obsidian UI paths (S9/S12/S13/S14), and walker-friendly expectations (S5/S7). Setup now uses `memory/` instead of `.mk/` so the dot-folder caveat doesn't block the walk.
- Added a "Known caveats" section to README covering the dot-folder issue, the agentId view-reopen requirement, and the desktop-only constraint.

## [0.1.1] — 2026-04-30

### Changed
- **`loadSettings` now survives a corrupt/unreadable `data.json`.** Falls back to defaults and logs a `console.warn` instead of failing plugin onload.
- **Click on an atom outside the vault now shows a Notice** explaining why Obsidian can't open it (was a silent no-op, common when `memoryDirOutsideVault: true`).
- **Documented:** changing `agentId` in settings requires closing and reopening the graph view (the file watcher binds at view-open time).

### Internal
- Extracted `hexToRgba` from `renderer.ts` into `src/color.ts` with unit tests.
- Dropped unused `js-yaml` / `@types/js-yaml` deps; gray-matter handles YAML parsing.

## [0.1.0] — 2026-04-30

### Added
- Initial plugin scaffold under `packages/obsidian-mk-graph/`.
- Read-only force-directed graph view of `<memoryDir>/ENTITIES/*.md`.
- F2 visual encoding (color=type, size=log-citations, border=classification, opacity=status; edge color=type, width=weight, dash=source, opacity=confidence).
- Hover tooltip + click-to-open-atom-file.
- File watcher for live updates when atom files change on disk.
- Per-agent isolation routing (`agents/<id>/` resolution).
- Settings tab with channel toggles, agent id, memory dir, max-nodes cap.
- Plugin commands: open view, reload from disk.
- 20-atom fixture vault for smoke testing.

### Notes
- No `events.ndjson` ingestion yet — Phase 3.
- No wander visualisation yet — Phase 4.
- No Community Plugins submission — Phase 5; install via BRAT or manual.
