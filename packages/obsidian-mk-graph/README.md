# Memory Kernel Graph for Obsidian

A typed event-sourced graph view for [memory-kernel](https://github.com/mainion-ai/memory-kernel) atoms. Reads your `.mk/ENTITIES/*.md` files and renders them as a force-directed graph with the F2 visual encoding:

- **Node color** = atom type (fact / belief / decision / …)
- **Node size** = inbound citation count (log scale)
- **Node border** = classification (PUBLIC / TEAM / PERSONAL / SECRET — SECRET also gets a 🔒 glyph)
- **Node opacity** = status (active = 1.0, archived = 0.2, …)
- **Edge color** = relation type (extends / supports / contradicts / …)
- **Edge width** = relation weight
- **Edge dash** = source (manual = solid, extracted = dashed, enriched = dotted)
- **Edge opacity** = relation confidence

Read-only. Click a node to open its atom file. Hover for a tooltip with id, type, status, classification, citations, and tags. The legend in the bottom-left of the view explains every color and dash style.

## Status

`v0.1.0` — Phase 2 of the [obsidian-mk-graph design spec](../../docs/superpowers/specs/2026-04-28-obsidian-mk-graph-design.md). Force-directed layout only; timeline, scrubber, and wander-visualisation come in Phases 3 / 4.

## Install (BRAT, recommended for v0.x)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Community Plugins.
2. In BRAT settings, "Add Beta Plugin" → `mainion-ai/memory-kernel` (path `packages/obsidian-mk-graph`).
3. Enable "Memory Kernel Graph" under Community Plugins.

## Install (manual, build from source)

```bash
git clone https://github.com/mainion-ai/memory-kernel.git
cd memory-kernel/packages/obsidian-mk-graph
npm install
npm run build

# Symlink into your vault (Unix shell)
mkdir -p <vault>/.obsidian/plugins/obsidian-mk-graph
ln -sf "$PWD/main.js"        <vault>/.obsidian/plugins/obsidian-mk-graph/main.js
ln -sf "$PWD/manifest.json"  <vault>/.obsidian/plugins/obsidian-mk-graph/manifest.json
ln -sf "$PWD/styles.css"     <vault>/.obsidian/plugins/obsidian-mk-graph/styles.css
```

On Windows, copy `main.js`, `manifest.json`, and `styles.css` into `<vault>\.obsidian\plugins\obsidian-mk-graph\` instead of symlinking.

Reload Obsidian and enable the plugin.

## Settings

| Setting | Default | What it does |
|---|---|---|
| Memory directory | `.mk` | Path to memory-kernel store. Relative paths resolve under the vault. **Note:** Obsidian deliberately skips dot-folders during vault indexing, so atoms in the default `.mk/` are not clickable (click-to-open relies on Obsidian's vault index). To enable clicks, point this at a non-dot folder like `memory` or `mk-store`. |
| Memory dir outside vault | off | Allow absolute paths outside the current vault. |
| Agent ID | (empty) | Per-agent isolation — when set and `agents/<id>/` exists, the plugin reads from there. **Changing this setting requires closing and reopening the graph view** so the file watcher rebinds to the new directory. |
| Border = classification | on | Toggle the F2 classification ring. |
| Opacity = status | on | Toggle the F2 status dimming. |
| Size = log(citations) | on | Toggle the F2 log-scale node sizing. |
| Show legend | on | Display the F2-encoding legend in the bottom-left of the graph view. Toggle takes effect on next view-open. |
| Max nodes shown | 5000 | Hard cap; above this the most-cited nodes win. |

## Commands

- **Open Memory Kernel Graph** — opens the graph view in the right pane.
- **Reload Memory Kernel Graph from disk** — re-reads `ENTITIES/*.md`.

## Known caveats

- **Dot-folder memory directories aren't clickable.** Obsidian skips dot-folders (`.mk`, `.memory`, etc.) when building its vault file index. The plugin reads atom files fine via Node `fs`, so the graph renders, but clicking a node calls `app.workspace.openLinkText` which depends on Obsidian's index. The plugin shows a clear Notice when it detects this case. Workaround: rename your memory dir to a non-dot path (e.g. `memory/`) and update the "Memory directory" setting accordingly.
- **Changing `Agent ID` requires reopening the graph view.** The file watcher binds at view-open time. Updating the setting persists the new value but doesn't rewatch — close and reopen the leaf to pick up the new agent.
- **Mobile not supported.** `isDesktopOnly: true` in the manifest. Mobile compatibility is a Phase 5+ concern.
- **Plugin-bundle cache after rebuild.** Obsidian's `Cmd+P → Reload app without saving` doesn't always invalidate cached plugin bundles. After running `npm run build` during plugin development, if changes aren't visible, do a **hard reload** (`Cmd+Shift+R` on macOS, `Ctrl+Shift+R` on Linux/Windows) to force Obsidian to re-fetch the bundle.

## Roadmap

- v0.2.0 — Phase 3: events.ndjson ingestion, replay scrubber, timeline layout, diff mode.
- v0.3.0 — Phase 4: wander visualisation (heatmap + ripple + constellation), `mk` subprocess integration.
- v1.0.0 — Phase 5: F3 layers, performance hardening, Community Plugins submission.

## License

Apache-2.0. See `LICENSE`.
