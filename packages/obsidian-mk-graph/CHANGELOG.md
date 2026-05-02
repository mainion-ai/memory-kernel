# obsidian-mk-graph changelog

This file is independent of the `memory-kernel` core changelog (per project convention — plugin manifest version drifts with the plugin only).

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
