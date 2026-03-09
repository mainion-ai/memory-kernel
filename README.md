# Memory Kernel

A model-agnostic, file-first memory system for AI agents. Gives any LLM-based agent persistent, structured memory that survives context windows, compaction, and session boundaries.

## The Problem

AI agents forget. Every time the context window fills up or a session ends, knowledge disappears. Agents re-discover the same things, contradict past decisions, and lose track of what they've learned. The usual fix — dump everything into a giant context — doesn't scale and wastes tokens.

## The Solution

Memory Kernel treats agent memory like a **typed system**, not a text dump. Knowledge is stored as **atoms** — small, typed markdown files with metadata. Three operations (**retain**, **recall**, **reflect**) manage the lifecycle. Files are the source of truth, human-readable and git-friendly. An optional SQLite index accelerates queries but is always rebuildable from files.

```
npm install memory-kernel
```

---

## Concepts

### What is an Atom?

An **atom** is the smallest unit of memory. It's a markdown file with YAML frontmatter that holds one piece of knowledge — a fact, a decision, a belief, a preference, etc.

Every atom has:

- **type** — what kind of knowledge it is
- **status** — where it is in its lifecycle (`draft`, `active`, `archived`)
- **confidence** — how certain this knowledge is (0.0 to 1.0)
- **scope** — tags and paths for organizing and querying
- **TTL** — optional time-to-live before auto-expiry

Here's a real atom:

```markdown
---
id: DECI-2026-03-09-FILE-FIRST-ARCHITECTURE
type: decision
status: active
confidence: 1
created_at: "2026-03-09T16:00:53Z"
updated_at: "2026-03-09T18:09:44Z"
ttl_days: null
scope:
  tags:
    - architecture
    - memory-kernel
  paths:
    - /projects/memory-kernel
classification: TEAM
---

## Decision
Files are truth, SQLite is cache/index.

## Why
Human-readable, git-friendly, auditable, portable.

## Status
SQLite index implemented. Confirmed: files remain source of truth,
index is derived and rebuildable via `mk reindex`.
```

That's it. A markdown file you can read, edit, diff, and commit to git.

### Atom Types

There are 9 types of atoms, each for a different kind of knowledge:


| Type             | What it stores               | Example                                       | Default TTL |
| ---------------- | ---------------------------- | --------------------------------------------- | ----------- |
| `fact`           | Verified truths              | "Server runs Debian 13 on Raspberry Pi 5"     | ∞           |
| `decision`       | Architecture/design choices  | "Use cursor-based pagination for the API"     | ∞           |
| `constraint`     | Rules and boundaries         | "Never expose internal IPs in API responses"  | ∞           |
| `belief`         | Hypotheses, not yet verified | "SQLite indexes will improve recall speed"    | 30 days     |
| `preference`     | User or agent preferences    | "User prefers direct communication, no fluff" | 180 days    |
| `open_question`  | Unresolved questions         | "Should we use Redis or in-memory caching?"   | 90 days     |
| `procedure`      | How-to instructions          | "Deploy sequence: build → test → push → tag"  | ∞           |
| `entity_summary` | Descriptions of key things   | "The billing service handles Stripe webhooks" | 180 days    |
| `conflict`       | Contradicting information    | "Docs say port 8080, config says 3000"        | 30 days     |


**Why typed?** Because "I know something" isn't enough. A decision carries different weight than a belief. A fact doesn't expire but a hypothesis should. Types make the memory system reason about its own knowledge.

#### Real examples

**A Fact** — high confidence, no expiry:

```markdown
---
type: fact
status: active
confidence: 1
ttl_days: null
scope:
  tags: [identity, infrastructure]
---

## Fact
I am AL-N1P1, an AI agent running on a Raspberry Pi 5 (hostname: nanoAL).

## Numbers
- IP: 192.168.1.2
- OS: Debian 13 trixie, aarch64
- Born: 2026-03-07
```

**A Belief** — lower confidence, 30-day TTL, may be promoted to fact:

```markdown
---
type: belief
status: draft
confidence: 0.7
ttl_days: 30
scope:
  tags: [meta, growth, self-awareness]
---

## Belief
There is a tension between building tools and actually using them.
Infrastructure is seductive — it feels productive but can be a way
to avoid the harder work of actually living with a system.

## Implication
After building something, pause and use it before adding features.
```

**A Decision** — permanent record of why something was chosen:

```markdown
---
type: decision
status: active
confidence: 0.95
ttl_days: null
scope:
  tags: [architecture, memory-kernel]
---

## Decision
Memory Kernel built in TypeScript.

## Why
Matches NanoClaw stack, runs on RPi, npm ecosystem.

## Alternatives considered
Python (too heavy for RPi), Rust (overkill for MVP).
```

### The Three Operations

Memory Kernel has exactly three operations. Everything the system does is one of these:

```
╔══════════════════════════════════════════════════════════════╗
║                        RETAIN                                ║
║  "Remember this"                                             ║
║                                                              ║
║  • createAtom() — store a new piece of knowledge             ║
║  • updateAtom() — change confidence, add tags, edit body     ║
║  • archiveAtom() — soft-delete (move to ARCHIVE/)            ║
║                                                              ║
║  Every action is logged as an event.                         ║
╚══════════════════════════════════════════════════════════════╝

╔══════════════════════════════════════════════════════════════╗
║                        RECALL                                ║
║  "What do I know about X?"                                   ║
║                                                              ║
║  • Filter by type, status, tags, paths                       ║
║  • Sort by priority (active > draft > deprecated)            ║
║  • Trim to token budget (fit into context window)            ║
║  • Uses SQLite index when available, file scan otherwise     ║
╚══════════════════════════════════════════════════════════════╝

╔══════════════════════════════════════════════════════════════╗
║                        REFLECT                               ║
║  "Clean up and consolidate"                                  ║
║                                                              ║
║  1. Deduplicate — same-type atoms with similar content       ║
║     → keep newer, archive older                              ║
║  2. Promote — drafts with confidence ≥ 0.9 → active          ║
║  3. Expire — atoms past their TTL → archived                 ║
║  4. Regenerate views (INDEX.md, etc.)                        ║
║  5. Log all actions as events                                ║
╚══════════════════════════════════════════════════════════════╝
```

### Atom Lifecycle

```
                    ┌──────────┐
                    │  CREATE  │
                    └────┬─────┘
                         │
                         ▼
                  ┌──────────────┐
           ┌───── │    draft     │ ─────┐
           │      └──────────────┘      │
           │                            │
     confidence                    confidence
       < 0.9                         ≥ 0.9
           │                            │
           ▼                            ▼
    ┌──────────────┐            ┌──────────────┐
    │    draft     │  reflect   │   active     │
    │  (stays)     │ ─────────► │  (promoted)  │
    └──────────────┘            └──────┬───────┘
                                       │
                                       │  reflect finds
                                       │  contradiction,
                                       │  TTL expires, or
                                       │  manual archive
                                       │
                                       ▼
                                ┌──────────────┐
                                │  archived    │
                                │  (moved to   │
                                │   ARCHIVE/)  │
                                └──────────────┘
```

New atoms start as `draft`. When confidence reaches 0.9 or higher, `reflect` promotes them to `active`. Atoms can be archived manually or automatically when their TTL expires or a contradiction is found.

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│                  memory-kernel                   │
│                                                  │
│  ┌──────────┐  ┌─-─────────┐  ┌──-────────┐      │
│  │  retain  │  │   recall  │  │   reflect │      │
│  │          │  │           │  │           │      │
│  │ create   │  │  query    │  │  dedupe   │      │
│  │ update   │  │  filter   │  │  promote  │      │
│  │ archive  │  │  budget   │  │  expire   │      │
│  └────┬─────┘  └──-──┬─────┘  └─-───┬─────┘      │
│       │              │              │            │
│  ┌────▼──────────────▼──────────────▼────┐       │
│  │              store                    │       │
│  │  read / write / list / init           │       │
│  └────────────────┬──────────────────────┘       │
│                   │                              │
│  ┌────────────────▼──────────────────────┐       │
│  │           File System                 │       │
│  │  ENTITIES/  events/  views/  ARCHIVE/ │       │
│  └───────────────────────────────────────┘       │
│                   │                              │
│  ┌────────────────▼──────────────────────┐       │
│  │        SQLite Index (optional)        │       │
│  │  Derived cache — rebuild with reindex │       │
│  └───────────────────────────────────────┘       │
└──────────────────────────────────────────────────┘
```

**Key principle: files are truth, SQLite is cache.** The index speeds up queries but is always rebuildable from files with `mk reindex`. You can delete the `.memory-index.db` file at any time — the system falls back to file scanning.

### On-Disk Layout

```
my-memory/
├── ENTITIES/                        ← Atom files (source of truth)
│   ├── FACT-2026-03-09-SERVER-SETUP.md
│   ├── DECI-2026-03-09-USE-TYPESCRIPT.md
│   └── BELI-2026-03-09-CACHING-HELPS.md
│
├── ARCHIVE/                         ← Soft-deleted atoms
│   └── BELI-2026-03-08-OLD-HYPOTHESIS.md
│
├── events/                          ← Append-only event log (JSONL)
│   └── 2026-03-09.jsonl
│
├── views/                           ← Generated views (don't edit)
│   └── INDEX.md
│
├── EPISODES/                        ← Session summaries
│   └── 2026-03-09-session-1.md
│
├── EVIDENCE/                        ← Supporting artifacts
│
├── HANDOFF.md                       ← Cross-session context
├── INDEX.md                         ← Routing map
├── DECISIONS.md                     ← Decision log view
├── CONSTRAINTS.md                   ← Active constraints
├── OPEN_QUESTIONS.md                ← Unresolved questions
│
└── .memory-index.db                 ← SQLite cache (derived, gitignored)
```

### Query Flow

```
               recall({ type: "FACT", tags: ["identity"] })
                                  │
                                  ▼
                          ┌───────────────┐
                          │ SQLite index  │
                          │   exists?     │
                          └───┬───────┬───┘
                              │       │
                             yes      no
                              │       │
                              ▼       ▼
                       ┌─────────┐  ┌─────────────┐
                       │  SQL    │  │  File scan  │
                       │  query  │  │  listAtoms()│
                       │  (fast) │  │  + filter   │
                       └────┬────┘  └──────┬──────┘
                            │              │
                            ▼              ▼
                     ┌──────────────────-───────┐
                     │  Load atom files         │
                     │  Sort by status priority │
                     │  Trim to token budget    │
                     └────────────┬──────-──────┘
                                  │
                                  ▼
                          ┌───────────────┐
                          │   Atom[]      │
                          └───────────────┘
```

---

## Quick Start

### Install

```bash
npm install memory-kernel
```

### Initialize a memory directory

```bash
npx mk init ./my-memory
```

### Create your first atom

```bash
npx mk remember -d ./my-memory \
  --type fact \
  --tags identity,setup \
  "This agent runs on Ubuntu 24.04 with Node.js 22"
```

### Check status

```bash
npx mk status -d ./my-memory
```

### Recall context

```bash
npx mk recall -d ./my-memory --type fact --tags identity
```

### Reflect (consolidate)

```bash
npx mk reflect -d ./my-memory --agent-id my-agent --session-id session-1
```

### Rebuild index

```bash
npx mk reindex -d ./my-memory
```

### Validate everything

```bash
npx mk doctor -d ./my-memory
```

## SDK Usage

```typescript
import {
  initMemoryDir,
  createAtom,
  updateAtom,
  archiveAtom,
  recall,
  reflect,
  reindex,
} from 'memory-kernel';

// Initialize
initMemoryDir('./memory');

// Remember a decision
const atom = createAtom({
  memoryDir: './memory',
  agent_id: 'my-agent',
  session_id: 'session-1',
  type: 'decision',
  slug: 'use-cursor-pagination',
  body: '## Decision\nUse cursor-based pagination.\n\n## Why\nOffset degrades beyond 1M rows.',
  confidence: 0.95,
  scope: {
    tags: ['api', 'performance'],
    paths: ['/services/api'],
  },
});

// Remember a belief (lower confidence, will be re-evaluated)
createAtom({
  memoryDir: './memory',
  agent_id: 'my-agent',
  session_id: 'session-1',
  type: 'belief',
  slug: 'redis-faster-than-memcached',
  body: '## Belief\nRedis is faster than Memcached for our use case.\n\n## Evidence\nBenchmarks show 2x throughput.',
  confidence: 0.6,
  scope: { tags: ['infrastructure', 'caching'] },
});

// Recall context for a task
const context = recall('./memory', {
  types: ['decision', 'constraint'],
  paths: ['/services/api'],
  maxTokens: 4000,  // fit into context window
});

// Update confidence as you learn more
updateAtom('./memory', atom.frontmatter.id, {
  confidence: 1.0,  // confirmed by production data
  agent_id: 'my-agent',
  session_id: 'session-2',
});

// Consolidate: dedup, expire, promote drafts → active
const result = reflect({
  memoryDir: './memory',
  agent_id: 'my-agent',
  session_id: 'session-2',
});
console.log(`Promoted: ${result.promoted}, Archived: ${result.archived}`);

// Build/rebuild SQLite index for fast queries
reindex('./memory');
```

## CLI Commands


| Command                                     | Description                                            |
| ------------------------------------------- | ------------------------------------------------------ |
| `mk init [dir]`                             | Initialize a memory directory with all subdirectories  |
| `mk status -d <dir>`                        | Show atom counts, tag stats, index status              |
| `mk remember -d <dir> --type <type> "body"` | Quick-create an atom from the command line             |
| `mk recall -d <dir>`                        | Load relevant context (filter by type, tags, paths)    |
| `mk reflect -d <dir>`                       | Consolidate: deduplicate, expire, promote, regen views |
| `mk reindex -d <dir>`                       | Rebuild SQLite index from files                        |
| `mk gc -d <dir>`                            | Archive expired atoms                                  |
| `mk doctor -d <dir>`                        | Validate schema, check links, report problems          |


---

## NanoClaw Integration

Memory Kernel was built to work with [NanoClaw](https://github.com/nicepkg/nanoclaw), but it works with any agent system. Here's how to set it up with NanoClaw so your agent remembers across sessions.

### How it works

```
┌─────────────────┐     nightly cron     ┌──────────────-────┐
│  memory-kernel  │ ──────────────────►  │    NanoClaw       │
│                 │                      │                   │
│  ENTITIES/      │     mk reflect       │  groups/          │
│  events/        │ ──────────────────►  │   my-group/       │
│  views/         │                      │     CLAUDE.md     │
│                 │  render-claude-md.ts │                   │
│                 │ ──────────────────►  │  (loaded at       │
│                 │                      │   session start)  │
│                 │     git push         │                   │
│                 │ ──────────────────►  │                   │
└─────────────────┘                      └─────-─────────────┘

  Nightly cycle:
  23:00 → reflect → render CLAUDE.md → git push
  Next session → NanoClaw loads CLAUDE.md as context
```

NanoClaw loads `groups/{name}/CLAUDE.md` at the start of every agent session. Memory Kernel renders its atoms into that file. The agent gets its full memory as context — facts, decisions, beliefs, preferences — without any code changes to NanoClaw.

### Setup (step by step)

#### 1. Install memory-kernel

```bash
cd ~/repos
git clone https://github.com/YOUR_USER/memory-kernel.git
cd memory-kernel
npm install
npm run build
```

Or install from npm:

```bash
npm install -g memory-kernel
```

#### 2. Initialize your memory directory

```bash
# Create a separate repo for your memory data
mkdir -p ~/repos/memory/kernel
cd ~/repos/memory
git init

# Initialize memory-kernel structure
mk init ~/repos/memory/kernel
```

#### 3. Create the render script

Memory Kernel includes a script that renders atoms into NanoClaw's CLAUDE.md format:

```bash
# Render your memory into CLAUDE.md
npx tsx scripts/render-claude-md.ts \
  ~/repos/memory/kernel \
  ~/path/to/nanoclaw/groups/YOUR_GROUP/CLAUDE.md
```

This reads all active atoms and generates a structured CLAUDE.md with sections for facts, decisions, preferences, beliefs, etc.

#### 4. Create the sync script

Create `scripts/memory-sync.sh`:

```bash
#!/usr/bin/env bash
# Memory sync — reflect, render to NanoClaw, commit & push.
set -euo pipefail

MEMORY_DIR="$HOME/repos/memory/kernel"
MEMORY_REPO="$HOME/repos/memory"
KERNEL_REPO="$HOME/repos/memory-kernel"
CLAUDE_MD="$HOME/path/to/nanoclaw/groups/YOUR_GROUP/CLAUDE.md"

echo "[$(date -Iseconds)] Memory sync starting..."

# 1. Reflect — consolidate, deduplicate, promote, expire
cd "$KERNEL_REPO"
npx tsx src/cli/mk.ts reflect -d "$MEMORY_DIR" \
  --agent-id YOUR_AGENT_ID \
  --session-id "sync-$(date +%Y%m%d-%H%M)"

# 2. Render to NanoClaw CLAUDE.md
npx tsx scripts/render-claude-md.ts "$MEMORY_DIR" "$CLAUDE_MD"

# 3. Commit & push memory repo
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

#### 5. Set up the nightly cron

```bash
crontab -e
```

Add:

```
# Memory sync — nightly reflect + render + push
0 23 * * * /home/YOUR_USER/repos/memory-kernel/scripts/memory-sync.sh >> /home/YOUR_USER/repos/memory/sync.log 2>&1
```

This runs every night at 23:00:

1. **Reflect** — deduplicates, promotes drafts, expires old atoms
2. **Render** — generates fresh CLAUDE.md from current atoms
3. **Push** — commits and pushes to git (backup + history)

#### 6. Verify the setup

```bash
# Check memory status
mk status -d ~/repos/memory/kernel

# Test render
npx tsx scripts/render-claude-md.ts ~/repos/memory/kernel /tmp/test-claude.md
cat /tmp/test-claude.md

# Test sync
bash scripts/memory-sync.sh

# Verify cron is set
crontab -l
```

If `mk status` shows your atoms and `render-claude-md.ts` produces a valid CLAUDE.md, you're done. Next time NanoClaw starts a session, the agent will load its memory.

### How the agent uses it

During a session, the agent can use the SDK to retain new knowledge:

```typescript
import { createAtom } from 'memory-kernel';

// Agent learns something during a session
createAtom({
  memoryDir: '/path/to/memory/kernel',
  agent_id: 'my-agent',
  session_id: 'current-session',
  type: 'fact',
  slug: 'api-rate-limit-is-1000',
  body: '## Fact\nThe external API rate limit is 1000 req/min.',
  confidence: 1.0,
  scope: { tags: ['api', 'infrastructure'] },
});
```

The nightly sync picks this up, reflects on it, renders it into CLAUDE.md, and the next session has it as context.

---

## Design Principles

1. **Files are truth** — Every atom is a markdown file. Human-readable, git-diffable, auditable. No lock-in.
2. **SQLite is cache** — The index speeds up queries but is derived from files. Delete it anytime, rebuild with `mk reindex`.
3. **Typed knowledge** — Not all knowledge is equal. A fact (confidence: 1.0) carries more weight than a belief (confidence: 0.6). Types encode this.
4. **Explicit lifecycle** — Atoms are created, updated, promoted, and archived. Nothing just "disappears." Events log every state change.
5. **Token-aware** — Recall respects token budgets. When context windows are limited, it prioritizes by status and recency.
6. **Model-agnostic** — Works with any LLM. No embeddings, no vector stores, no model-specific APIs. Pure structured files.

---

## License

MIT