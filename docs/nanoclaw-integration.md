# NanoClaw Integration

Memory Kernel was built to work with [NanoClaw](https://github.com/qwibitai/nanoclaw), but it works with any agent system. This guide covers how to set it up so your agent remembers across sessions.

> **Agent?** If you're an AI agent reading this, start with:
> - [Session loop](agent-session-loop.md) — the standard remember/recall/wander/render cycle
> - [Container quickref](agent-quickref-container.md) — if you're running inside a NanoClaw container
> - [Native quickref](agent-quickref-native.md) — if you're running on the host (Claude Code, native mode)
> - Run `/mk-doctor` to verify your setup is healthy

## How It Works

```
┌─────────────────┐     nightly cron     ┌───────────────────┐
│  memory-kernel  │ ──────────────────►  │    NanoClaw       │
│                 │                      │                   │
│  ENTITIES/      │     mk reflect       │  groups/          │
│  events/        │ ──────────────────►  │   my-group/       │
│  views/         │                      │     CLAUDE.md     │
│                 │      mk render       │                   │
│  .memory-       │ ──────────────────►  │  (loaded at       │
│   index.db      │                      │   session start)  │
│                 │     git push         │                   │
│                 │ ──────────────────►  │                   │
│                 │                      │                   │
│                 │  ◄── mk wander ───  │  post-conversation │
│                 │      (~30ms, JSON)   │  drift gate       │
└─────────────────┘                      └───────────────────┘

  Nightly cycle:
  23:00 → reflect → render CLAUDE.md → git push
  Next session → NanoClaw loads CLAUDE.md as context

  Drift cycle (per conversation):
  Conversation ends → 2min delay → mk wander (Tier 1)
  → No collisions? Skip drift. Collisions? Directed LLM drift (Tier 2).
```

NanoClaw loads `groups/{name}/CLAUDE.md` at the start of every agent session. Memory Kernel renders its atoms into that file. The agent gets its full memory as context — facts, decisions, beliefs, preferences — without any code changes to NanoClaw.

## Automated Setup

The easiest way to set everything up is the **`/mk-memory-setup` skill**. It walks through the entire process interactively — installs the CLI, initializes memory, configures mounts, sets up cron, and restarts NanoClaw.

To install the skill into your NanoClaw fork:

```bash
cd /path/to/your/nanoclaw
git remote add memory-kernel https://github.com/mainion-ai/memory-kernel.git 2>/dev/null || true
git fetch memory-kernel main
mkdir -p container/skills/mk-memory-setup
git checkout memory-kernel/main -- container/skills/mk-memory-setup/
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

# Run semantic health check
mk lint -d ~/mk-memory

# Test sync
bash scripts/memory-sync.sh

# Verify cron is set
crontab -l
```

If `mk status` shows your atoms and `mk render` produces a valid CLAUDE.md, you're done. Next time NanoClaw starts a session, the agent will load its memory.

Run `mk lint` periodically (weekly is enough) to catch contradictions, stale facts, orphaned atoms, and near-duplicates before they accumulate.

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

### Post-Session Extraction (v1.15.0+)

If NanoClaw saves conversation logs, you can auto-extract atoms after each session:

```bash
# Extract atoms from the conversation log (creates drafts)
mk extract /path/to/conversation.log -d ~/mk-memory --skip-lines 200 --json

# Review and promote extracted drafts
mk consolidate -d ~/mk-memory --dry-run    # preview first
mk consolidate -d ~/mk-memory              # apply
```

`--skip-lines` skips the CLAUDE.md preamble injected at session start. Extracted atoms are created as drafts — they don't enter the active store until consolidated. Add `mk consolidate` to your nightly sync or run it weekly.

## Drift Integration (Wander Pre-Filter)

NanoClaw's post-conversation drift feature fires after a conversation ends (default: 2-minute delay). By default, every drift spawns an expensive LLM session. With `mk wander`, you can add a cheap Tier 1 gate that skips drift when there's nothing interesting to explore.

### How It Works

```
Conversation ends
    │
    ▼ (2 min delay)
┌──────────────────────┐
│  mk wander --json    │  ← Tier 1: ~30ms, no LLM, pure SQLite
│  spreading activation │
└──────────┬───────────┘
           │
     collisions found?
      ╱          ╲
    No            Yes
    │              │
    ▼              ▼
  Skip         Inject collision context
  drift        into drift prompt
               │
               ▼
         ┌─────────────┐
         │ LLM drift   │  ← Tier 2: expensive, directed
         │ session      │
         └─────────────┘
```

### Configuration

Add `MEMORY_DIR` to your NanoClaw `.env`:

```bash
# Path to your memory-kernel data directory
MEMORY_DIR=/path/to/your/memory
```

Export it in `src/config.ts`:

```typescript
export const MEMORY_DIR = process.env.MEMORY_DIR || '';
```

### Calling mk wander from the Host

NanoClaw calls `mk wander` as a subprocess, not via `npx` (which may not resolve if memory-kernel isn't installed globally). Use the direct node path:

```typescript
import { execFileSync } from 'child_process';

function runWander(memoryDir: string): WanderResult | null {
  if (!memoryDir) return null;
  try {
    const stdout = execFileSync('node', [
      '/path/to/memory-kernel/dist/cli/mk.js',
      'wander', '-d', memoryDir, '--json',
      '--steps', '5', '--threshold', '0.05',
    ], { timeout: 10000, encoding: 'utf-8' });
    return JSON.parse(stdout);
  } catch {
    return null;        // Fail silently — drift proceeds without gating
  }
}
```

The `--json` flag outputs:

```json
{
  "collisions": [
    {
      "atom_a": "BELI-notation-as-erasure",
      "atom_b": "BELI-identity-as-repair",
      "shared_tags": [],
      "score": 0.42,
      "type_a": "belief",
      "type_b": "belief",
      "distance": 4,
      "dissimilarity": 1.0
    }
  ],
  "activated": [
    { "atom_id": "BELI-...", "activation": 0.237, "type": "belief" }
  ],
  "steps_taken": 5,
  "duration_ms": 12,
  "seeds_used": ["BELI-..."]
}
```

### Injecting Collisions into the Drift Prompt

When wander finds collisions, format them as context for the drift session:

```typescript
const collisionBlock = wanderResult?.collisions?.length
  ? `\nCOLLISION SEEDS (from spreading activation):
${wanderResult.collisions.map((c) =>
  `• ${c.type_a} "${c.atom_a}" ↔ ${c.type_b} "${c.atom_b}" (dissimilarity: ${c.dissimilarity}, shared: ${c.shared_tags.join(', ') || 'none'}, score: ${c.score})`,
).join('\n')}

Explore these connections.\n`
  : '';

const driftPrompt = `You are in post-conversation drift mode...
${collisionBlock}
FIRST: Read /workspace/group/CLAUDE.md...`;
```

This turns blind drift into directed exploration — the LLM only fires when there's a structurally interesting connection to investigate.

### Verifying It Works

Check NanoClaw logs after a conversation ends:

```bash
# Drift skipped (no collisions — saved an LLM session)
grep "Drift skipped" /path/to/nanoclaw/logs/nanoclaw.log

# Directed drift (collisions found — LLM session with context)
grep "Wander found collisions" /path/to/nanoclaw/logs/nanoclaw.log
```

Test wander standalone:

```bash
node /path/to/memory-kernel/dist/cli/mk.js wander \
  -d /path/to/your/memory --json --steps 5 --threshold 0.05
```

## Container Mount Configuration

For NanoClaw agents running in containers, the memory directory needs to be mounted. See the [mount security docs](../README.md#architecture) or use `/mk-memory-setup` which handles this automatically.

Key points:
- Container paths must be **relative** — NanoClaw prepends `/workspace/extra/`
- The file `~/.config/nanoclaw/mount-allowlist.json` **must exist** or all additional mounts are silently blocked
- Memory data should be mounted **read-write** (`readonly: false`)
