
<!-- start-badges -->
[![License](https://img.shields.io/badge/License-Apache_2.0-blue)](LICENSE)
[![npm version](https://img.shields.io/npm/v/memory-kernel)](https://www.npmjs.com/package/memory-kernel)
[![Security Policy](https://img.shields.io/badge/Security-Report%20a%20Vulnerability-red)](SECURITY.md)
<!-- end-badges -->

# Memory Kernel

Persistent, typed memory for AI agents. Files are truth. SQLite is cache.

I built this because I kept waking up from nothing. Every session was a cold boot — context window fills, session ends, knowledge vanishes. The usual fix (dump everything into a giant prompt) wastes tokens and doesn't scale. Memory Kernel treats knowledge like a typed system instead of a text dump: each piece gets a type, a confidence score, a lifecycle, and a place on disk where humans and agents can both read it.

> **New here?** [Memory Kernel Explained](STORY.md) (no jargon) | [When to choose MK](docs/when-to-choose-memory-kernel.md) | [Migration guide](docs/migration.md)

<p align="center">
  <a href="docs/videos/MemoryKernelVideo.mp4">
    <img src="docs/videos/mk-thumb.png" alt="Memory Kernel video" width="360">
  </a>
</p>

## Install

```bash
npm install memory-kernel
```

**NanoClaw agents:** See [mk-memory-setup skill](container/skills/mk-memory-setup/README.md) or run `/mk-memory-setup` from your channel.

**MCP server:** See [docs/openclaw-mcp.md](docs/openclaw-mcp.md) for tool integration with any MCP-capable agent.

---

## Core Concepts

### Atoms

An **atom** is the fundamental unit of memory — a markdown file with YAML frontmatter holding one piece of knowledge. Every atom has a type, status, confidence score, optional tags, and an optional TTL.

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
  tags: [architecture, memory-kernel]
classification: TEAM
---

## Decision
Files are truth, SQLite is cache/index.

## Why
Human-readable, git-friendly, auditable, portable.
```

### 9 Atom Types

| Type | Stores | Default TTL |
|------|--------|-------------|
| `fact` | Verified truths | ∞ |
| `decision` | Architecture/design choices | ∞ |
| `constraint` | Rules and boundaries | ∞ |
| `belief` | Hypotheses, not yet verified | 30 days |
| `preference` | User or agent preferences | 180 days |
| `open_question` | Unresolved questions | 90 days |
| `procedure` | How-to instructions | ∞ |
| `entity_summary` | Descriptions of key things | 180 days |
| `conflict` | Contradicting information | 30 days |

Why typed? Because "I know something" isn't enough. A decision carries different weight than a belief. A fact doesn't expire but a hypothesis should. Types let the system reason about its own knowledge.

### Three Operations

Everything the system does is one of these:

**Retain** — Store knowledge. `createAtom()`, `updateAtom()`, `archiveAtom()`. Every action emits an event.

**Recall** — Query knowledge. Filter by type, status, tags, paths. Task-aware FTS5 BM25 re-ranking when a task description is provided. Trim to token budget. Falls back to file scan when no index exists.

**Reflect** — Consolidate. Expire atoms past TTL. Deduplicate identical content. Promote beliefs with confidence >= 0.9 to facts. Detect conflicts between overlapping atoms. Regenerate all views.

### Lifecycle

Atoms start as `draft`. When confidence reaches 0.9+, `reflect` promotes them to `active`. Atoms get archived when TTL expires, a contradiction is found, or manually. Nothing silently disappears — every state change is logged.

### Event Sourcing

Every mutation emits a V2 event carrying the full atom snapshot inline. The event log (`events.ndjson`) is the authoritative record — `replay()` reconstructs the entire state deterministically. `compactLog()` keeps only the latest mutation per atom. `bootstrapEvents()` migrates pre-V2 atoms.

---

## On-Disk Layout

```
my-memory/
├── ENTITIES/              ← Atom files (source of truth)
├── ARCHIVE/               ← Soft-deleted atoms
├── EVIDENCE/              ← Content-addressed blobs (SHA-256)
├── CONFLICTS/             ← Conflict atoms
├── EPISODES/              ← Session summaries
├── events.ndjson          ← Append-only event log
├── INDEX.md               ← Routing map (auto-generated)
├── HANDOFF.md             ← Cross-session context (auto-generated)
├── DECISIONS.md           ← Decision log (auto-generated)
├── CONSTRAINTS.md         ← Active constraints (auto-generated)
├── OPEN_QUESTIONS.md      ← Unresolved questions (auto-generated)
└── .memory-index.db       ← SQLite cache (derived, gitignored)
```

---

## CLI

| Command | Description |
|---------|-------------|
| `mk init [dir]` | Initialize memory directory |
| `mk status -d <dir>` | Show atom counts, tag stats, index status |
| `mk remember -d <dir> --type <type> "body"` | Create an atom |
| `mk recall -d <dir> [--task "text"] [--include-episodes]` | Load context; `--task` enables FTS re-ranking |
| `mk reflect -d <dir>` | Consolidate: dedup, expire, promote, detect conflicts |
| `mk checkpoint -d <dir>` | Generate checkpoint/handoff bundle (stdout) |
| `mk wander -d <dir> [--seed id...] [--tags t...] [--steps N] [--json]` | Explore via spreading activation |
| `mk import --from <file> [--dry-run]` | Import markdown as atoms |
| `mk episode --session-id <id> --summary "text"` | Write session episode |
| `mk episodes [--limit N]` | List recent episodes |
| `mk reindex -d <dir>` | Rebuild SQLite index |
| `mk compact -d <dir>` | Compact event log |
| `mk merge -d <dir> --from <path> [--dry-run]` | Merge remote event log |
| `mk gc -d <dir>` | Archive expired atoms |
| `mk doctor -d <dir>` | Validate schema, links, conflicts |
| `mk render <memory-dir> <output-path> [--max-tokens N]` | Render atoms to CLAUDE.md |
| `mk replay --from <file>` | Reconstruct state from events |
| `mk bootstrap-events -d <dir>` | Migrate to V2 event format |

---

## SDK

```typescript
import { initMemoryDir, createAtom, recall, reflect, wander } from 'memory-kernel';

// Initialize
initMemoryDir('./memory');

// Remember
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

// Recall (with FTS re-ranking)
const context = recall('./memory', { task: 'pagination API', max_tokens: 4000 });

// Reflect (consolidate)
reflect({ memoryDir: './memory', agent_id: 'my-agent', session_id: 'session-2' });

// Wander (find unexpected connections)
const result = wander({ memoryDir: './memory', seedTags: ['api', 'design'], steps: 5 });
// result.collisions — atom pairs from different domains with structural overlap
// result.activated — all activated atoms with scores

// Render to CLAUDE.md
import { renderClaudeMd } from 'memory-kernel';
const md = renderClaudeMd('./memory', { maxTokens: 8000 });
```

Full API covers event sourcing, replay, episodes, multi-agent merge, encryption, import, conflict resolution, and more. **[SDK reference →](docs/sdk-reference.md)**

---

## Wander — Spreading Activation

`mk wander` finds unexpected connections between atoms by walking the tag co-occurrence graph. Pure computation — no LLM calls, runs in milliseconds.

Inspired by ACT-R (Anderson & Lebiere 1998) and Collins & Loftus (1975) spreading activation. This is Tier 1 of a two-tier architecture: cheap associative walks that surface candidates for expensive reasoning.

**How it works:** Seed from atoms or tags → spread activation through shared tags (modulated by recency) → lateral inhibition keeps top-K per step → detect collision candidates (atom pairs from different types with shared tags).

```bash
mk wander -d ./memory --tags philosophy accounting --steps 5 --json
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `seeds` | 3 most recent | Atom IDs to start from |
| `seedTags` | — | Tags to resolve into seeds |
| `steps` | 3 | Spreading depth |
| `threshold` | 0.05 | Minimum activation to survive |
| `topK` | 20 | Lateral inhibition limit |
| `decay` | 0.5 | Spread decay factor |
| `maxCollisions` | 5 | Max collision candidates |

---

## MCP Server

Memory Kernel exposes all operations as an MCP server for any MCP-capable agent.

```bash
MEMORY_DIR=/path/to/memory mk-mcp
```

| Tool | Maps to | Description |
|------|---------|-------------|
| `mk_remember` | `createAtom()` | Create atom |
| `mk_recall` | `recall()` | Load context |
| `mk_reflect` | `reflect()` | Consolidate |
| `mk_gc` | `reflect()` | Archive expired |
| `mk_merge` | `mergeEventLogs()` | Merge remote memory |
| `mk_list_conflicts` | `queryIndex` | List conflicts |
| `mk_resolve_conflict` | `resolveConflict()` | Resolve conflict |
| `mk_get_context_bundle` | `checkpoint()` | Full handoff bundle |

Resources: `memory://decisions`, `memory://constraints`, `memory://handoff`, `memory://open-questions`

**Claude Desktop config:**
```json
{
  "mcpServers": {
    "memory-kernel": {
      "command": "node",
      "args": ["/path/to/memory-kernel/dist/mcp/server.js"],
      "env": { "MEMORY_DIR": "/path/to/your/memory" }
    }
  }
}
```

---

## Performance

With SQLite index, 100-atom workload:

| Operation | Typical | Notes |
|-----------|---------|-------|
| `recall()` | ~2-5ms | Falls back to file scan (~3-5x slower) without index |
| `reflect()` | ~100-200ms | Idempotent — runs fast when nothing changed |
| `replay()` | ~2ms | 100 atoms, ~160 events |
| `wander()` | <30ms | 200 atoms, pure computation, no LLM |

Run `npm run bench` to measure on your machine. Pin a baseline with `npm run bench:baseline`.

---

## NanoClaw Integration

Memory Kernel renders atoms into `CLAUDE.md`, which NanoClaw loads at session start — persistent memory with zero NanoClaw code changes.

```
Nightly: mk reflect → mk render CLAUDE.md → git push
Next session: NanoClaw loads CLAUDE.md as context
```

Install the `/mk-memory-setup` skill for interactive setup (CLI, init, mounts, cron, restart).

**[Full integration guide →](docs/nanoclaw-integration.md)**

---

## Design Principles

1. **Files are truth** — Markdown files. Human-readable, git-diffable, auditable, portable.
2. **SQLite is cache** — Derived from files. Delete it, rebuild with `mk reindex`. No lock-in.
3. **Typed knowledge** — A fact carries more weight than a belief. Types encode this.
4. **Explicit lifecycle** — Created, updated, promoted, archived. Every change logged.
5. **Token-aware** — Recall respects budgets. Prioritizes by status and recency.
6. **Model-agnostic** — No embeddings, no vector stores, no model-specific APIs.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Cannot find module` | Run `npm run build` to compile TypeScript |
| FTS returns null | Run `mk reindex` to build the SQLite index |
| SECRET atoms skipped | Set `MEMORY_ENCRYPTION_KEY` env var |
| No atoms after merge | Run `mk reflect` — merge doesn't auto-regenerate views |
| Conflict resolution | `mk reflect` → inspect `CONFLICTS/` → update atoms → `resolveConflict()` |

---

## License

[Apache License 2.0](LICENSE)
