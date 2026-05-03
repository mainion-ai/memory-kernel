# obsidian-mk-graph changelog

This file is independent of the `memory-kernel` core changelog (per project convention — plugin manifest version drifts with the plugin only).

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
