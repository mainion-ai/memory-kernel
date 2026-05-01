# obsidian-mk-graph changelog

This file is independent of the `memory-kernel` core changelog (per project convention — plugin manifest version drifts with the plugin only).

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
