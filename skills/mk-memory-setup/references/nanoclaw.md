# NanoClaw Host Integration

Host-specific setup for **NanoClaw**, where the agent runs inside a container and consumes memory by loading a rendered `CLAUDE.md` at session start.

This file is loaded by `SKILL.md` only when the host is detected (or selected) as NanoClaw. Universal steps (install CLI, init store, seed atoms, schedule reflect) live in `SKILL.md`; this file covers only the NanoClaw-specific plumbing.

---

## What NanoClaw needs

- A **mount allowlist** (`~/.config/nanoclaw/mount-allowlist.json`) telling NanoClaw it's allowed to bind a memory directory into the container. Without this file, NanoClaw silently blocks all additional mounts — no error, no warning, the agent just can't see the memory files.
- An **`additionalMounts` entry in `container_config`** (stored in the NanoClaw SQLite DB at `<NANOCLAW_DIR>/store/messages.db`) telling NanoClaw *where* to mount the memory directory inside the container.
- **Conversation-log and impulse-queue symlinks** so the kernel's extract/wander commands can see what NanoClaw recorded.
- A **restart** of NanoClaw to pick up the new container config.

The container always sees memory at `/workspace/extra/memory` and renders into `/workspace/group/CLAUDE.md`. NanoClaw prepends `/workspace/extra/` to every `containerPath` you write into `additionalMounts` — so the path stored in the DB must be **relative** (`memory`, not `/memory`).

---

## Step N1: Locate NanoClaw

Auto-detect, then confirm with the user:

```bash
NANOCLAW_DIR=$(for p in ~/nanoclaw ~/Documents/nanoclaw ~/projects/nanoclaw ~/repos/nanoclaw; do
  [ -d "$p" ] && echo "$p" && break
done)
echo "Found: $NANOCLAW_DIR"
```

If empty, ask via `AskUserQuestion`: *"Where is your NanoClaw directory installed?"* — accept the absolute path. Store as `{NANOCLAW_DIR}` for use in subsequent steps.

Verify NanoClaw is running so we know the restart at the end will actually do something:

```bash
pgrep -f nanoclaw \
  || systemctl --user status nanoclaw 2>/dev/null \
  || launchctl list | grep nanoclaw 2>/dev/null
```

If not running, warn the user: setup can proceed but the agent won't pick up the new mounts until NanoClaw is started.

---

## Step N2: Mount allowlist

```bash
mkdir -p ~/.config/nanoclaw
cat > ~/.config/nanoclaw/mount-allowlist.json << 'EOF'
{
  "allowedRoots": [
    {
      "path": "{MEMORY_DIR_PARENT}",
      "allowReadWrite": true,
      "description": "Memory-kernel data"
    }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": false
}
EOF
```

`{MEMORY_DIR_PARENT}` is the absolute path of the parent of the memory directory — e.g., `/Users/alice` if memory is at `/Users/alice/mk-memory`, or `/Users/alice/repos` if memory is at `/Users/alice/repos/memory/kernel`. Use the expanded absolute path; do not write `~`.

This file is the most common single point of failure in NanoClaw memory setup. If you hit "agent can't see memory" later, check this file first.

---

## Step N3: Container config — additionalMounts

```bash
NANOCLAW_DIR="{NANOCLAW_DIR}"
DB_PATH="$NANOCLAW_DIR/store/messages.db"
# Older NanoClaw versions stored the DB at a different path
[ ! -f "$DB_PATH" ] && DB_PATH="$NANOCLAW_DIR/data/nanoclaw.db"
echo "DB: $DB_PATH"

# Inspect the current registered group(s)
sqlite3 "$DB_PATH" "SELECT name, folder, container_config FROM registered_groups;"
```

Update the main group's `container_config` to include the memory mount. The `containerPath` is **relative** — NanoClaw prepends `/workspace/extra/`:

```bash
sqlite3 "$DB_PATH" "UPDATE registered_groups SET container_config = json('{
  \"additionalMounts\": [
    {
      \"hostPath\": \"{MEMORY_DIR_ABSOLUTE}\",
      \"containerPath\": \"memory\",
      \"readonly\": false
    }
  ]
}') WHERE is_main = 1;"
```

Verify:

```bash
sqlite3 "$DB_PATH" "SELECT container_config FROM registered_groups WHERE is_main = 1;"
```

The result should show your `hostPath` and `containerPath: "memory"`. Inside the container that becomes `/workspace/extra/memory`.

---

## Step N4: Conversation-log and impulse-queue symlinks

Link NanoClaw's session logs and impulse queue into the memory directory so kernel commands like `mk extract` and `mk wander` can see what the agent did:

```bash
NANOCLAW_DIR="{NANOCLAW_DIR}"
GROUP_FOLDER=$(sqlite3 "$NANOCLAW_DIR/store/messages.db" "SELECT folder FROM registered_groups WHERE is_main = 1;")

# Conversation logs
ln -sf "$NANOCLAW_DIR/groups/$GROUP_FOLDER/logs" "{MEMORY_DIR}/conversations"

# Impulse queue (curiosity captured between sessions)
touch "$NANOCLAW_DIR/groups/$GROUP_FOLDER/impulses.ndjson"
ln -sf "$NANOCLAW_DIR/groups/$GROUP_FOLDER/impulses.ndjson" "{MEMORY_DIR}/impulses.ndjson"
```

---

## Step N5: Render path resolution (used by the universal render + cron steps)

NanoClaw loads `CLAUDE.md` from the group folder at session start. Resolve the absolute path so the universal render step can write to the right place:

```bash
NANOCLAW_DIR="{NANOCLAW_DIR}"
GROUP_FOLDER=$(sqlite3 "$NANOCLAW_DIR/store/messages.db" "SELECT folder FROM registered_groups WHERE is_main = 1;")
CLAUDE_MD="$NANOCLAW_DIR/groups/$GROUP_FOLDER/CLAUDE.md"

echo "Will render to: $CLAUDE_MD"
```

Pass `$CLAUDE_MD` to `npx mk render` and to the cron line.

---

## Step N6: Restart NanoClaw

```bash
# Linux (systemd)
systemctl --user restart nanoclaw

# macOS (launchd)
# launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Wait a moment, then confirm it came back up:

```bash
# Linux
systemctl --user status nanoclaw

# macOS
# launchctl list | grep nanoclaw
```

Without this restart the new mount won't be visible inside the container, and the agent will still report "memory not found" even though everything on the host is configured correctly.

---

## Optional: Drift pre-filter

If NanoClaw has drift enabled (`DRIFT_ENABLED=true`), set `MEMORY_DIR` in the NanoClaw `.env` file (the NanoClaw env, not anywhere inside the memory directory) so NanoClaw can run `mk wander --json` as a Tier-1 gate before each drift session:

```
MEMORY_DIR={MEMORY_DIR}
```

NanoClaw will run `mk wander --json` (~30 ms, no LLM). If no high-dissimilarity collisions are found, drift is skipped entirely. If collisions are found (atom pairs with Jaccard tag dissimilarity > 0.7), their context is injected into the drift prompt for directed exploration.

See [`docs/nanoclaw-integration.md#drift-integration-wander-pre-filter`](../../../../docs/nanoclaw-integration.md#drift-integration-wander-pre-filter) for the full integration.

---

## Container-side commands the agent will run

Inside the NanoClaw container, the agent uses `/workspace/extra/memory` and `/workspace/group/CLAUDE.md` directly:

```bash
# Add a fact during a session
npx mk remember "text" -d /workspace/extra/memory -t fact

# Refresh CLAUDE.md after a burst of writes
npx mk render /workspace/extra/memory /workspace/group/CLAUDE.md
```

`npx mk render` requires `memory-kernel ≥ 1.1.0`. If the container is using an older mounted-source build via `memory-kernel-code`, the legacy fallback works at any version:

```bash
npx tsx /workspace/extra/memory-kernel-code/scripts/render-claude-md.ts \
  /workspace/extra/memory /workspace/group/CLAUDE.md
```

If `npx mk --version` doesn't match the latest release, ask the operator to run `npm update memory-kernel` on the host or refresh the `memory-kernel-code` mount.

---

## NanoClaw-specific troubleshooting

**Agent can't see `/workspace/extra/memory`:**

1. Check the allowlist exists: `cat ~/.config/nanoclaw/mount-allowlist.json`
2. Check the DB has the mount: `sqlite3 "$DB_PATH" "SELECT container_config FROM registered_groups WHERE is_main = 1;"`
3. Check `containerPath` is **relative** — not starting with `/`. NanoClaw prepends `/workspace/extra/`.
4. Restart NanoClaw after any change.

**CLAUDE.md inside the container is empty or stale:**

1. Check atoms exist on the host: `ls {MEMORY_DIR}/ENTITIES/`
2. Re-render manually on the host: `npx mk render {MEMORY_DIR} <path-to-group-CLAUDE.md>`
3. Check the cron is running: `crontab -l | grep memory` and `journalctl -t memory-sync` (or equivalent).

**Container is using `npx tsx` instead of `mk` (legacy):**

The container was set up before `mk render` was published (pre-v1.1.0). Either run `npm install -g memory-kernel` on the host and update the cron to use `mk render`, or refresh the `memory-kernel-code` mount in `container_config` and continue using the `tsx` fallback.
