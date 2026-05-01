# Smoke test — Phase 2 acceptance

Run before tagging `obsidian-mk-graph@0.1.0`. All steps must pass.

## Setup

1. Build the plugin:
   ```bash
   cd packages/obsidian-mk-graph
   npm install
   npm run build
   ```
2. Make a temporary vault:
   ```bash
   mkdir -p /tmp/mk-graph-smoke && cd /tmp/mk-graph-smoke
   ```
3. Copy the fixture as the memory dir:
   ```bash
   mkdir -p .mk
   cp -r <repo>/packages/obsidian-mk-graph/test/fixtures/small-vault/* .mk/
   ```
4. Symlink the plugin into the vault (Unix shell). On Windows, copy `main.js`, `manifest.json`, and `styles.css` into the plugin folder instead, or use `mklink /H` (hardlink) from an Administrator cmd:
   ```bash
   mkdir -p .obsidian/plugins/obsidian-mk-graph
   ln -sf <repo>/packages/obsidian-mk-graph/main.js .obsidian/plugins/obsidian-mk-graph/main.js
   ln -sf <repo>/packages/obsidian-mk-graph/manifest.json .obsidian/plugins/obsidian-mk-graph/manifest.json
   ln -sf <repo>/packages/obsidian-mk-graph/styles.css .obsidian/plugins/obsidian-mk-graph/styles.css
   ```
5. Open `/tmp/mk-graph-smoke` in Obsidian. Trust the vault. Enable Community Plugins. Enable "Memory Kernel Graph".

## Checklist

- [ ] **S1: View opens.** Click the ribbon icon (git-branch). The right pane opens with the graph view.
- [ ] **S2: Nodes render.** 20 nodes visible, distributed by force layout. No console errors.
- [ ] **S3: F2 color = type.** Hover several nodes — tooltip shows the type, fill color matches the spec palette (fact=green, belief=blue, decision=orange, etc.).
- [ ] **S4: F2 border = classification.** SECRET atoms (the orange-red border with 🔒 glyph) are visually distinct from TEAM (blue border) and PUBLIC (green).
- [ ] **S5: F2 opacity = status.** Rejected/archived atoms appear dimmer than active ones.
- [ ] **S6: F2 size = log-citations.** Atoms with more inbound edges appear larger.
- [ ] **S7: Edges encode type / source / confidence.** Different edge colors visible (one per relation type). Confirm the source-dash mapping by inspecting the fixture: at least one edge with `source: extracted` should render dashed, at least one with `source: enriched` should render dotted, and edges with `source: manual` should be solid. Edges with no `source` field also render solid. Hover an edge — no crash even if force-graph doesn't show a tooltip on edges.
- [ ] **S8: Click opens atom file.** Click any node — the atom .md file opens in the main pane.
- [ ] **S9: Settings persist.** Open settings, toggle "Border = classification" off, close + reopen Obsidian — toggle remains off, borders stay hidden.
- [ ] **S10: Live mode picks up changes.** With the view open, edit one atom file from disk (`echo >> .mk/ENTITIES/<one>.md`), save — within ~1 second, the graph re-renders.
- [ ] **S11: Per-agent isolation routes correctly.** Create `.mk/agents/test/ENTITIES/<one-new>.md`, set Agent ID = `test` in settings, then **close and reopen the graph view** (the file watcher binds at view-open time and doesn't auto-rewatch on settings changes). Only the new atom should be shown — not the 20 base atoms.
- [ ] **S12: Reload command works.** Use the command palette → "Reload Memory Kernel Graph from disk" — graph re-renders without restarting Obsidian.
- [ ] **S13: maxNodesShown degrades gracefully.** Set max to 10. Reload graph. Only 10 nodes render and they're the most-cited (highest inbound).
- [ ] **S14: View closes cleanly.** Close the leaf, reopen via command. No memory leak warning in console; no orphaned canvas elements (inspect DOM).

## Pass/fail

Record results inline (replace `[ ]` with `[x]` or `[FAIL: <reason>]`). All must pass before tagging v0.1.0.
