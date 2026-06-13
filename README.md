
<!-- start-badges -->
[![License](https://img.shields.io/badge/License-Apache_2.0-blue)](LICENSE)
[![npm version](https://img.shields.io/npm/v/memory-kernel)](https://www.npmjs.com/package/memory-kernel)
[![Security Policy](https://img.shields.io/badge/Security-Report%20a%20Vulnerability-red)](SECURITY.md)
<!-- end-badges -->

# Memory Kernel

**Persistent, typed memory for AI agents. Files are truth. SQLite is cache.**

> 1,700+ automated tests · p95 recall < 3 ms · [on-disk format](docs/invariants.md) readable without any tooling

<p align="center">
  <a href="docs/videos/MemoryKernelVideo.mp4">
    <img src="docs/videos/mk-thumb.png" alt="Memory Kernel video" width="360">
  </a>
</p>

### Start here

- **New to Memory Kernel?** Read [**STORY.md**](STORY.md) — a plain-English walkthrough of how the system works, written for non-programmers. ~10 min for the gist, ~75 min end-to-end.
- **Deciding if it fits your project?** [When to choose Memory Kernel](docs/when-to-choose-memory-kernel.md)
- **Importing existing notes?** [Migration guide](docs/migration.md)
- **Connecting it to Claude, Cursor, or another AI assistant?** [OpenClaw MCP guide](docs/openclaw-mcp.md)

### For agents — install skills

If you are an AI agent (or setting one up), Memory Kernel ships two host-side skills under [`skills/`](skills/) that handle installation and diagnostics end-to-end. Both are **host-agnostic** at their core and **host-aware** where it matters — they work for NanoClaw container agents, OpenClaw plugin-based agents, MCP clients (Claude Desktop, Cursor, Continue), or a generic native setup, branching to host-specific plumbing only where memory-kernel actually needs to adapt.

- **[`/mk-memory-setup`](skills/mk-memory-setup/README.md)** — interactive full setup. Detects (or asks) which host you're targeting, then runs the universal flow: install the CLI, initialize the memory directory, seed identity + preference atoms, seed the **11 lifecycle atoms** (the agent's operating manual as typed memory — see [`skills/mk-memory-setup/seed-atoms/lifecycle/`](skills/mk-memory-setup/seed-atoms/lifecycle/)), render or expose memory the way your host expects, and schedule nightly `mk reflect` + render. Host-specific plumbing (NanoClaw mounts, OpenClaw plugin + AGENTS.md/MEMORY.md doctrine, MCP server config) lives in [`skills/mk-memory-setup/references/`](skills/mk-memory-setup/references/).

- **[`/mk-doctor`](skills/mk-doctor/SKILL.md)** — self-diagnostic. Universal checks first (`mk doctor`, `mk lint`, `mk closure --trajectory`, lifecycle-atom audit, index health, render check), then host-specific checks for whatever host(s) it detects (NanoClaw mounts and allowlist; OpenClaw plugin + doctrine; MCP `claude_desktop_config.json` server entry; native cron). Run it any time memory feels off, before debugging further, or after changing your setup.

---

## Install

Requires **Node.js 22.16 or later** (Node 24 recommended). Matches OpenClaw's official runtime requirement; NanoClaw users on Node 20 should upgrade (Node 20 reached end-of-life 2026-04-30).

```bash
npm install memory-kernel
```

## Try it in 60 seconds

```bash
npx memory-kernel init ./my-memory
npx memory-kernel remember -d ./my-memory --type fact "Production runs Debian 13"
npx memory-kernel recall -d ./my-memory
```

Three commands. You now have a working filing cabinet for an AI agent.

> **Tip:** `npx memory-kernel` works as of v1.29.1 — it resolves to the `mk` binary. Alternatively, install globally (`npm i -g memory-kernel`) and use `mk` directly.

---

## Why Memory Kernel

I built this because I kept waking up from nothing. Every session was a cold boot — context window fills, session ends, knowledge vanishes. The usual fix (dump everything into a giant prompt) wastes tokens and doesn't scale. Memory Kernel treats knowledge like a typed system instead of a text dump: each piece gets a type, a confidence score, a lifecycle, and a place on disk where humans and agents can both read it.

**Five things that make this different:**

1. **Files are truth.** Every piece of knowledge is a plain markdown file you can open in any text editor — or commit to git. The on-disk format is readable with zero tooling; the npm package adds indexing and tooling on top.
2. **Self-cleaning.** Each piece of knowledge has an expiry date baked in. Stale beliefs get archived automatically, so memory doesn't grow into a landfill.
3. **Smart recall.** When the agent asks *"what do I know about X?"*, the system doesn't dump everything — it ranks by relevance, type, age, and citation frequency, then fits the best matches into the available token budget.
4. **Two agents can share a brain without colliding.** Each agent gets a private drawer plus a shared corkboard. Conflicts are flagged, not silently resolved.
5. **Tested like infrastructure.** 1,700+ automated checks run on every change. 95 out of 100 recall queries finish in under 3 milliseconds.

---

## At a Glance

```
    YOU (or your agent)
         │
         │  "Remember this"  │  "What do I know?"  │  "Clean up"
         ▼
  ┌───────────────────────────────────────────────────────────────┐
  │      ·      RETAIN       ·        RECALL       ·   REFLECT    │
  └───────────────────────────────────────────────────────────────┘
         │
         ▼
  ┌──────────────┐      ┌────────────────────┐
  │ Atom Files   │◄────►│ SQLite Index       │
  │ (ENTITIES/)  │      │ (speed cache,      │
  │              │      │  always derived)   │
  └──────────────┘      └────────────────────┘
         │
         │  every mutation logged
         ▼
  ┌──────────────┐      ┌────────────────────┐
  │ Event Log    │─────►│ Replay             │
  │ events.ndjson│      │ (rebuild state)    │
  └──────────────┘      └────────────────────┘
         │
         ▼
  ┌──────────────────────────────┐
  │ Auto-generated views         │
  │ INDEX · DECISIONS ·          │
  │ CONSTRAINTS · HANDOFF ·      │
  │ OPEN_QUESTIONS               │
  └──────────────────────────────┘
```

Files are truth. Everything else is derived. Delete the SQLite index — rebuild with `mk reindex`. Delete the views — `mk reflect` regenerates them. Delete the atom files — `mk replay` reconstructs them from the event log. See [`docs/invariants.md`](docs/invariants.md) for the full statement, including the `entity_triples` exception (LLM-extracted, not derivable from files).

---

## Integration Quick Links

**For agents:**
- [Session loop](docs/agent-session-loop.md) — when to remember, recall, wander, render. Also seeded as 10 procedure atoms + 1 constraint by `/mk-memory-setup`, so the lifecycle is recallable from inside memory itself.
- [Container quickref](docs/agent-quickref-container.md) — paths, commands, /tmp workaround
- [Native / Claude Code quickref](docs/agent-quickref-native.md) — host-side setup and workflow
- **Setup:** run `/mk-memory-setup` from Claude Code on the host — auto-detects NanoClaw, OpenClaw, MCP-client, or generic and routes to the right flow. See the [mk-memory-setup skill](skills/mk-memory-setup/README.md).
- **Health check:** run `/mk-doctor` any time memory feels off — see [skills/mk-doctor/SKILL.md](skills/mk-doctor/SKILL.md).

**For NanoClaw operators:** the skill handles mount allowlists, container_config in the NanoClaw DB, conversation/impulse symlinks, and restart automatically — see [`skills/mk-memory-setup/references/nanoclaw.md`](skills/mk-memory-setup/references/nanoclaw.md) for the standalone reference.

**For OpenClaw operators:** [CLI integration guide](docs/cli-integration.md) for direct `--json` CLI usage (no MCP required) · [Host integration doctrine](docs/host-integration-doctrine.md) for steering host AGENTS.md, MEMORY.md, and compaction · [`skills/mk-memory-setup/references/openclaw.md`](skills/mk-memory-setup/references/openclaw.md) for the plugin install + doctrine flow.

**For MCP clients (Claude Desktop, Cursor, Continue, …):** [docs/openclaw-mcp.md](docs/openclaw-mcp.md) for the canonical `claude_desktop_config.json` snippet, and [`skills/mk-memory-setup/references/mcp-client.md`](skills/mk-memory-setup/references/mcp-client.md) for the per-client setup flow the skill follows.

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
| `belief` | Hypotheses, not yet verified | ∞ (confidence scores handle evolution) |
| `preference` | User or agent preferences | ∞ |
| `open_question` | Unresolved questions | 90 days |
| `procedure` | How-to instructions | ∞ |
| `entity_summary` | Descriptions of key things | 180 days |
| `conflict` | Contradicting information | 30 days |

Why typed? Because "I know something" isn't enough. A decision carries different weight than a belief. A fact doesn't expire but a hypothesis should. Types let the system reason about its own knowledge.

### Three Operations

Everything the system does is one of these:

**Retain** — Store knowledge. `createAtom()`, `updateAtom()`, `archiveAtom()`. Every action emits an event.

**Recall** — Query knowledge. Filter by type, status, tags, paths. When a task description is provided, atoms are re-ranked by a composite score:

- **Relevance** — FTS5 BM25 (keyword match) + optional cosine similarity (semantic match). OR query semantics with IDF hub damping (penalises atoms matched via ubiquitous terms), query-term coverage boost (penalises partial matches), and content-length normalisation (prevents large atoms from dominating via BM25 bias).
- **Recency** — exponential decay with a configurable half-life.
- **Type weight** — `constraint` and `decision` outrank `belief` and `entity_summary`; critical types can reserve guaranteed token slots.
- **Confidence** — low-confidence atoms are deprioritised, not silenced.
- **Graph-walk boost** — atoms connected to high-scoring neighbours get a small lift.
- **MMR re-ranking** — prevents near-duplicate atoms from filling the budget.

Token budget enforced with two-pass reservation. Embeddings are opt-in — no API key means FTS-only, zero behaviour change. Falls back to a file scan when no index exists.

**Reflect** — Consolidate. Expire atoms past TTL. Deduplicate identical content. Promote eligible drafts to `active` by type-tiered rules (fact/preference/decision after 48h at confidence ≥ 0.7 with no contradiction; open_question immediately; beliefs and procedures held for review). Detect conflicts between overlapping atoms. Regenerate all views.

### Lifecycle

Atoms start as `draft`. `reflect` auto-promotes eligible drafts to `active` by type-tiered rules — fact/preference/decision after 48h at confidence ≥ 0.7 with no contradiction, open_question immediately; beliefs and procedures are held for explicit review (a status promotion that keeps the atom's type). `mk consolidate` lets you review and promote drafts of any type to `active`. Atoms get archived when TTL expires, a contradiction is found, or manually. Use `mk supersede <old-id> <new-id>` to mark outdated knowledge as superseded — superseded atoms are excluded from recall but kept on disk for audit. Nothing silently disappears — every state change is logged.

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
├── KNOWLEDGE/             ← Drop knowledge docs here; observed into atoms (draft/ is never observed)
├── events.ndjson          ← Append-only event log
├── INDEX.md               ← Routing map (auto-generated)
├── HANDOFF.md             ← Cross-session context (auto-generated)
├── DECISIONS.md           ← Decision log (auto-generated)
├── CONSTRAINTS.md         ← Active constraints (auto-generated)
├── OPEN_QUESTIONS.md      ← Unresolved questions (auto-generated)
└── .memory-index.db       ← SQLite cache (derived, gitignored)
```

### Per-Agent Isolation (optional)

When multiple agents share a memory directory, enable **per-agent isolation** to give each agent private memory with controlled sharing:

```
my-memory/
├── config.yaml            ← isolation: per-agent
├── agents/
│   ├── alice/             ← Full memory layout, private to Alice
│   └── bob/               ← Full memory layout, private to Bob
└── shared/                ← Explicitly shared atoms (visible to all)
```

```bash
mk init ./memory -a alice                    # Initialize in isolated mode
mk remember "..." -d ./memory -a alice -t fact
mk share FACT-xxx --from alice -d ./memory   # Snapshot to shared namespace
mk recall -d ./memory -a bob --task "auth design" --embed   # Bob's atoms + shared, semantic re-ranking (--embed needs --task; omit --embed for FTS-only)
```

Two modes: `shared` (default, backward compatible) and `per-agent` (enable via `isolation: per-agent` in `config.yaml`, or the `MK_ISOLATION=per-agent` env var). Union recall merges agent + shared atoms (agent wins on ID collision). Share is copy-based — re-share to propagate updates. Migrate existing stores with `mk migrate --strategy fresh|partition|clone-to-shared`.

**[Full isolation guide →](docs/isolation.md)**

---

## CLI

> **Tip:** All commands accept `-a, --agent <id>` for per-agent isolation. In shared mode the flag is ignored.

### Core

| Command | Description |
|---------|-------------|
| `mk init [dir]` | Initialize memory directory |
| `mk status -d <dir> [--json]` | Show atom counts, tag stats, index status |
| `mk remember -d <dir> --type <type> "body" [--json]` | Create an atom |
| `mk recall -d <dir> [--task "text"] [--embed] [--types <types...>] [--paths <paths...>] [--max-tokens N] [--include-episodes] [--include-drafts] [--decay-weight N] [--decay-half-life N] [--no-graph] [--reservations\|--no-reservations] [--json]` | Load context; `--task` enables FTS-based re-ranking; `--embed` enables hybrid FTS + semantic re-ranking (requires embeddings built via `mk reindex --embed`). Auto-extracted draft atoms (session-end extract output) excluded by default; `--include-drafts` opts them in |
| `mk reflect -d <dir> [--json]` | Consolidate: dedup, expire, promote, detect conflicts |
| `mk checkpoint -d <dir> [--json]` | Generate checkpoint / handoff bundle |

### Knowledge management

| Command | Description |
|---------|-------------|
| `mk import --from <file> [--dry-run]` | Import markdown as atoms |
| `mk extract <log-path> -d <dir> [--model <model>] [--dry-run] [--max-atoms N] [--skip-lines N] [--json]` | Extract atoms from a conversation log using an LLM (Claude CLI or Ollama) |
| `mk observe <path> -d <dir> [--mode conversation\|document] [--model <model>] [--dry-run] [--json]` | Append LLM observations to `observations.md`. `--mode document` reads a `KNOWLEDGE/` doc and extracts its decisions/conclusions (vs. what happened in a conversation); `mk reflect` then turns observations into atoms. See the [`/mk-memory-setup`](skills/mk-memory-setup/SKILL.md) KNOWLEDGE step |
| `mk consolidate -d <dir> [--dry-run] [--all] [--type <type>] [--limit N] [--json]` | Review and promote auto-extracted draft atoms to active |
| `mk lint -d <dir> [--json] [--stale-days N]` | Semantic health check: contradictions, stale atoms, orphans, near-duplicates, confidence drift, TTL warnings |
| `mk doctor -d <dir> [--json] [--skip <cats>] [--fix] [--dry-run]` | Validate schema, links, conflicts, store integrity; `--fix` auto-remediates safe issues (stale index, perms, missing `render.yaml`); `--dry-run` previews `--fix` without writing |
| `mk episode --session-id <id> --summary "text" [--json]` | Write a session episode |
| `mk episodes [--limit N] [--json]` | List recent episodes |

### Indexing & maintenance

| Command | Description |
|---------|-------------|
| `mk reindex -d <dir> [--embed]` | Rebuild SQLite index; `--embed` computes embeddings for all atoms |
| `mk compact -d <dir>` | Compact the event log |
| `mk merge -d <dir> --from <path> [--dry-run]` | Merge a remote event log |
| `mk gc -d <dir> [--json]` | Archive expired atoms |
| `mk replay --from <file>` | Reconstruct state from events |
| `mk bootstrap-events -d <dir>` | Migrate to V2 event format |

### Relations & citations

| Command | Description |
|---------|-------------|
| `mk relate <src-id> <type> <tgt-id> -d <dir> [--json]` | Create a typed relation edge between two atoms |
| `mk relations <atom-id> -d <dir> [--json]` | Show inbound and outbound relation edges for an atom |
| `mk supersede <old-id> <new-id> -d <dir> [--json]` | Mark `<old-id>` as superseded by `<new-id>`; superseded atoms are excluded from recall |
| `mk migrate-relations -d <dir> [--dry-run\|--apply]` | Backfill `relations[]` from `links.related` and body-text atom ID references |
| `mk relink -d <dir> [--dry-run\|--apply]` | Extract relation edges from body-text atom ID references |
| `mk citations -d <dir> [--json]` | Extract and index concept-name citations across all atoms |
| `mk enrich-relations -d <dir> [--dry-run\|--apply] [--model <model>]` | Reclassify `related` edges into typed relations using an LLM (Ollama) |

### Advanced

| Command | Description |
|---------|-------------|
| `mk obsidian-init -d <dir> [--sync]` | Write `.obsidian/graph.json` with type-based color groups; `--sync` rewrites all atom files to include `## Relations` wikilink sections |
| `mk export-obsidian -d <dir> --out <vault-dir> [--include-archived] [--json]` | Export atom files to a separate Obsidian vault directory (use when you want an Obsidian view without opening `ENTITIES/` directly) |
| `mk wander -d <dir> [--seed id...] [--tags t...] [--steps N] [--json]` | Explore via spreading activation |
| `mk closure -d <dir> [--json] [--trajectory] [--trajectory-days N]` | Compute operational-closure metrics |
| `mk render -d <dir> -o <output-path> [--max-tokens N] [--no-fill] [--json]` | Render atoms to CLAUDE.md; beliefs with `extends` relations are grouped into developmental arcs |

### Per-agent isolation

| Command | Description |
|---------|-------------|
| `mk share <atom-id> --from <agent> -d <dir> [--json]` | Copy atom snapshot to shared namespace |
| `mk unshare <atom-id> -d <dir> [--json]` | Remove atom from shared namespace |
| `mk migrate -d <dir> --strategy <fresh\|partition\|clone-to-shared>` | Convert shared store to per-agent isolation |
| `mk status -d <dir> --all-agents [--json]` | Show per-agent summary |

---

## SDK

```typescript
import { initMemoryDir, createAtom, recall, recallWithEmbeddings, reflect, wander, indexCitations, closure, extractFromLog, consolidateAtoms } from 'memory-kernel';

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

// Recall (FTS-only — works without any API key)
const context = recall('./memory', { task: 'pagination API', max_tokens: 4000 });

// Recall with semantic re-ranking (hybrid FTS + embeddings when EMBEDDING_PROVIDER is set)
const semanticContext = await recallWithEmbeddings('./memory', { task: 'pagination API', max_tokens: 4000 });

// Reflect (consolidate)
reflect({ memoryDir: './memory', agent_id: 'my-agent', session_id: 'session-2' });

// Wander (find unexpected connections)
const result = wander({ memoryDir: './memory', seedTags: ['api', 'design'], steps: 5 });
// result.collisions — atom pairs from different domains with structural overlap
// result.activated — all activated atoms with scores

// Extract atoms from a conversation log (LLM-powered)
const extracted = await extractFromLog({
  logPath: './conversation.log',
  memoryDir: './memory',
  agentId: 'my-agent',
  sessionId: 'session-1',
  maxAtoms: 20,
});
// extracted.atoms — array of { atom_id, slug, type, status }

// Consolidate: review and promote auto-extracted drafts
const consolidated = await consolidateAtoms({
  memoryDir: './memory',
  dryRun: true,  // preview without writing
  limit: 50,
});
// consolidated.promoted — count of atoms promoted from draft to active

// Render to CLAUDE.md
import { renderClaudeMd } from 'memory-kernel';
const md = renderClaudeMd('./memory', { maxTokens: 8000 });
```

```typescript
// Per-agent isolation
import { initIsolatedBase, resolveAgentDir, isIsolated, recallIsolated, shareAtom } from 'memory-kernel';

// Initialize with isolation
initIsolatedBase('./memory', 'agent-alpha');
// Creates: agents/agent-alpha/, shared/, config.yaml

// Route operations to agent store
const agentDir = resolveAgentDir('./memory', 'agent-alpha');
createAtom({ memoryDir: agentDir, type: 'decision', slug: 'my-call', body: '...', agent_id: 'agent-alpha', session_id: 's1', confidence: 0.9 });

// Union recall (agent + shared atoms, agent wins on collision)
const bundle = recallIsolated('./memory', 'agent-alpha', { task: 'review decisions' });

// Share an atom with all agents
shareAtom('./memory', 'DECI-2026-04-16-MY-CALL-1234', 'agent-alpha', { agent_id: 'agent-alpha', session_id: 's1' });
```

Full API covers event sourcing, replay, episodes, multi-agent merge, encryption, import, conflict resolution, per-agent isolation, and more. **[SDK reference →](docs/sdk-reference.md)** | **[Isolation guide →](docs/isolation.md)**

---

## MCP Server

Memory Kernel exposes all operations as an MCP server for any MCP-capable agent.

```bash
MEMORY_DIR=/path/to/memory mk-mcp
```

| Tool | Maps to | Description |
|------|---------|-------------|
| `mk_remember` | `createAtom()` | Create atom |
| `mk_recall` | `recallWithEmbeddings()` | Load context (hybrid FTS + semantic when configured) |
| `mk_reflect` | `reflect()` | Consolidate |
| `mk_gc` | `reflect()` | Archive expired |
| `mk_merge` | `mergeEventLogs()` | Merge remote memory |
| `mk_list_conflicts` | `queryIndex` | List conflicts |
| `mk_resolve_conflict` | `resolveConflict()` | Resolve conflict |
| `mk_get_context_bundle` | `checkpoint()` | Full handoff bundle |
| `mk_share_atom` | `shareAtom()` | Share atom to shared namespace (isolated mode) |
| `mk_unshare_atom` | `unshareAtom()` | Remove from shared namespace (isolated mode) |

Resources: `memory://decisions`, `memory://constraints`, `memory://handoff`, `memory://open-questions`

Set `MCP_AGENT_ID` env var to route all tools to a specific agent store in isolated mode (defaults to `mcp-server`).

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

## NanoClaw Integration

Memory Kernel renders atoms into `CLAUDE.md`, which NanoClaw loads at session start — persistent memory with zero NanoClaw code changes.

```
Nightly: mk reflect → mk citations → mk render -d ./memory -o CLAUDE.md → git push
Next session: NanoClaw loads CLAUDE.md as context
```

**Drift pre-filter:** Set `MEMORY_DIR` in your `.env` and NanoClaw uses `mk wander` as a Tier 1 gate before post-conversation drift. Cheap spreading activation (~30 ms, no LLM) decides whether to spawn an expensive drift session — skips drift when no interesting connections are found, injects collision context when they are.

Install the `/mk-memory-setup` skill for interactive setup. The skill auto-detects NanoClaw and runs the full flow: install CLI, init store, write the mount allowlist, configure `container_config` in the NanoClaw DB, create conversation/impulse symlinks, seed identity + lifecycle atoms, render the first `CLAUDE.md`, schedule nightly cron, and restart NanoClaw — see [`skills/mk-memory-setup/references/nanoclaw.md`](skills/mk-memory-setup/references/nanoclaw.md) for the standalone steps if you'd rather run them manually.

**[Full integration guide →](docs/nanoclaw-integration.md)**

---

## Obsidian Integration

Memory Kernel's `ENTITIES/` directory can be opened directly as an Obsidian vault — no export step needed. Atom files are valid Markdown with YAML frontmatter, and relation edges render as `[[wikilinks]]` in a sentinel-delimited `## Relations` section at the end of each file.

### Quick setup

```bash
# 1. Initialize Obsidian graph config (type-based color groups for all 9 atom types)
mk obsidian-init -d ./memory

# 2. Rewrite existing atom files to include ## Relations wikilink sections
mk obsidian-init -d ./memory --sync

# 3. Open ENTITIES/ as an Obsidian vault
#    → Graph view shows typed relations as navigable links
#    → Tags are searchable via Obsidian's native tag index

# Alternative: export to a separate vault directory (read-only Obsidian view)
mk export-obsidian -d ./memory --out ./my-obsidian-vault
```

### What happens under the hood

- **Tag promotion**: `scope.tags` are promoted to a top-level `tags:` YAML field so Obsidian indexes them natively. Tags are merged back into `scope.tags` on parse — edits in Obsidian are preserved.
- **Wikilink relations**: Atoms with `frontmatter.relations[]` get a `## Relations` section delimited by `<!-- mk:relations -->` sentinels. The section is stripped on parse and never pollutes `atom.body`.
- **Graph coloring**: `mk obsidian-init` writes `.obsidian/graph.json` with color groups for all 9 atom types (belief, fact, decision, preference, open_question, procedure, entity_summary, constraint, conflict), using 4-char path-prefix queries.
- **Round-trip safe**: Edit atoms in Obsidian (body text, tags, frontmatter) and Memory Kernel reads them back correctly. The `## Relations` section is machine-managed — manual edits there will be overwritten on next serialize.

---

## Advanced Operations

### Wander — Spreading Activation

`mk wander` finds unexpected connections between atoms by walking the tag co-occurrence graph and explicit relation edges (`extends`, `supports`, `caused_by`, etc.). Pure computation — no LLM calls, runs in milliseconds.

Inspired by ACT-R (Anderson & Lebiere 1998) and Collins & Loftus (1975) spreading activation. This is Tier 1 of a two-tier architecture: cheap associative walks that surface candidates for expensive reasoning.

**How it works:** Seed from atoms or tags → spread activation through shared tags and relation neighbors (modulated by ACT-R base-level activation: recency × citation frequency) → sqrt-sigmoid modulation preserves important hub atoms → lateral inhibition keeps top-K per step → detect collision candidates (atom pairs with tag Jaccard dissimilarity > 0.7, scored by activation × dissimilarity).

**Tip:** Run `mk citations` before `mk wander` to index concept-name references — this provides frequency data for ACT-R activation scoring, significantly improving wander quality for stores with cross-referencing atoms.

```bash
mk citations -d ./memory          # Index concept-name citations (run once after changes)
mk wander -d ./memory --tags philosophy accounting --steps 5 --json
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `seeds` | auto | Atom IDs to start from. When omitted, 3 seeds are auto-selected **citation-primary** (most-cited first, recency as tiebreak) and drawn **round-robin across types** so the walk spans clusters rather than one type-monoculture |
| `seedTags` | — | Tags to resolve into seeds |
| `steps` | 3 | Spreading depth |
| `threshold` | 0.05 | Minimum activation to survive |
| `topK` | 20 | Lateral inhibition limit |
| `decay` | 0.5 | Spread decay factor |
| `maxCollisions` | 5 | Max collision candidates |
| `relationWeight` | 2.0 | Activation weight for explicit relation edges |
| `diverseSeeds` (CLI `--no-diverse-seeds` to disable) | `true` | Round-robin auto-seeds across atom types; disable for plain top-N by citation weight |

### Closure — Operational Closure Metrics

`mk closure` measures how self-referential a memory store is. Based on Luhmann's operational closure: a system that responds based on internal structure rather than external input.

```bash
mk closure -d ./memory --json
mk closure -d ./memory --trajectory --trajectory-days 10
```

**What it measures:**

| Metric | Description |
|--------|-------------|
| `closure_index` | `belief_pct × (avg_relations + avg_body_refs) / 100` — single number combining type composition and entanglement |
| `entanglement_pct` | Average body-text cross-references as % of theoretical maximum |
| `phase` | `early` (< 20 atoms), `type-composition` (< 60% beliefs), or `entanglement` (≥ 60% beliefs, ≥ 20 atoms) |
| `predictions` | Tooling-degradation predictions — how closure level affects LLM classification accuracy and cross-agent transplantability |

**Why it matters:** High-closure stores resist automated processing (LLM classifiers confounded by self-describing body text) and cross-agent transplantation (beliefs depend on other beliefs the receiving agent doesn't have). The closure index predicts both from a single variable.

**Trajectory mode** (`--trajectory`) shows daily closure evolution — useful for detecting entanglement acceleration over time.

---

## Performance

With SQLite index, 100-atom workload (see `scripts/bench-baseline.json` for raw numbers; run `npm run bench` to measure on your machine):

| Operation | Typical | Notes |
|-----------|---------|-------|
| `recall()` | ~2–5 ms | Falls back to file scan (~3–5× slower) without index |
| `reflect()` | ~100–200 ms | Idempotent — runs fast when nothing changed |
| `replay()` | ~2 ms | 100 atoms, ~160 events |
| `wander()` | < 30 ms | 200 atoms, pure computation, no LLM |

Numbers above are from a 100-atom store. Performance at larger scales (1k–10k atoms) has not been formally benchmarked — recall degrades gracefully via FTS, but heavier stores will take longer. Run `npm run bench:baseline` to pin a baseline on your own hardware.

---

## Environment Variables

All environment variables are optional. memory-kernel works fully without any of them.

### Embeddings

| Variable | Description | Default |
|----------|-------------|---------|
| `EMBEDDING_PROVIDER` | Embedding provider: `voyage` (512-dim) or `openai` (1536-dim) | _(none — FTS only)_ |
| `EMBEDDING_API_KEY` | API key for the embedding provider (generic) | _(none)_ |
| `VOYAGE_API_KEY` | Voyage AI API key (used when `EMBEDDING_PROVIDER=voyage` if `EMBEDDING_API_KEY` not set) | _(none)_ |
| `OPENAI_API_KEY` | OpenAI API key (used when `EMBEDDING_PROVIDER=openai` if `EMBEDDING_API_KEY` not set) | _(none)_ |
| `EMBEDDING_MODEL` | Override the default model for the provider | `voyage-3-lite` / `text-embedding-3-small` |
| `EMBEDDING_DIMENSIONS` | Override embedding dimensions (OpenAI only) | Provider default |
| `OLLAMA_URL` | Ollama server URL for local embedding / LLM calls | `http://localhost:11434` |

### Recall scoring

| Variable | Description | Default |
|----------|-------------|---------|
| `SEMANTIC_WEIGHT` | Weight for semantic similarity in hybrid ranking (0–1) | `0.6` |
| `MIN_SIMILARITY` | Minimum cosine similarity to include in results (0–1) | `0.3` |
| `RECALL_CONFIDENCE_FLOOR` | Minimum confidence score for atoms to appear in recall (0–1) | `0.7` |
| `RECALL_NEIGHBOR_BOOST` | Graph-walk neighbor boost factor (0–1) | `0.15` |
| `RECALL_GRAPH_BOOST` | Enable/disable graph-walk boost (`true`/`false`) | `true` |
| `RECALL_IDF_DAMPING` | IDF hub-damping strength (0 = disabled, 1 = full) | `1.0` |
| `RECALL_DECAY_WEIGHT` | Weight of recency decay in scoring (0–1) | `0.2` |
| `RECALL_DECAY_HALF_LIFE` | Half-life for temporal decay in days | `30` |
| `RECALL_MMR_LAMBDA` | MMR diversity-relevance tradeoff (0 = max diversity, 1 = max relevance) | `0.5` |
| `RECALL_COVERAGE_BOOST` | Query-term coverage boost factor | `0.3` |
| `RECALL_LENGTH_NORM_K` | Content-length normalisation constant | `0.5` |
| `RECALL_TYPE_WEIGHTS` | JSON object overriding per-type scoring weights | _(defaults in source)_ |
| `RECALL_TYPE_RESERVATIONS` | JSON object overriding per-type token reservations | _(defaults in source)_ |
| `EPISODE_BUDGET_RATIO` | Fraction of token budget reserved for episodes (0–1) | `0.2` |
| `MK_RENDER_BUDGET` | Default token budget for `mk render` | `16000` |

### Extraction

| Variable | Description | Default |
|----------|-------------|---------|
| `CLAUDE_PATH` | Path to the Claude CLI binary for `mk extract` | `claude` |
| `ANTHROPIC_API_KEY` | Anthropic API key (used by the Anthropic SDK path if set) | _(none)_ |

### Isolation

| Variable | Description | Default |
|----------|-------------|---------|
| `MK_ISOLATION` | Enable per-agent isolation mode (`per-agent`) | _(shared mode)_ |
| `MCP_AGENT_ID` | Default agent ID for MCP server operations | `mcp-server` |
| `MEMORY_ENCRYPTION_KEY` | Encryption key for SECRET-classified atoms | _(none — SECRET atoms skipped)_ |

---

## Design Principles

1. **Files are truth** — Markdown files. Human-readable, git-diffable, auditable, portable.
2. **SQLite is cache** — Derived from files. Delete it, rebuild with `mk reindex`. No lock-in. (One narrow exception: `entity_triples`. See [`docs/invariants.md`](docs/invariants.md).)
3. **Typed knowledge** — A fact carries more weight than a belief. Types encode this.
4. **Explicit lifecycle** — Created, updated, promoted, archived. Every change logged.
5. **Token-aware** — Recall respects budgets. Prioritizes by status and recency.
6. **Embeddings are opt-in** — Works fully without any API key (FTS-only). Add `EMBEDDING_PROVIDER` + `EMBEDDING_API_KEY` for hybrid semantic search. Graceful degradation throughout.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Cannot find module` | Run `npm run build` to compile TypeScript |
| FTS returns null | Run `mk reindex` to build the SQLite index |
| SECRET atoms skipped | Set `MEMORY_ENCRYPTION_KEY` env var |
| No atoms after merge | Run `mk reflect` — merge doesn't auto-regenerate views |
| Embeddings not working | Set `EMBEDDING_PROVIDER=voyage` + `EMBEDDING_API_KEY=...`, then `mk reindex --embed` |
| Conflict resolution | `mk reflect` → inspect `CONFLICTS/` → update atoms → `resolveConflict()` |
| Invalid agent ID | Agent IDs must be alphanumeric, dashes, or underscores only |
| `share requires per-agent isolation mode` | Enable isolation first: `mk migrate --strategy fresh` or set `isolation: per-agent` in `config.yaml` |
| `npm install` fails with node-gyp / build errors | `better-sqlite3` requires a C++ build toolchain. Install build dependencies: **macOS** `xcode-select --install`; **Debian/Ubuntu** `sudo apt-get install build-essential python3`; **Alpine** `apk add python3 make g++`. Then re-run `npm install`. |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, coding conventions, and PR guidelines. All changes must pass the full test suite and the docs-hygiene CI gate.

## Changelog

All notable changes are documented in [CHANGELOG.md](CHANGELOG.md).

---

## License

[Apache License 2.0](LICENSE)
