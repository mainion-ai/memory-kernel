# NanoClaw Integration

Memory Kernel was built to work with [NanoClaw](https://github.com/qwibitai/nanoclaw), but it works with any agent system. This guide covers how to set it up so your agent remembers across sessions.

## How It Works

```
┌─────────────────┐     nightly cron     ┌───────────────────┐
│  memory-kernel  │ ──────────────────►  │    NanoClaw       │
│                 │                      │                   │
│  ENTITIES/      │     mk reflect       │  groups/          │
│  events/        │ ──────────────────►  │   my-group/       │
│  views/         │                      │     CLAUDE.md     │
│                 │      mk render       │                   │
│                 │ ──────────────────►  │  (loaded at       │
│                 │                      │   session start)  │
│                 │     git push         │                   │
│                 │ ──────────────────►  │                   │
└─────────────────┘                      └───────────────────┘

  Nightly cycle:
  23:00 → reflect → render CLAUDE.md → git push
  Next session → NanoClaw loads CLAUDE.md as context
```

NanoClaw loads `groups/{name}/CLAUDE.md` at the start of every agent session. Memory Kernel renders its atoms into that file. The agent gets its full memory as context — facts, decisions, beliefs, preferences — without any code changes to NanoClaw.

## Automated Setup

The easiest way to set everything up is the **`/mk-memory-setup` skill**. It walks through the entire process interactively — installs the CLI, initializes memory, configures mounts, sets up cron, and restarts NanoClaw.

To install the skill into your NanoClaw fork:

```bash
cd /path/to/your/nanoclaw
git fetch https://github.com/mainion-ai/memory-kernel.git skill/mk-memory-setup
git merge FETCH_HEAD --allow-unrelated-histories -m "Add mk-memory-setup skill"
npm run build
```

Then tell your agent: `/mk-memory-setup`

If you prefer to set things up manually, follow the steps below.

## Manual Setup (Step by Step)

### 1. Install memory-kernel

```bash
npm install -g memory-kernel
```

Or clone the repo:

```bash
cd ~/repos
git clone https://github.com/YOUR_USER/memory-kernel.git
cd memory-kernel
npm install
npm run build
```

### 2. Initialize your memory directory

```bash
# Create a separate directory (or repo) for your memory data
mkdir -p ~/mk-memory
mk init ~/mk-memory
```

### 3. Render to CLAUDE.md

Render active atoms into NanoClaw's CLAUDE.md format:

```bash
mk render ~/mk-memory \
  ~/path/to/nanoclaw/groups/YOUR_GROUP/CLAUDE.md
```

This reads all active atoms and generates a structured CLAUDE.md with sections for facts, decisions, preferences, beliefs, etc.

### 4. Create the sync script

Create `scripts/memory-sync.sh`:

```bash
#!/usr/bin/env bash
# Memory sync — reflect, render to NanoClaw, commit & push.
set -euo pipefail

MEMORY_DIR="$HOME/mk-memory"
MEMORY_REPO="$MEMORY_DIR"
CLAUDE_MD="$HOME/path/to/nanoclaw/groups/YOUR_GROUP/CLAUDE.md"

echo "[$(date -Iseconds)] Memory sync starting..."

# 1. Reflect — consolidate, deduplicate, promote, expire
mk reflect -d "$MEMORY_DIR" \
  --agent-id YOUR_AGENT_ID \
  --session-id "sync-$(date +%Y%m%d-%H%M)"

# 2. Render to NanoClaw CLAUDE.md
mk render "$MEMORY_DIR" "$CLAUDE_MD"

# 3. Commit & push memory repo (optional — skip if not using git)
cd "$MEMORY_REPO"
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -m "Memory sync $(date +%Y-%m-%d\ %H:%M)"
  git push
  echo "✓ Memory pushed"
else
  echo "✓ No changes"
fi

echo "[$(date -Iseconds)] Memory sync complete."
```

```bash
chmod +x scripts/memory-sync.sh
```

### 5. Set up the nightly cron

```bash
crontab -e
```

Add:

```
# Memory sync — nightly reflect + render + push
0 23 * * * /path/to/scripts/memory-sync.sh >> ~/mk-memory/sync.log 2>&1
```

This runs every night at 23:00:

1. **Reflect** — deduplicates, promotes drafts, expires old atoms
2. **Render** — generates fresh CLAUDE.md from current atoms
3. **Push** — commits and pushes to git (if you use git)

### 6. Verify the setup

```bash
# Check memory status
mk status -d ~/mk-memory

# Test render
mk render ~/mk-memory /tmp/test-claude.md
cat /tmp/test-claude.md

# Test sync
bash scripts/memory-sync.sh

# Verify cron is set
crontab -l
```

If `mk status` shows your atoms and `mk render` produces a valid CLAUDE.md, you're done. Next time NanoClaw starts a session, the agent will load its memory.

## How the Agent Uses It

During a session, the agent can use the SDK to retain new knowledge:

```typescript
import { createAtom } from 'memory-kernel';

// Agent learns something during a session
createAtom({
  memoryDir: '/path/to/memory',
  agent_id: 'my-agent',
  session_id: 'current-session',
  type: 'fact',
  slug: 'api-rate-limit-is-1000',
  body: '## Fact\nThe external API rate limit is 1000 req/min.',
  confidence: 1.0,
  scope: { tags: ['api', 'infrastructure'] },
});
```

Or via the CLI inside a NanoClaw container:

```bash
mk remember "The external API rate limit is 1000 req/min" \
  -d /workspace/extra/memory -t fact --tags api,infrastructure

# Re-render so the next session picks it up
mk render /workspace/extra/memory /workspace/group/CLAUDE.md
```

The nightly sync picks this up, reflects on it, renders it into CLAUDE.md, and the next session has it as context.

## Container Mount Configuration

For NanoClaw agents running in containers, the memory directory needs to be mounted. See the [mount security docs](../README.md#architecture) or use `/mk-memory-setup` which handles this automatically.

Key points:
- Container paths must be **relative** — NanoClaw prepends `/workspace/extra/`
- The file `~/.config/nanoclaw/mount-allowlist.json` **must exist** or all additional mounts are silently blocked
- Memory data should be mounted **read-write** (`readonly: false`)
