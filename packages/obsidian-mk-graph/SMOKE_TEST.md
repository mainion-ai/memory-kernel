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

2. Make a smoke-test vault somewhere persistent (`/tmp/` gets reaped between sessions on macOS):
   ```bash
   mkdir -p ~/mk-graph-smoke && cd ~/mk-graph-smoke
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

5. Open `~/mk-graph-smoke` in Obsidian. Trust the vault. Settings → Community plugins → enable "Memory Kernel Graph". Then click the gear icon next to the plugin name → set **Memory directory** to `memory` (override the `.mk` default for this smoke walk).

6. **If you rebuild during the walk** (`npm run build`), invalidate Obsidian's plugin-bundle cache with **`Cmd+Shift+R`** (macOS) or **`Ctrl+Shift+R`** (Linux/Windows) — `Cmd+P → Reload app without saving` is NOT enough. The cache trap costs hours; the hard reload costs a second.

## Checklist

- [X] **S1: View opens.** Click the ribbon icon (a small graph icon, looks like a `git-branch` glyph) in the left sidebar. The right pane opens with the graph view. (Side pane is intentional — atoms open as tabs in the main area when clicked. See README.)

- [X] **S2: Nodes render.** 20 nodes visible, distributed by force layout. No errors in DevTools Console (`Cmd+Option+I` on macOS, `Ctrl+Shift+I` on Linux/Windows; switch to the Console tab).

- [X] **S3: F2 color = type, tooltip works.** Hover any node — a tooltip appears showing the atom id, type, status, classification, citation count, and tags. Confirm fill colors match the spec palette: fact=green, belief=blue, decision=orange, open_question=purple, preference=pink, constraint=red, procedure=teal, entity_summary=yellow, conflict=deep-orange.

- [X] **S4: F2 border = classification.** SECRET atoms have a red ring with a 🔒 glyph; PERSONAL atoms have an orange ring; PUBLIC atoms have a green ring; TEAM atoms (the default) have a blue ring. The fixture has at least one of each.

- [X] **S5: F2 opacity = status.** Compare a `rejected` atom (try `BELI-2026-04-11-FIX10-aa10` per the fixture's status cycle — atoms 6, 16 are rejected; atoms 7, 17 are superseded; atoms 9, 19 are resolved; atoms 8, 18 are archived) against an `active` atom. Rejected/archived/superseded should appear visibly dimmer.

- [X] **S6: F2 size = log-citations.** Atoms with more inbound edges appear larger. The fixture's most-cited atoms (atoms with `linkCount` 4 from many sources) should be noticeably bigger than leaf atoms (atom 0, which has 0 outbound and few inbound).

- [X] **S7: Edges encode type / source / confidence.** You should see at least three different edge styles in the graph:
  - **Solid edges** = `source: manual` (or no `source` field).
  - **Dashed edges** = `source: extracted` (long-dash pattern, e.g. 5px on / 3px off).
  - **Dotted edges** = `source: enriched` (short-dot pattern, 2px on / 3px off).
  Edge colors vary by relation type (extends=blue, supports=green, contradicts=dark-red, caused_by=purple, related=grey). Edge opacity varies by relation `confidence`. Hover an edge — no crash even if force-graph doesn't render an edge tooltip.

- [ ] **S8: Click opens atom file.** Click any node — the atom .md file opens as a new TAB in the main pane. (If you set memoryDir to `memory` per Setup §5, this works; if you used `.mk/`, you'll get a "Folder already exists" Notice — that's the dot-folder issue documented in the README.)

- [X] **S9: Settings persist.** Settings (gear icon, bottom-left) → "Community plugins" → click the **gear/cog icon** next to "Memory Kernel Graph" → toggle "Border = classification" off. Close Obsidian completely (`Cmd+Q`), reopen, return to the same settings panel — the toggle remains off, and the graph view shows nodes without classification rings.

- [X] **S10: Live mode picks up changes.** With the graph view open, run this command — it sleeps 3 seconds then creates a new atom. Switch focus to Obsidian within those 3 seconds and watch a fresh SECRET node (with a 🔒 glyph) pop into the graph:
  ```bash
  sleep 3 && cat > ~/mk-graph-smoke/memory/ENTITIES/FACT-2026-05-02-LIVE-zz99.md <<'EOF'
  ---
  id: FACT-2026-05-02-LIVE-zz99
  type: fact
  status: active
  confidence: 1.0
  created_at: "2026-05-02T12:00:00Z"
  updated_at: "2026-05-02T12:00:00Z"
  ttl_days: null
  classification: SECRET
  ---

  Live-mode test atom — should appear immediately in the graph.
  EOF
  ```
  Clean up after the test:
  ```bash
  rm ~/mk-graph-smoke/memory/ENTITIES/FACT-2026-05-02-LIVE-zz99.md
  ```

- [ ] **S11: Per-agent isolation routes correctly.** Create a new atom under an agent-specific subdirectory, then verify the file actually landed before testing the routing:
  ```bash
  mkdir -p ~/mk-graph-smoke/memory/agents/test/ENTITIES
  cat > ~/mk-graph-smoke/memory/agents/test/ENTITIES/FACT-2026-05-02-AGENT-bb00.md <<'EOF'
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

  # VERIFY the heredoc actually wrote the file:
  ls -la ~/mk-graph-smoke/memory/agents/test/ENTITIES/
  ```
  The `ls` output should show exactly one file: `FACT-2026-05-02-AGENT-bb00.md`. If it shows nothing or a different name, the heredoc failed — re-run the command and check your shell.

  Once the file exists: in plugin settings, set **Agent ID** to `test`. **Close and reopen the graph view** (the file watcher binds at view-open time and doesn't auto-rewatch on settings changes). Only the new atom should be shown — not the 20 base atoms.

  ⚠ **Looks empty?** With only one atom and no `events.ndjson` in the agent dir, the graph renders a single ~4–6px dot at canvas origin — easy to miss against the dark background. Since v0.2.2 the renderer auto-zooms-to-fit on the first non-empty render, so the single atom should be visibly centered with padding. If it still looks empty: scroll-zoom in (mouse wheel), and confirm `app.plugins.plugins['obsidian-mk-graph'].settings` in DevTools Console shows `agentId: 'test'` and `maxNodesShown >= 1`.

  Clean up:
  ```bash
  rm -rf ~/mk-graph-smoke/memory/agents
  ```
  Reset Agent ID to empty in plugin settings.

- [X] **S12: Reload command works.** Open the command palette with `Cmd+P` (macOS) or `Ctrl+P` (Linux/Windows), type "Memory Kernel" — the palette filters to "Reload Memory Kernel Graph from disk". Press Enter. The graph re-renders without restarting Obsidian.

- [X] **S13: maxNodesShown degrades gracefully.** Plugin settings → **Max nodes shown** field at the bottom. Change `5000` to `10`. Open the command palette → "Reload Memory Kernel Graph from disk". Only 10 nodes render — the most-cited 10. (Reset to 5000 when done.)

- [ ] **S14: View closes cleanly.** Step-by-step:
  1. Open Obsidian's DevTools: `Cmd+Option+I` on macOS, `Ctrl+Shift+I` on Linux/Windows. A panel attaches to the bottom or right of the Obsidian window.
  2. In the DevTools tab strip at the top, click **Elements** (leftmost tab — looks like `<>` or `Elements`). If you don't see it, click the `>>` overflow chevron to reveal hidden tabs.
  3. With the graph view open, click anywhere inside the Elements tree, then press `Cmd+F` (macOS) / `Ctrl+F` (other) to summon the DOM search box.
  4. Type `class="mk-graph-tooltip"` (with the equals + quote — this only matches the actual element, not the CSS rules inlined into the `<style>` tag). You should see exactly **one** match — the tooltip div mounted by the renderer.
  5. Close the graph leaf: the view opens in the right side pane (intentional — see S1), so `Cmd+W` from a focused side leaf may not close it. Right-click the leaf's tab header → Close, or drag the leaf's title bar onto the main pane and then `Cmd+W`.
  6. Press `Cmd+F` again in Elements and search `class="mk-graph-tooltip"` — should be 0 matches now.
  7. Click the **Console** tab in DevTools. No `Memory leak`, `Detached`, or red error messages should appear.
  8. Reopen the graph via the ribbon icon. The view should render cleanly. Re-search `class="mk-graph-tooltip"` in Elements — exactly one match again (a fresh tooltip element).

## Pass/fail

Record results inline (replace `[ ]` with `[x]` or `[FAIL: <reason>]`). All must pass before tagging v0.1.x.

## Phase 3 walks (introduced in v0.2.0)

### S5: scrubber renders with histogram

1. Build & install the plugin: `npm run build` in `<repo>/packages/obsidian-mk-graph/`, copy `main.js`, `manifest.json`, `styles.css` into `<vault>/.obsidian/plugins/obsidian-mk-graph/` (or rely on the symlinks set up in Phase 2 setup §4).
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
2. In a separate terminal, append a new atom to the memory dir: `mk add fact "smoke test S7" --memory-dir <vault>/memory` (the smoke vault uses `memory/` not `.mk/` — see Setup §3).
3. **Expect:** within ~250ms, the new atom appears in the graph. The histogram gains a bar for the current day (or the height of today's bar increases).

### S8: diff mode shows added/removed/mutated

1. Click "Diff". Set the diff range to span the last archive event (Phase 3 ships with two fixture archives at 2026-04-26).
2. **Expect:** the two archived atoms render in red (ghost opacity), any atoms created within the range render in green, the one updated atom (atoms[10] from the fixture) renders in amber. Edges connecting an added or removed node take the same color.

### S9: timeline layout

1. Switch to "Force-directed" → "Timeline" via the layout dropdown in plugin settings (or the layout toggle if present in the view header).
2. **Expect:** atoms snap to a left-to-right timeline: oldest on the left, newest on the right. Vertical bands separate atom types — facts at the top, conflicts at the bottom. Edges are straight lines. The force simulation is paused (no jitter).
3. Switch back to "Force-directed".
4. **Expect:** atoms unsnap; the simulation resumes packing them by relation.

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
