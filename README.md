

# Memory Kernel

A model-agnostic, file-first memory system for AI agents.  
Persistent, structured memory that survives context windows, compaction, and session boundaries.

**New here?** Read [STORY.md](STORY.md) first — it explains everything with no jargon.
[When to choose memory-kernel](docs/when-to-choose-memory-kernel.md) · [Migration guide](docs/migration.md)

## The Problem

AI agents forget. Every time the context window fills up or a session ends, knowledge disappears. Agents re-discover the same things, contradict past decisions, and lose track of what they've learned. The usual fix — dump everything into a giant context — doesn't scale and wastes tokens.

## The Solution

Memory Kernel treats agent memory like a **typed system**, not a text dump. Knowledge is stored as **atoms** — small, typed markdown files with metadata. Three operations (**retain**, **recall**, **reflect**) manage the lifecycle. Files are the source of truth, human-readable and git-friendly. An optional SQLite index accelerates queries but is always rebuildable from files.

```bash
npm install memory-kernel
```

See [docs/openclaw-mcp.md](docs/openclaw-mcp.md) for using memory-kernel as an OpenClaw MCP server (MCP tool integration).

**Video demo:** [Download or view MemoryKernelVideo.mp4](docs/videos/MemoryKernelVideo.mp4)

<img src="docs/videos/mk-thumb.png" alt="Memory Kernel video thumbnail" width="360">

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
║  SQLite index is auto-updated on each operation.             ║
╚══════════════════════════════════════════════════════════════╝

╔══════════════════════════════════════════════════════════════╗
║                        RECALL                                ║
║  "What do I know about X?"                                   ║
║                                                              ║
║  • Filter by type, status, tags, paths                       ║
║  • PERSONAL and SECRET atoms excluded by default             ║
║  • Sort by priority (active > draft > deprecated)            ║
║  • Task-aware re-ranking via FTS BM25 when `task` provided   ║
║  • Trim to token budget (fit into context window)            ║
║  • Uses SQLite index when available, file scan otherwise     ║
║  • Episodes included on demand (include_episodes: true)      ║
╚══════════════════════════════════════════════════════════════╝

╔══════════════════════════════════════════════════════════════╗
║                        REFLECT                               ║
║  "Clean up and consolidate"                                  ║
║                                                              ║
║  1. Expire — atoms past their TTL → archived                 ║
║  2. Deduplicate — same-type atoms with identical content     ║
║     → keep newer, archive older                              ║
║  3. Promote — beliefs with confidence ≥ 0.9 → facts          ║
║  4. Detect conflicts — heuristic: active fact/decision pairs  ║
║     with overlapping scope and confidence diff > 0.3 create  ║
║     a conflict atom in CONFLICTS/; events emitted            ║
║  5. Regenerate all views (INDEX, DECISIONS, CONSTRAINTS,     ║
║     OPEN_QUESTIONS, HANDOFF)                                 ║
║  6. Log all actions as events                                ║
╚══════════════════════════════════════════════════════════════╝
```

### Event Sourcing & Replay

Every mutation (create, update, archive, promote, expire) emits a **V2 event** that carries the full atom state as an inline snapshot. This makes the event log the authoritative record — you can reconstruct the entire memory from `events.ndjson` alone.

```
╔══════════════════════════════════════════════════════════════╗
║                     EVENT SOURCING                           ║
║                                                              ║
║  • Every retain/reflect action → V2 event with atom snapshot ║
║  • replay(events) → deterministic state reconstruction       ║
║  • bootstrapEvents() → migrate pre-V2 atoms to event-sourced ║
║  • Evidence store → content-addressed blobs (SHA-256)        ║
║                                                              ║
║  Events are append-only. Same events → identical atoms+views.║
║  compactLog() shrinks the log by keeping latest per atom.    ║
╚══════════════════════════════════════════════════════════════╝
```

**Replay** is a pure fold over events — no filesystem needed. Each mutation event's snapshot IS the definitive atom state. Replay does not re-run reflect; reflect's own side effects (dedup, promotion, expiry) emit their own mutation events with snapshots.

**Bootstrap** converts an existing memory directory into a fully event-sourced state by generating synthetic `atom_imported` events for all atoms on disk.

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
┌───────────────────────────────────────────────────────┐
│                    memory-kernel                      │
│                                                       │
│  ┌──────────┐  ┌───────────┐  ┌───────────┐           │
│  │  retain  │  │   recall  │  │  reflect  │           │
│  │          │  │           │  │           │           │
│  │ create   │  │  query    │  │  dedupe   │           │
│  │ update   │  │  filter   │  │  promote  │           │
│  │ archive  │  │  budget   │  │  expire   │           │
│  └────┬─────┘  └─────┬─────┘  └─────┬─────┘           │
│       │              │              │                 │
│  ┌────▼──────────────▼──────────────▼──────┐          │
│  │              store + event-log          │          │
│  │  read / write / list / appendEvent      │          │
│  └────────────────┬────────────────────────┘          │
│                   │                                   │
│  ┌────────────────▼────────────────────────┐          │
│  │             File System                 │          │
│  │  ENTITIES/  ARCHIVE/  EVIDENCE/         │          │
│  │  CONFLICTS/  EPISODES/                  │          │
│  │  events.ndjson  *.md views              │          │
│  └─────────────────────────────────────────┘          │
│                   │                                   │
│  ┌────────────────▼────────────────────────┐          │
│  │   replay     │  SQLite Index (optional) │          │
│  │ events →     │  Derived cache — rebuild │          │
│  │  atoms+views │  with mk reindex         │          │
│  └──────────────┴──────────────────────────┘          │
└───────────────────────────────────────────────────────┘
```

**Key principles:**

- **Files are truth, SQLite is cache.** The index speeds up queries but is always rebuildable from files with `mk reindex`.
- **Events are the system of record.** Every mutation carries an inline atom snapshot (V2 events). The event log can reconstruct the entire state via `replay()`.

### On-Disk Layout

```
my-memory/
├── ENTITIES/                        ← Atom files (source of truth)
│   ├── FACT-2026-03-09-SERVER-SETUP-a1b2.md
│   ├── DECI-2026-03-09-USE-TYPESCRIPT-c3d4.md
│   └── BELI-2026-03-09-CACHING-HELPS-e5f6.md
│
├── ARCHIVE/                         ← Soft-deleted atoms
│   └── BELI-2026-03-08-OLD-HYPOTHESIS-g7h8.md
│
├── EVIDENCE/                        ← Content-addressed blobs (SHA-256)
│   └── a1b2c3d4e5f6...64hex.blob
│
├── CONFLICTS/                       ← Conflict atoms
├── EPISODES/                        ← Session summaries
│
├── events.ndjson                    ← Append-only event log (V2: snapshots inline)
│
├── INDEX.md                         ← Routing map (auto-generated)
├── HANDOFF.md                       ← Cross-session context (auto-generated)
├── DECISIONS.md                     ← Decision log (auto-generated)
├── CONSTRAINTS.md                   ← Active constraints (auto-generated)
├── OPEN_QUESTIONS.md                ← Unresolved questions (auto-generated)
│
└── .memory-index.db                 ← SQLite cache (derived, gitignored)
```

### Query Flow

```
   recall(dir, { types: ["fact"], task: "pagination api", max_tokens: 4000 })
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
                     ┌────────────────────────┐
                     │  Load atom files       │
                     │  Sort: status priority │
                     └────────────┬───────────┘
                                  │
                          task provided?
                                  │
                              yes │
                                  ▼
                     ┌────────────────────────┐
                     │  FTS5 BM25 re-ranking  │
                     │  searchFts(task, ...)  │
                     │  Matched atoms → top   │
                     └────────────┬───────────┘
                                  │
                                  ▼
                     ┌────────────────────────┐
                     │  Trim to token budget  │
                     └────────────┬───────────┘
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
# Basic recall (filter by type and tags)
npx mk recall -d ./my-memory --type fact --tags identity

# Task-aware recall (FTS BM25 re-ranking)
npx mk recall -d ./my-memory --task "cursor pagination API"

# Include recent session episodes
npx mk recall -d ./my-memory --task "auth bug" --include-episodes
```

### Reflect (consolidate)

```bash
npx mk reflect -d ./my-memory --agent-id my-agent --session-id session-1
```

### Checkpoint (handoff bundle)

```bash
npx mk checkpoint -d ./my-memory --task "Implement auth" > handoff.md
```

### Bootstrap events (migrate to V2)

```bash
npx mk bootstrap-events -d ./my-memory --agent-id my-agent
```

### Replay from event log

```bash
npx mk replay --from ./my-memory/events.ndjson --output-dir ./replayed
```

### Write a session episode

```bash
npx mk episode -d ./my-memory --session-id "session-42" \
  --summary "Fixed pagination bug, updated 3 atoms" \
  --tags api,bugfix
```

### List recent episodes

```bash
npx mk episodes -d ./my-memory --limit 5
```

### Compact event log

```bash
npx mk compact -d ./my-memory
```

### Merge remote event log

```bash
# Preview what would change (no writes)
npx mk merge -d ./my-memory --remote ./remote-memory --dry-run

# Perform the merge
npx mk merge -d ./my-memory --remote ./remote-memory \
  --agent-id my-agent --session-id session-merge-1
```

### Rebuild index

```bash
npx mk reindex -d ./my-memory
```

### Import a markdown file

```bash
# Preview what would be extracted (no writes)
npx mk import --from NOTES.md --dir ./my-memory --dry-run

# Import — one atom per heading section; bullet fallback if no headings
npx mk import --from NOTES.md --dir ./my-memory \
  --agent-id my-agent --session-id session-import-1

# Force all atoms to a specific type
npx mk import --from CONSTRAINTS.md --dir ./my-memory --type constraint
```

### Encrypt SECRET atoms

```bash
# Set the encryption key (64-char hex or a passphrase)
export MEMORY_ENCRYPTION_KEY="your-passphrase-or-64-char-hex"

# SECRET atoms are automatically encrypted at rest
npx mk remember -d ./my-memory --type fact --classification SECRET \
  "API key rotation schedule: first Monday of every month"

# Recall works transparently when the key is set
npx mk recall -d ./my-memory

# Without the key, SECRET atoms are skipped (other atoms still readable)
unset MEMORY_ENCRYPTION_KEY
npx mk recall -d ./my-memory
```

### Validate everything

```bash
npx mk doctor -d ./my-memory
```

## SDK Usage

```typescript
import { initMemoryDir, createAtom, recall, reflect } from 'memory-kernel';

// Initialize
initMemoryDir('./memory');

// Remember a decision
createAtom({
  memoryDir: './memory',
  agent_id: 'my-agent',
  session_id: 'session-1',
  type: 'decision',
  slug: 'use-cursor-pagination',
  body: '## Decision\nUse cursor-based pagination.\n\n## Why\nOffset degrades beyond 1M rows.',
  confidence: 0.95,
  scope: { tags: ['api', 'performance'] },
});

// Recall context for a task (FTS BM25 re-ranking)
const context = recall('./memory', {
  task: 'pagination API',
  max_tokens: 4000,
});

// Consolidate: expire, dedup, promote beliefs → facts
const result = reflect({
  memoryDir: './memory',
  agent_id: 'my-agent',
  session_id: 'session-2',
});

// Render to CLAUDE.md
import { renderClaudeMd } from 'memory-kernel';
const md = renderClaudeMd('./memory', { maxTokens: 8000 });
```

The SDK also covers event sourcing & replay, episodes, multi-agent merge, encryption, import, conflict resolution, and more.

**[Full SDK reference →](docs/sdk-reference.md)**

## MCP Server (v0.8.0+)

Memory Kernel exposes all operations as an MCP server so any MCP-capable agent can use it without spawning a child process.

### Start the MCP server

```bash
MEMORY_DIR=/path/to/memory node dist/mcp/server.js

# Or with the dev runner:
MEMORY_DIR=./my-memory npm run mcp

# Or via global install:
MEMORY_DIR=./my-memory mk-mcp
```

Environment variables:


| Variable                | Required | Default       | Description                                                        |
| ----------------------- | -------- | ------------- | ------------------------------------------------------------------ |
| `MEMORY_DIR`            | **yes**  | —             | Absolute path to the memory directory                              |
| `MCP_AGENT_ID`          | no       | `mcp-server`  | Agent ID written to the event log                                  |
| `MCP_SESSION_ID`        | no       | `mcp-<uuid8>` | Session ID written to the event log                                |
| `MEMORY_ENCRYPTION_KEY` | no       | —             | Encrypt/decrypt `SECRET` atoms at rest (64-char hex or passphrase) |


### MCP Tools

All tools accept optional `agent_id` and `session_id` fields to override server defaults per-call. All responses include a `provenance` block.


| Tool                    | Maps to                    | Description                                                |
| ----------------------- | -------------------------- | ---------------------------------------------------------- |
| `mk_remember`           | `createAtom()`             | Create a new memory atom                                   |
| `mk_recall`             | `recall()`                 | Load relevant context (types, tags, task, episodes)        |
| `mk_reflect`            | `reflect()`                | Expire, dedup, promote, detect conflicts, regenerate views |
| `mk_gc`                 | `reflect()`                | Archive expired atoms (GC-focused alias for reflect)       |
| `mk_merge`              | `mergeEventLogs()`         | Merge a remote memory directory into local                 |
| `mk_list_conflicts`     | `listAtoms` / `queryIndex` | List all active conflict atoms                             |
| `mk_resolve_conflict`   | `resolveConflict()`        | Mark a conflict atom resolved and archive it               |
| `mk_get_context_bundle` | `checkpoint()`             | Generate a full markdown handoff bundle                    |


### MCP Resources (read-only)

Resources read view files fresh on every request. If a view hasn't been generated yet, the resource returns a placeholder prompting you to run `reflect` first.


| Resource URI              | View file           |
| ------------------------- | ------------------- |
| `memory://decisions`      | `DECISIONS.md`      |
| `memory://constraints`    | `CONSTRAINTS.md`    |
| `memory://handoff`        | `HANDOFF.md`        |
| `memory://open-questions` | `OPEN_QUESTIONS.md` |


### Claude Desktop configuration

```json
{
  "mcpServers": {
    "memory-kernel": {
      "command": "node",
      "args": ["/path/to/memory-kernel/dist/mcp/server.js"],
      "env": {
        "MEMORY_DIR": "/path/to/your/memory",
        "MCP_AGENT_ID": "claude-desktop"
      }
    }
  }
}
```

## CLI Commands


| Command                                                                              | Description                                                                      |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `mk init [dir]`                                                                      | Initialize a memory directory with all subdirectories                            |
| `mk status -d <dir>`                                                                 | Show atom counts, tag stats, index status                                        |
| `mk remember -d <dir> --type <type> "body"`                                          | Quick-create an atom from the command line                                       |
| `mk recall -d <dir> [--task "text"] [--include-episodes]`                            | Load relevant context; `--task` enables FTS BM25 re-ranking                      |
| `mk reflect -d <dir>`                                                                | Consolidate: deduplicate, expire, promote, detect conflicts                      |
| `mk checkpoint -d <dir>`                                                             | Generate checkpoint/handoff bundle (stdout)                                      |
| `mk import --from <file> [-d <dir>] [--type <t>] [--classification <c>] [--dry-run]` | Import a markdown file as memory atoms (heading/bullet extraction)               |
| `mk episode -d <dir> --session-id <id> --summary "text"`                             | Write a session episode summary to EPISODES/                                     |
| `mk episodes -d <dir> [--limit N] [--tags a,b]`                                      | List session episodes newest-first                                               |
| `mk bootstrap-events -d <dir>`                                                       | Migrate existing atoms to V2 event-sourced format                                |
| `mk replay --from <file>`                                                            | Reconstruct atoms + views from an event log                                      |
| `mk reindex -d <dir>`                                                                | Rebuild SQLite index (including FTS5) from files                                 |
| `mk compact -d <dir>`                                                                | Compact event log — remove intermediate mutation events                          |
| `mk merge -d <dir> --remote <path> [--dry-run]`                                      | Merge remote event log into local; creates conflict atoms for concurrent updates |
| `mk gc -d <dir>`                                                                     | Archive expired atoms                                                            |
| `mk doctor -d <dir>`                                                                 | Validate schema, check links, report problems                                    |
| `mk render <memory-dir> <output-path> [--max-tokens N]`                              | Render active atoms to a CLAUDE.md-compatible markdown file (default: 8000 tokens) |


---

## Performance

Typical performance on a modern workstation (M-series Mac or equivalent x86-64) with a 100-atom workload and SQLite index present:


| Operation   | Metric                  | Typical    | PRD Target |
| ----------- | ----------------------- | ---------- | ---------- |
| `recall()`  | p50                     | ~2ms       | —          |
| `recall()`  | p95                     | ~3ms       | < 50ms     |
| `recall()`  | p99                     | ~5ms       | —          |
| `reflect()` | single call             | ~100–200ms | —          |
| `replay()`  | 100 atoms (~160 events) | ~2ms       | —          |


For the reference measurement used in CI, see `scripts/bench-baseline.json`.

Run the benchmark harness on your machine:

```bash
npm run bench
```

Pin a baseline for future comparison:

```bash
npm run bench:baseline
cat scripts/bench-baseline.json | jq '.recall.p95_ms'
```

**Notes:**

- `recall()` degrades gracefully when the SQLite index is absent — it falls back to a full file scan (~3–5× slower). Run `mk reindex` to rebuild.
- At 500 atoms without an index, `reflect()` completes in < 15 seconds (verified by `test/stress.test.ts`).
- Encrypted SECRET atoms are excluded from default recall (decryption is skipped).

---

## Troubleshooting

### `Cannot find module` after install

Run `npm run build` to compile TypeScript to `dist/`. The package ships compiled JS, but if you cloned the repo you need to build first.

### FTS search returns `null` / no results

Run `mk reindex -d <dir>` to build (or rebuild) the SQLite index. The index file (`.memory-index.db`) is not committed to git. Without it, `recall()` falls back to a file scan and `searchFts()` returns `null`.

### Encrypted atom shows as skipped in `listAtoms`

Set `MEMORY_ENCRYPTION_KEY` before running. Without the key, SECRET atoms are silently skipped with a warning to stderr. To verify the key is correct: `mk doctor -d <dir>`.

### `reflect()` returns `events_emitted: 1` on a second call

This is correct and expected. `reflect()` is idempotent — if no atoms need expiry, deduplication, or promotion, only the `reflect_completed` event itself is emitted. `events_emitted` will be `1`, not `0`.

### `recall()` returns no atoms after `mergeEventLogs()`

Run `reflect()` (or `mk reflect`) after a merge. The merge operation writes atoms to disk but does not automatically regenerate views or sync the SQLite index.

### Conflict resolution workflow

1. Run `mk reflect -d <dir>` — conflict atoms appear in `CONFLICTS/`
2. Inspect `CONFLICTS/*.md` to see the conflicting atom IDs and their values
3. Update or archive the incorrect atom with `updateAtom()` / `archiveAtom()` (or MCP `mk_remember` / the atom file directly)
4. Call `resolveConflict({ memoryDir, filePath: conflictAtomPath, agent_id, session_id, resolutionNote: '...' })` or use MCP `mk_resolve_conflict`
5. Run `mk reflect` again — the conflict count should decrease

Conflicts are created by `reflect()` when two active atoms of the same eligible type (`fact`, `decision`, `constraint`) share overlapping scope paths and have a confidence gap > 0.3.

---

## NanoClaw Integration

Memory Kernel was built to work with [NanoClaw](https://github.com/qwibitai/nanoclaw), but it works with any agent system. NanoClaw loads `groups/{name}/CLAUDE.md` at the start of every session — Memory Kernel renders its atoms into that file, giving the agent persistent memory with zero code changes to NanoClaw.

```
  Nightly cycle:
  23:00 → mk reflect → mk render CLAUDE.md → git push
  Next session → NanoClaw loads CLAUDE.md as context
```

**Quickest path:** Install the `/mk-memory-setup` skill and it handles everything interactively — CLI install, memory init, mounts, cron, and restart.

```bash
cd /path/to/your/nanoclaw
git fetch https://github.com/mainion-ai/memory-kernel.git skill/mk-memory-setup
git merge FETCH_HEAD --allow-unrelated-histories -m "Add mk-memory-setup skill"
```

**[Full NanoClaw integration guide →](docs/nanoclaw-integration.md)** (manual setup, sync scripts, container mounts, troubleshooting)

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