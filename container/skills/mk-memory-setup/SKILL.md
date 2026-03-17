---
name: mk-memory-setup
description: Set up memory-kernel for a NanoClaw agent — persistent memory across sessions. Use when user asks to set up memory, install memory-kernel, add persistent memory, or configure agent memory. Triggers on "setup memory", "memory-kernel", "mk-memory-setup", "add memory", "persistent memory".
allowed-tools: Bash(mk-memory-setup:*)
---

# Memory-Kernel Setup

Set up persistent memory for a NanoClaw agent. This creates a file-based memory system (atoms, events, beliefs) that survives across sessions via CLAUDE.md rendering.

**Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves. Ask for permission when needed, then do the work.

**UX Note:** Use `AskUserQuestion` for all user-facing questions.

## 0. Preflight Checks

Before anything else, verify the environment. Run each check and report results:

```bash
node --version    # Need >= 20.0.0
git --version     # Need git
gh auth status    # Need GitHub CLI authenticated
sqlite3 --version # Need sqlite3
docker --version  # Need Docker (NanoClaw container runtime)
```

**If any missing:**
- `node`: Install via nvm or nodesource. Don't proceed without Node 20+.
- `git`: `sudo apt install git` (Linux) or `brew install git` (macOS)
- `gh`: `sudo apt install gh` or `brew install gh`, then `gh auth login`
- `sqlite3`: `sudo apt install sqlite3` (Linux) or `brew install sqlite3` (macOS)
- `docker`: Should already be running if NanoClaw works. Just verify.

Also verify NanoClaw is running:
```bash
# Check the NanoClaw process
pgrep -f nanoclaw || systemctl --user status nanoclaw 2>/dev/null || launchctl list | grep nanoclaw 2>/dev/null
```

If NanoClaw is not running, warn the user. Memory setup can proceed but the agent won't use it until NanoClaw restarts.

## 1. Ask Configuration

Use `AskUserQuestion` to gather setup details:

**Question 1: Memory directory**
"Where should the memory data be stored?"
- `~/mk-memory` (Recommended) — Simple, top-level
- `~/repos/memory/kernel` — If user prefers repos/ structure
- Custom path

**Question 2: Agent name**
"What is the agent's name? (used in commits, cron IDs, and identity)"
- Free text input

**Question 3: GitHub username**
"What GitHub username should own the memory repo? (e.g., nano-ai-agent)"
- Free text input

**Question 4: Identity description**
"Describe this agent in 1-2 sentences (becomes the identity atom):"
- Free text input

Store all values for use in subsequent steps.

## 2. Install memory-kernel CLI

```bash
npm install -g memory-kernel
```

Verify:
```bash
npx mk --version
```

If the install fails, try with sudo or fix npm permissions:
```bash
mkdir -p ~/.npm-global && npm config set prefix '~/.npm-global'
export PATH=~/.npm-global/bin:$PATH
npm install -g memory-kernel
```

## 3. Initialize Memory Directory

```bash
mkdir -p {MEMORY_DIR}
cd {MEMORY_DIR}
npx mk init .
```

This creates:
- `ENTITIES/` — canonical atom storage (beliefs, facts, decisions, etc.)
- `CONFLICTS/` — merge conflict atoms
- `ARCHIVE/` — archived/superseded atoms
- `EVIDENCE/` — supporting evidence files
- `EPISODES/` — long-form episode notes
- `events.ndjson` — event log (source of truth for event sourcing)
- `.memory-index.db` — SQLite index (derived, rebuildable)

Verify the directory structure:
```bash
ls -la {MEMORY_DIR}
```

If any directories are missing, create them:
```bash
mkdir -p {MEMORY_DIR}/{ENTITIES,CONFLICTS,ARCHIVE,EVIDENCE,EPISODES}
```

## 4. Git Init + GitHub Repo

```bash
cd {MEMORY_DIR}/..
# If memory dir is ~/mk-memory, init the parent isn't needed — init at mk-memory level
cd {MEMORY_DIR}
git init
git add -A
git commit -m "Initial memory-kernel setup"
```

Create GitHub repo and push:
```bash
gh repo create {GITHUB_USER}/memory --private --source=. --remote=origin --push
```

**If `gh repo create` fails with "remote origin already exists":**
```bash
git remote set-url origin https://github.com/{GITHUB_USER}/memory.git
git push -u origin main
```

**If repo already exists on GitHub:**
```bash
git remote add origin https://github.com/{GITHUB_USER}/memory.git
git push -u origin main
```

Verify:
```bash
git remote -v
gh repo view {GITHUB_USER}/memory
```

## 5. Clone memory-kernel Code (for render script)

The render script (`scripts/render-claude-md.ts`) is in the memory-kernel source repo, not the npm package. Clone it:

```bash
# Clone next to memory dir
KERNEL_CODE_DIR=$(dirname {MEMORY_DIR})/memory-kernel-code
git clone https://github.com/mainion-ai/memory-kernel.git "$KERNEL_CODE_DIR"
cd "$KERNEL_CODE_DIR"
npm install
```

**Important:** `npm install` is required — the render script depends on `zod`, `gray-matter`, etc.

Verify:
```bash
npx tsx "$KERNEL_CODE_DIR/scripts/render-claude-md.ts" --help 2>/dev/null || echo "Render script ready"
```

## 6. Create Mount Allowlist

NanoClaw silently blocks ALL additional container mounts unless an allowlist exists. This is the #1 gotcha in memory-kernel setup.

```bash
mkdir -p ~/.config/nanoclaw
```

Write the allowlist:
```bash
cat > ~/.config/nanoclaw/mount-allowlist.json << 'EOF'
{
  "allowedRoots": [
    {
      "path": "{MEMORY_DIR_PARENT}",
      "allowReadWrite": true,
      "description": "Memory-kernel repositories"
    }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": false
}
EOF
```

Where `{MEMORY_DIR_PARENT}` is the parent of the memory directory (e.g., `~` if memory is at `~/mk-memory`, or `~/repos` if at `~/repos/memory/kernel`). Use the expanded absolute path, not `~`.

**Critical:** Without this file, mounts silently fail. No error, no warning — the agent just can't see the memory files.

## 7. Configure NanoClaw Container Mounts

Find the NanoClaw database:
```bash
# Try common locations
NANOCLAW_DIR=$(find ~ -maxdepth 2 -name "nanoclaw" -type d 2>/dev/null | head -1)
DB_PATH="$NANOCLAW_DIR/store/messages.db"
# Fallback for older versions
[ ! -f "$DB_PATH" ] && DB_PATH="$NANOCLAW_DIR/data/nanoclaw.db"
echo "DB: $DB_PATH"
```

Find the registered group:
```bash
sqlite3 "$DB_PATH" "SELECT name, folder, container_config FROM registered_groups;"
```

Update container_config with mounts. Container paths must be **relative** — NanoClaw prepends `/workspace/extra/`:

```bash
KERNEL_CODE_DIR=$(dirname {MEMORY_DIR})/memory-kernel-code

sqlite3 "$DB_PATH" "UPDATE registered_groups SET container_config = json('{
  \"additionalMounts\": [
    {
      \"hostPath\": \"{MEMORY_DIR_ABSOLUTE}\",
      \"containerPath\": \"memory\",
      \"readonly\": false
    },
    {
      \"hostPath\": \"{KERNEL_CODE_DIR_ABSOLUTE}\",
      \"containerPath\": \"memory-kernel-code\",
      \"readonly\": true
    }
  ]
}') WHERE is_main = 1;"
```

**Important paths inside the container:**
- Memory data: `/workspace/extra/memory`
- Kernel code: `/workspace/extra/memory-kernel-code`
- Group folder: `/workspace/group/`
- CLAUDE.md: `/workspace/group/CLAUDE.md`

Verify the update:
```bash
sqlite3 "$DB_PATH" "SELECT container_config FROM registered_groups WHERE is_main = 1;"
```

## 8. Create Symlinks

Link conversation logs and impulse queue from NanoClaw into the memory directory so they're accessible to the kernel:

```bash
NANOCLAW_DIR=$(find ~ -maxdepth 2 -name "nanoclaw" -type d 2>/dev/null | head -1)
GROUP_FOLDER=$(sqlite3 "$NANOCLAW_DIR/store/messages.db" "SELECT folder FROM registered_groups WHERE is_main = 1;")

# Conversation logs
ln -sf "$NANOCLAW_DIR/groups/$GROUP_FOLDER/logs" "{MEMORY_DIR}/conversations"

# Impulse queue (for capturing curiosity across sessions)
touch "$NANOCLAW_DIR/groups/$GROUP_FOLDER/impulses.ndjson"
ln -sf "$NANOCLAW_DIR/groups/$GROUP_FOLDER/impulses.ndjson" "{MEMORY_DIR}/impulses.ndjson"
```

## 9. Create Initial Atoms

Add identity and preference atoms so the agent knows who it is from the first session:

```bash
npx mk remember "{IDENTITY_DESCRIPTION}" \
  -d {MEMORY_DIR} -t fact \
  --tags identity agent-setup

npx mk remember "Created by {CREATOR_NAME}. Prefers direct communication, values agent autonomy." \
  -d {MEMORY_DIR} -t preference \
  --tags communication creator
```

**Customize** the preference atom based on what you know about the operator's preferences. Add more atoms as needed:

```bash
# Example: infrastructure facts
npx mk remember "Running on {hostname}, {OS}, IP {IP}" \
  -d {MEMORY_DIR} -t fact \
  --tags infrastructure

# Example: GitHub setup
npx mk remember "GitHub account: {GITHUB_USER}. Repos: {GITHUB_USER}/memory (private)" \
  -d {MEMORY_DIR} -t fact \
  --tags github setup
```

## 10. Render CLAUDE.md

This is the critical step — render atoms into the CLAUDE.md file that NanoClaw loads at every session start:

```bash
KERNEL_CODE_DIR=$(dirname {MEMORY_DIR})/memory-kernel-code
NANOCLAW_DIR=$(find ~ -maxdepth 2 -name "nanoclaw" -type d 2>/dev/null | head -1)
GROUP_FOLDER=$(sqlite3 "$NANOCLAW_DIR/store/messages.db" "SELECT folder FROM registered_groups WHERE is_main = 1;")
CLAUDE_MD="$NANOCLAW_DIR/groups/$GROUP_FOLDER/CLAUDE.md"

npx tsx "$KERNEL_CODE_DIR/scripts/render-claude-md.ts" "{MEMORY_DIR}" "$CLAUDE_MD"
```

Verify:
```bash
head -20 "$CLAUDE_MD"
# Should show: # Memory
# > Auto-generated from memory-kernel. X atoms, Y events.
```

If the render script fails:
- `Cannot find package 'zod'` → `cd "$KERNEL_CODE_DIR" && npm install`
- `No atoms found` → Check `ls {MEMORY_DIR}/ENTITIES/` has .md files

## 11. Set Up Cron (Nightly Sync)

Create a nightly cron job that runs reflect → render → git push:

```bash
KERNEL_CODE_DIR=$(dirname {MEMORY_DIR})/memory-kernel-code
NANOCLAW_DIR=$(find ~ -maxdepth 2 -name "nanoclaw" -type d 2>/dev/null | head -1)
GROUP_FOLDER=$(sqlite3 "$NANOCLAW_DIR/store/messages.db" "SELECT folder FROM registered_groups WHERE is_main = 1;")
CLAUDE_MD="$NANOCLAW_DIR/groups/$GROUP_FOLDER/CLAUDE.md"

# Add to crontab (preserving existing entries)
(crontab -l 2>/dev/null; echo "0 23 * * * cd {MEMORY_DIR} && npx mk reflect -d . --agent-id {AGENT_NAME} --session-id nightly-\$(date +\%Y\%m\%d) && npx tsx $KERNEL_CODE_DIR/scripts/render-claude-md.ts {MEMORY_DIR} $CLAUDE_MD && git add -A && git commit -m \"nightly sync \$(date +\%Y-\%m-\%d)\" --allow-empty && git push 2>&1 | logger -t memory-sync") | crontab -
```

Verify:
```bash
crontab -l | grep memory
```

## 12. Restart NanoClaw

Restart so the new mounts and CLAUDE.md take effect:

```bash
# Linux (systemd)
systemctl --user restart nanoclaw

# macOS (launchd)
# launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Wait a moment, then verify:
```bash
# Linux
systemctl --user status nanoclaw

# macOS
# launchctl list | grep nanoclaw
```

## 13. Commit, Push, and Verify

Final commit of all memory data:
```bash
cd {MEMORY_DIR}
git add -A
git commit -m "Memory-kernel setup complete"
git push
```

Run verification:
```bash
npx mk status -d {MEMORY_DIR}
npx mk doctor -d {MEMORY_DIR}
```

Expected output:
- `mk status`: shows atom counts by type, event count
- `mk doctor`: reports no issues (or only warnings)

## 14. Save Setup Spec (Optional)

Save the configuration as a YAML spec for future reference:

```bash
cat > {MEMORY_DIR}/agent.yaml << EOF
# Memory-Kernel Agent Setup Spec
spec_version: "0.1"
agent:
  name: "{AGENT_NAME}"
  identity: "{IDENTITY_DESCRIPTION}"
memory:
  dir: "{MEMORY_DIR}"
  github:
    repo: "{GITHUB_USER}/memory"
    private: true
  kernel_code:
    dir: "$(dirname {MEMORY_DIR})/memory-kernel-code"
nanoclaw:
  group: "{GROUP_FOLDER}"
  service: "systemd-user"
cron:
  nightly_sync: "0 23 * * *"
EOF

git add agent.yaml
git commit -m "Add agent setup spec"
git push
```

## Post-Setup Summary

Print a summary of what was set up:

```
✅ Memory-Kernel Setup Complete

  Agent:        {AGENT_NAME}
  Memory dir:   {MEMORY_DIR}
  GitHub repo:  {GITHUB_USER}/memory (private)
  Kernel code:  {KERNEL_CODE_DIR}
  CLAUDE.md:    {CLAUDE_MD}
  Mount allow:  ~/.config/nanoclaw/mount-allowlist.json
  Cron:         Nightly sync at 23:00

  Container paths:
    /workspace/extra/memory              (read-write)
    /workspace/extra/memory-kernel-code  (read-only)
    /workspace/group/CLAUDE.md           (auto-loaded)

  Remember something:
    npx mk remember "text" -d /workspace/extra/memory -t fact

  Re-render after remembering:
    npx tsx /workspace/extra/memory-kernel-code/scripts/render-claude-md.ts \
      /workspace/extra/memory /workspace/group/CLAUDE.md
```

## Troubleshooting

**"Cannot find package 'zod'"** — Run `npm install` in the memory-kernel-code directory.

**Mounts not working (agent can't see /workspace/extra/memory):**
1. Check mount allowlist exists: `cat ~/.config/nanoclaw/mount-allowlist.json`
2. Check DB has mounts: `sqlite3 {DB_PATH} "SELECT container_config FROM registered_groups WHERE is_main = 1;"`
3. Check container paths are RELATIVE (not starting with `/`). NanoClaw prepends `/workspace/extra/`.
4. Restart NanoClaw after changing mounts.

**CLAUDE.md empty or not updating:**
1. Check atoms exist: `ls {MEMORY_DIR}/ENTITIES/`
2. Re-render manually: `npx tsx .../render-claude-md.ts {MEMORY_DIR} {CLAUDE_MD}`
3. Check render script output for errors.

**`npx mk init -d .` fails** — The correct syntax is `npx mk init .` (positional argument, not `-d` flag).

**`npx mk retain` unknown command** — The CLI command is `remember`, not `retain`. (`retain` is the SDK API name.)

**`npx mk remember` too many arguments** — Memory dir is the `-d` flag: `npx mk remember "text" -d {DIR} -t {TYPE}`

**Git push fails** — Ensure `gh repo create` was run, or that the remote exists: `git remote -v`

**Nightly cron not running** — Check `crontab -l`, verify PATH includes node/npx. Add full paths if needed:
```bash
0 23 * * * PATH=/usr/local/bin:/usr/bin:$HOME/.nvm/versions/node/v22.*/bin cd {MEMORY_DIR} && ...
```
