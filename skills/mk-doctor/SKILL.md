---
name: mk-doctor
description: Diagnose and fix memory-kernel setup issues for any agent host — NanoClaw, OpenClaw, MCP clients (Claude Desktop / Cursor), or a plain native install. Verifies the universal store (atoms, events, index, lifecycle atoms, semantic health, drift) and then runs host-specific checks (mounts, plugin doctrine, MCP wiring, cron). Use when atoms are missing, CLAUDE.md is empty, recall feels off, the agent doesn't seem to remember anything across sessions, or you want a health check before debugging further. Triggers on "mk doctor", "memory-kernel diagnose", "atoms missing", "CLAUDE.md empty", "memory-kernel broken", "agent memory not working", "mk-memory health", "diagnose mk", "memory-kernel check", "verify memory setup".
---

# Memory-Kernel Doctor

Self-diagnostic for memory-kernel. Runs a layered set of checks: universal first (the memory store itself), then host-specific (NanoClaw mounts, OpenClaw plugin/doctrine, MCP wiring, native cron). Fixes what it can; reports what it can't.

**Principle:** when something is broken, fix it rather than telling the user to fix it themselves. Ask permission for anything that touches their config or installs software, but otherwise just do the work.

---

## Step 1: Triage — what's the symptom?

Run `AskUserQuestion` to scope the diagnosis. Options:

- **"I don't know — run all checks"** *(default; thorough but slower)*
- **"No atoms / store seems empty"** → jump to Steps 3, 6, 7
- **"CLAUDE.md is empty or stale"** → jump to Steps 5, 7 plus host-specific render check
- **"Recall returns irrelevant atoms"** → jump to Steps 3, 4, plus `mk lint`/`mk closure`
- **"Agent doesn't see memory at all (mounts / wiring)"** → jump to Step 8 (host-specific)
- **"Memory feels stale across sessions"** → jump to Steps 5, 9 (cron)

If you skip ahead, still run Step 2 first (it sets `MEMORY_DIR` and detects host — every other step needs both).

---

## Step 2: Detect environment and host

The doctor adapts its checks to where memory-kernel is being used. Detect both the *environment* (am I in a container? on the host?) and the *host* (NanoClaw, OpenClaw, MCP client, generic).

### Locate the memory directory

Try in order:

```bash
# 1. Explicit env var (set by mk-memory-setup for drift, or by user)
[ -n "$MEMORY_DIR" ] && [ -d "$MEMORY_DIR" ] && echo "from env: $MEMORY_DIR"

# 2. Common defaults
for p in "$MEMORY_DIR" ~/mk-memory ~/repos/memory/kernel /workspace/extra/memory; do
  [ -d "$p/ENTITIES" ] && MEMORY_DIR="$p" && break
done

# 3. NanoClaw container_config (if NanoClaw DB is reachable)
NANOCLAW_DB=""
for p in ~/nanoclaw/store/messages.db ~/Documents/nanoclaw/store/messages.db; do
  [ -f "$p" ] && NANOCLAW_DB="$p" && break
done
if [ -z "${MEMORY_DIR:-}" ] && [ -n "$NANOCLAW_DB" ]; then
  MEMORY_DIR=$(sqlite3 "$NANOCLAW_DB" "SELECT json_extract(container_config, '$.additionalMounts[0].hostPath') FROM registered_groups WHERE is_main = 1;" 2>/dev/null)
fi

echo "Memory dir: ${MEMORY_DIR:-NOT FOUND}"
```

If still not found, ask the user via `AskUserQuestion` for the absolute path.

### Detect host

```bash
HOST_HINTS=()

# NanoClaw container — strong signal
[ -d /workspace/group ] && [ -f /.dockerenv ] && HOST_HINTS+=("nanoclaw-container")

# NanoClaw host-side
[ -f ~/.config/nanoclaw/mount-allowlist.json ] && HOST_HINTS+=("nanoclaw-host")
pgrep -f nanoclaw >/dev/null 2>&1 && HOST_HINTS+=("nanoclaw-host")

# OpenClaw — plugin or config files
find ~/openclaw ~/.config/openclaw -maxdepth 2 -type f 2>/dev/null | head -1 | grep -q . && HOST_HINTS+=("openclaw")
[ -f ./package.json ] && grep -q "openclaw-memory-kernel" ./package.json 2>/dev/null && HOST_HINTS+=("openclaw")

# MCP client — Claude Desktop config
[ -f "$HOME/Library/Application Support/Claude/claude_desktop_config.json" ] && HOST_HINTS+=("mcp-claude-desktop")
[ -f "$HOME/.config/Claude/claude_desktop_config.json" ] && HOST_HINTS+=("mcp-claude-desktop")

echo "Detected hosts: ${HOST_HINTS[*]:-none (treating as generic native)}"
```

If multiple hosts are detected (or zero), ask `AskUserQuestion` which one this diagnosis should focus on. The universal checks run regardless; only the host-specific layer at Step 8 differs.

---

## Step 3: Universal — memory directory layout

```bash
ls -la "$MEMORY_DIR"/
```

Expected directories: `ENTITIES/`, `ARCHIVE/`, `EVIDENCE/`, `CONFLICTS/`, `EPISODES/`, `KNOWLEDGE/` (with `KNOWLEDGE/README.md` + `KNOWLEDGE/draft/`). Expected files: `events.ndjson`, optionally `.memory-index.db`, optionally `config.yaml` (for per-agent isolation).

**Missing directories:** `mk init "$MEMORY_DIR"` recreates them safely (no-op for existing ones).

**`ENTITIES/` empty:** the store was initialised but never seeded. Fresh setup is fine; otherwise jump to Step 7.

---

## Step 4: Universal — `mk doctor` (schema and links)

```bash
npx mk doctor -d "$MEMORY_DIR" --json
```

Validates atom frontmatter, broken atom-ID references, active conflicts, and graph-connectivity gaps (prose that names another atom without a formal relation). JSON output makes it easy to act on programmatically.

**`mk: command not found`** — the CLI isn't installed. Don't auto-install into `/tmp` without asking. Use `AskUserQuestion`:

- *"Install memory-kernel CLI globally now? (`npm install -g memory-kernel`)"* — recommended on host
- *"Install temporarily into `/tmp` for this session?"* — recommended in container if global install isn't possible
- *"Skip — I'll install it myself"*

**Broken links:** report which atom references which missing target. Offer to run `mk relink --apply` (regenerates relations from body text).

**Orphan prose refs** (`orphan-prose-refs`, warn): an atom's body names another *existing* atom (e.g. "Extends BELI-…") but has no matching `relations[]` entry — so the edge is invisible to the graph. Detection-only (the correct relation type is ambiguous from prose). Surface each one and wire the relation manually, or try `mk relink --apply`.

**Active conflicts:** list them; explain that `mk reflect` followed by manual `resolveConflict()` calls (or editing the atom files) is the path forward.

---

## Step 5: Universal — `mk lint` (semantic health)

```bash
npx mk lint -d "$MEMORY_DIR" --json
```

Where `mk doctor` validates *structure*, `mk lint` validates *meaning*. It reports:

- Contradictions between atoms covering the same scope
- Stale atoms (no updates for `--stale-days`)
- Orphans (no incoming or outgoing relation edges)
- Near-duplicates (high body similarity)
- Confidence drift (confidence value never changes despite repeated updates)
- TTL warnings (atoms close to expiry)

Lint never auto-fixes — its job is to surface trouble. Read the output and decide: archive the stale ones, dedupe the near-duplicates manually, resolve the contradictions, etc. If the same `lint` run reports identical issues across multiple invocations, the agent is accumulating stale knowledge and may need a `mk reflect && mk gc` pass.

---

## Step 6: Universal — `mk closure` (drift detection)

```bash
npx mk closure -d "$MEMORY_DIR" --trajectory --trajectory-days 14 --json
```

Reports `closure_index`, `entanglement_pct`, and `phase`. Interpret:

- `phase: early` (< 20 atoms) — too small to draw conclusions; stop here.
- `closure_index < 3` — healthy. Atoms are still mostly external knowledge; LLM classifiers and cross-agent transplant work fine.
- `closure_index 3–5` — entanglement growing. Beliefs increasingly reference other beliefs. Watch the trajectory; if it's climbing fast, consider seeding more facts (external, verifiable knowledge) to balance the type composition.
- `closure_index > 5` — high closure. The agent may reason in circles, over-reference its own prior conclusions, and resist updating on new evidence. Run `mk lint` looking for confidence drift; consider archiving older beliefs.

The trajectory mode plots the last N days so you see whether closure is stable, climbing, or accelerating.

---

## Step 7: Universal — store integrity

### Index built?

```bash
npx mk status -d "$MEMORY_DIR" --json
```

If status reports the index is missing or out of sync with `ENTITIES/`:

```bash
npx mk reindex -d "$MEMORY_DIR"
```

Reindex is safe; it derives entirely from files. If embeddings are configured (`EMBEDDING_PROVIDER` set), pass `--embed` to recompute them too.

### Event log non-empty?

```bash
wc -l "$MEMORY_DIR/events.ndjson"
```

If 0 lines but `ENTITIES/` has files, the atoms predate event sourcing or were imported manually. Fix:

```bash
npx mk bootstrap-events -d "$MEMORY_DIR"
```

This synthesises `atom_imported` events from existing files so `mk replay` and `mk merge` work correctly.

### Lifecycle atoms present?

The agent's operating manual should live as 8 atoms tagged `session-loop` (7 procedure + 1 constraint), seeded by `mk-memory-setup` Step 8b. If they're missing, the agent has no in-memory guidance on when to wander, when to lint, or the A2A handoff protocol.

```bash
LIFECYCLE_COUNT=$(npx mk recall -d "$MEMORY_DIR" --types procedure,constraint --json 2>/dev/null | jq -r '[.atoms[] | select(.tags[]? == "session-loop")] | length' 2>/dev/null || echo 0)
echo "Lifecycle atoms found: $LIFECYCLE_COUNT (expected: 8)"
```

If `< 8`, the agent was likely set up before the lifecycle seeding step existed (or someone archived the atoms). Offer to re-seed:

> *"This agent is missing its lifecycle atoms. Run `/mk-memory-setup` Step 8b to seed them, or run the bundled `seed-atoms/seed-lifecycle.sh` directly. Want me to do that now?"*

If yes, locate the `mk-memory-setup` skill directory and invoke `bash <skill-dir>/seed-atoms/seed-lifecycle.sh "$MEMORY_DIR"`.

### Seed initial identity atom (only if `ENTITIES/` is otherwise empty)

For a fresh installation with literally no atoms — different from "missing lifecycle":

```bash
npx mk remember "Memory-kernel initialised. This agent uses persistent typed memory across sessions." \
  -d "$MEMORY_DIR" -t fact --tags setup,identity
```

Then prompt the user to run `/mk-memory-setup` for a full identity + lifecycle seed.

---

## Step 8: Host-specific checks

Branch on the host(s) detected at Step 2.

### NanoClaw (container or host)

**Mount visibility (only run inside the container):**

```bash
[ -d /workspace/extra/memory/ENTITIES ] || echo "MOUNT MISSING"
touch /workspace/extra/memory/.write-test 2>/dev/null && rm /workspace/extra/memory/.write-test && echo "WRITABLE" || echo "READ-ONLY"
```

**Mount allowlist (only run on the host):**

```bash
test -f ~/.config/nanoclaw/mount-allowlist.json && jq . ~/.config/nanoclaw/mount-allowlist.json
```

**Container config has memory mount (host):**

```bash
sqlite3 "$NANOCLAW_DB" "SELECT json_extract(container_config, '$.additionalMounts') FROM registered_groups WHERE is_main = 1;"
```

If any of these report a problem, refer the user to `mk-memory-setup` Steps 5–7 and `references/nanoclaw.md`. Typical fixes:

- Allowlist missing → `mk-memory-setup` Step 5
- Mount missing or read-only → Step 6 (update `container_config`)
- Container can't see new mount → restart NanoClaw (Step 11)

### OpenClaw

**Plugin loaded:**

```bash
[ -f ./package.json ] && grep -q "openclaw-memory-kernel" ./package.json && echo "plugin in deps"
```

**Doctrine files present:**

```bash
test -f AGENTS.md && grep -q "mk_remember" AGENTS.md && echo "AGENTS.md routes to mk"
test -f MEMORY.md && grep -q "memory-kernel" MEMORY.md && echo "MEMORY.md declares mk as primary"
```

**Compaction routing:** the host's compaction prompt should explicitly route durable content to `mk_remember` *first*, before anything is written to a file. There's no automated check — read the compaction prompt and verify. See `docs/host-integration-doctrine.md` for the canonical phrasing.

If any of these are missing, point the user at the OpenClaw section of `mk-memory-setup` (`references/openclaw.md`) and `docs/host-integration-doctrine.md`.

### MCP clients (Claude Desktop, Cursor, generic)

```bash
# Locate the config
for p in "$HOME/Library/Application Support/Claude/claude_desktop_config.json" \
         "$HOME/.config/Claude/claude_desktop_config.json"; do
  [ -f "$p" ] && CONFIG="$p" && break
done

# Confirm memory-kernel server entry exists
[ -n "$CONFIG" ] && jq '.mcpServers["memory-kernel"]' "$CONFIG"

# Confirm MEMORY_DIR points at the right place
[ -n "$CONFIG" ] && jq -r '.mcpServers["memory-kernel"].env.MEMORY_DIR' "$CONFIG"
```

If the entry is missing, refer to `mk-memory-setup` `references/mcp-client.md` for the canonical config snippet.

### Native cron (host with no other host integration)

```bash
crontab -l 2>/dev/null | grep -E "(mk reflect|mk render)" | head -5
```

**No matching cron line:** memory will go stale unless reflect+render run periodically. The canonical line `mk-memory-setup` Step 10 installs is:

```bash
0 23 * * * cd <MEMORY_DIR> && npx mk reflect -d . --agent-id <AGENT_NAME> --session-id nightly-$(date +\%Y\%m\%d) && npx mk render <MEMORY_DIR> <CLAUDE_MD_PATH> [&& git add -A && git commit -m "nightly sync $(date +\%Y-\%m-\%d)" --allow-empty && git push] 2>&1 | logger -t memory-sync
```

Read the existing crontab carefully before suggesting an addition — cron de-duplicates by exact string match, so a near-duplicate line will run *both* and double up the work. If a similar line is already there, propose editing it rather than appending.

---

## Step 9: Render check (host-aware)

The agent only "sees" memory when it's surfaced into whatever the host loads at session start.

| Host | What to check |
|------|---------------|
| NanoClaw | `head -20 /workspace/group/CLAUDE.md` (in container) or the host path resolved from the NanoClaw DB |
| OpenClaw | Plugin's bootstrap hook output — atoms injected into the agent's context. No file to grep, but `mk recall --task <something> --json` should return atoms. |
| MCP clients | Start the MCP server and call the `mk_recall` tool — atoms come back as a tool response. |
| Native | Wherever `mk render` writes (the path passed to setup's Step 9). |

If the rendered output is empty but atoms exist:

```bash
npx mk render "$MEMORY_DIR" "$CLAUDE_MD_PATH"
head -20 "$CLAUDE_MD_PATH"
```

---

## Summary report

After all checks, print a single block. Substitute the values gathered along the way; mark unknown lines as `?`.

```
Memory-Kernel Health Check
──────────────────────────
Environment:    container | native
Host:           nanoclaw | openclaw | mcp-client | native | mixed
Memory dir:     {path}
Atoms:          {count} ({by_type})
Events:         {count}
Index:          ✓ built | ✗ missing
mk doctor:      ✓ healthy | ✗ {N} structural issues
mk lint:        ✓ healthy | ⚠ {N} semantic warnings
Closure:        index {x.x} (phase: {phase})
Lifecycle:      {N}/8 session-loop atoms present
Render:         ✓ {lines} lines | ✗ empty | (n/a for this host)
Host-specific:  ✓ all checks passed | ✗ {summary of issues}
```

If any non-✓ rows appear, list the concrete next action for each below the block.
