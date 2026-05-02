# Smoke test — Phase 2 acceptance

Run before tagging `obsidian-mk-graph@0.1.x`. All steps must pass.

## Setup

1. Build the plugin:
   ```bash
   cd <repo>/packages/obsidian-mk-graph
   npm install
   npm run build
   ```
   (`<repo>` = your local memory-kernel checkout root.)

2. Make a temporary vault:
   ```bash
   mkdir -p /tmp/mk-graph-smoke && cd /tmp/mk-graph-smoke
   ```

3. Copy the fixture as a NON-DOT memory directory. Obsidian doesn't index dot-folders, so the conventional `.mk` won't be clickable in S8 — use `memory/` instead for the smoke walk:
   ```bash
   mkdir -p memory
   cp -r <repo>/packages/obsidian-mk-graph/test/fixtures/small-vault/* memory/
   ```

4. Symlink the plugin into the vault (Unix shell — on Windows, copy the three files into the plugin folder instead, or use `mklink /H` from Administrator cmd):
   ```bash
   mkdir -p .obsidian/plugins/obsidian-mk-graph
   ln -sf <repo>/packages/obsidian-mk-graph/main.js .obsidian/plugins/obsidian-mk-graph/main.js
   ln -sf <repo>/packages/obsidian-mk-graph/manifest.json .obsidian/plugins/obsidian-mk-graph/manifest.json
   ln -sf <repo>/packages/obsidian-mk-graph/styles.css .obsidian/plugins/obsidian-mk-graph/styles.css
   ```

5. Open `/tmp/mk-graph-smoke` in Obsidian. Trust the vault. Settings → Community plugins → enable "Memory Kernel Graph". Then click the gear icon next to the plugin name → set **Memory directory** to `memory` (override the `.mk` default for this smoke walk).

## Checklist

- [ ] **S1: View opens.** Click the ribbon icon (a small graph icon, looks like a `git-branch` glyph) in the left sidebar. The right pane opens with the graph view. (Side pane is intentional — atoms open as tabs in the main area when clicked. See README.)

- [ ] **S2: Nodes render.** 20 nodes visible, distributed by force layout. No errors in DevTools Console (`Cmd+Option+I` on macOS, `Ctrl+Shift+I` on Linux/Windows; switch to the Console tab).

- [ ] **S3: F2 color = type, tooltip works.** Hover any node — a tooltip appears showing the atom id, type, status, classification, citation count, and tags. Confirm fill colors match the spec palette: fact=green, belief=blue, decision=orange, open_question=purple, preference=pink, constraint=red, procedure=teal, entity_summary=yellow, conflict=deep-orange.

- [ ] **S4: F2 border = classification.** SECRET atoms have a red ring with a 🔒 glyph; PERSONAL atoms have an orange ring; PUBLIC atoms have a green ring; TEAM atoms (the default) have a blue ring. The fixture has at least one of each.

- [ ] **S5: F2 opacity = status.** Compare a `rejected` atom (try `BELI-2026-04-11-FIX10-aa10` per the fixture's status cycle — atoms 6, 16 are rejected; atoms 7, 17 are superseded; atoms 9, 19 are resolved; atoms 8, 18 are archived) against an `active` atom. Rejected/archived/superseded should appear visibly dimmer.

- [ ] **S6: F2 size = log-citations.** Atoms with more inbound edges appear larger. The fixture's most-cited atoms (atoms with `linkCount` 4 from many sources) should be noticeably bigger than leaf atoms (atom 0, which has 0 outbound and few inbound).

- [ ] **S7: Edges encode type / source / confidence.** You should see at least three different edge styles in the graph:
  - **Solid edges** = `source: manual` (or no `source` field).
  - **Dashed edges** = `source: extracted` (long-dash pattern, e.g. 5px on / 3px off).
  - **Dotted edges** = `source: enriched` (short-dot pattern, 2px on / 3px off).
  Edge colors vary by relation type (extends=blue, supports=green, contradicts=dark-red, caused_by=purple, related=grey). Edge opacity varies by relation `confidence`. Hover an edge — no crash even if force-graph doesn't render an edge tooltip.

- [ ] **S8: Click opens atom file.** Click any node — the atom .md file opens as a new TAB in the main pane. (If you set memoryDir to `memory` per Setup §5, this works; if you used `.mk/`, you'll get a "Folder already exists" Notice — that's the dot-folder issue documented in the README.)

- [ ] **S9: Settings persist.** Settings (gear icon, bottom-left) → "Community plugins" → click the **gear/cog icon** next to "Memory Kernel Graph" → toggle "Border = classification" off. Close Obsidian completely (`Cmd+Q`), reopen, return to the same settings panel — the toggle remains off, and the graph view shows nodes without classification rings.

- [ ] **S10: Live mode picks up changes.** With the graph view open, append a newline to one fixture atom from the terminal:
  ```bash
  echo "" >> /tmp/mk-graph-smoke/memory/ENTITIES/FACT-2026-04-01-FIX00-aa00.md
  ```
  Within ~1 second, the graph re-renders (force-graph re-runs the simulation; you'll see nodes settle).

- [ ] **S11: Per-agent isolation routes correctly.** Create a new atom under an agent-specific subdirectory:
  ```bash
  mkdir -p /tmp/mk-graph-smoke/memory/agents/test/ENTITIES
  cat > /tmp/mk-graph-smoke/memory/agents/test/ENTITIES/FACT-2026-05-02-AGENT-bb00.md <<'EOF'
  ---
  id: FACT-2026-05-02-AGENT-bb00
  type: fact
  status: active
  confidence: 0.9
  created_at: "2026-05-02T10:00:00Z"
  updated_at: "2026-05-02T10:00:00Z"
  ttl_days: null
  classification: PERSONAL
  ---

  Single atom only visible when Agent ID = test.
  EOF
  ```
  In plugin settings, set **Agent ID** to `test`. **Close and reopen the graph view** (the file watcher binds at view-open time and doesn't auto-rewatch on settings changes). Only the new atom should be shown — not the 20 base atoms.

- [ ] **S12: Reload command works.** Open the command palette with `Cmd+P` (macOS) or `Ctrl+P` (Linux/Windows), type "Memory Kernel" — the palette filters to "Reload Memory Kernel Graph from disk". Press Enter. The graph re-renders without restarting Obsidian.

- [ ] **S13: maxNodesShown degrades gracefully.** Plugin settings → **Max nodes shown** field at the bottom. Change `5000` to `10`. Open the command palette → "Reload Memory Kernel Graph from disk". Only 10 nodes render — the most-cited 10. (Reset to 5000 when done.)

- [ ] **S14: View closes cleanly.** Open DevTools (`Cmd+Option+I` macOS / `Ctrl+Shift+I`). Switch to the Elements tab, search the DOM tree (`Cmd+F`) for `mk-graph-tooltip`. You should see one match. Close the graph leaf (right-click leaf header → Close, or focus the leaf and `Cmd+W`). Re-search for `mk-graph-tooltip` — should be 0 matches. Switch to Console — no `Memory leak` or `Detached` warnings. Reopen the graph via ribbon. View renders cleanly with a fresh tooltip element.

## Pass/fail

Record results inline (replace `[ ]` with `[x]` or `[FAIL: <reason>]`). All must pass before tagging v0.1.x.
