# CLI Integration Guide

> **Audience:** Orchestrators (OpenClaw, LangGraph, custom agents) that call memory-kernel via CLI instead of MCP. All commands support `--json` for structured output (v1.7.0+).

---

## Setup

```bash
npm install memory-kernel          # installs mk binary
mk --version                       # confirm the binary you're calling matches what you expect — a stale `mk` on PATH silently breaks --embed and recall semantics
mk init ~/my-agent/memory          # creates directory structure

# Or, for per-agent isolation (multiple agents sharing one directory):
mk init ~/shared-memory -a my-agent
```

Set `MEMORY_DIR` in your environment for convenience:

```bash
export MEMORY_DIR=~/my-agent/memory
```

Optional — for semantic search (hybrid FTS + embeddings):

```bash
export EMBEDDING_PROVIDER=openai   # or voyage
export EMBEDDING_API_KEY=sk-...
mk reindex -d $MEMORY_DIR --embed
```

**Which key var?** mk reads **`EMBEDDING_API_KEY`** first (works for any provider). For convenience it *falls back* to the provider-specific var when `EMBEDDING_API_KEY` is unset: `OPENAI_API_KEY` (when `EMBEDDING_PROVIDER=openai`) or `VOYAGE_API_KEY` (when `=voyage`). Setting `OPENAI_API_KEY` alone with `EMBEDDING_PROVIDER=voyage` resolves **nothing** — the fallback is provider-matched. When in doubt set `EMBEDDING_API_KEY` explicitly, and run `mk doctor` — its `embedding-key-source` check reports exactly which var resolved (this ambiguity caused a multi-day "key set, 0 vectors" outage).

Everything works without embeddings (FTS-only). No behavior change.

**Verify the integration** — run this after setup, and any time recall feels off. It's the 30-second check that surfaces the entire deployment seam (stale binary, unresolved key, 0 vectors, broken recall, stale sync) that the 2026-06 fleet incident lived in:

```bash
mk doctor -d $MEMORY_DIR                              # version + embedding-key-source + vectors==atoms + smoke-recall + sync-liveness
mk recall -d $MEMORY_DIR --task "smoke" --embed --json | head   # should return atoms (or recall_status no_match), never an error
```

---

## Session Lifecycle

> **Tip:** All commands accept `-a, --agent <id>` for [per-agent isolation](isolation.md). In shared mode the flag is ignored.

```
Session start  →  mk recall -d $DIR [-a $AGENT] --task "current task" --embed --json
                  (or load pre-rendered CLAUDE.md)

During session →  mk remember -d $DIR [-a $AGENT] -t fact "body text" --json
                  mk remember -d $DIR [-a $AGENT] -t decision "body text" --json
                  mk relate SRC-ID supports TGT-ID -d $DIR --json

Session end    →  mk episode --session-id $SID --summary "text" -d $DIR --json
                  mk render $DIR $OUTPUT_PATH

Post-session  →  mk extract <conversation-log> -d $DIR [--model <model>] --json
                  (auto-extract atoms from conversation log — creates drafts)

Periodic      →  mk consolidate -d $DIR [--dry-run] --json
                  (review and promote auto-extracted drafts to active)
```

### Nightly cron (recommended)

```bash
mk reflect -d $MEMORY_DIR
mk citations -d $MEMORY_DIR
mk reindex -d $MEMORY_DIR --embed   # so new atoms get vectors before render/recall
mk render $MEMORY_DIR $OUTPUT_PATH
mk doctor -d $MEMORY_DIR || true    # non-fatal self-canary — logs 0-vectors / stale-sync
```

Order matters: reflect cleans/promotes, citations updates frequency counts for spreading activation, `reindex --embed` refreshes vectors, render produces fresh output, and the `mk doctor` canary verifies the sync actually landed.

**Use `mk init --cron` for the production wrapper.** It generates a hardened script (#303) that encodes the field lessons: a self-contained `PATH`, **fail-soft** guards on every step (no bare `set -e` — one non-fatal failure can't silently kill the whole sync), the `reindex --embed` step, and the `mk doctor` self-canary. Don't hand-roll the bare commands above for an unattended cron.

---

## Commands & JSON Output

Every command accepts `--json` for structured stdout. Human-readable output goes to stderr or is suppressed when `--json` is set. Exit code 0 = success, non-zero = error.

### mk status

```bash
mk status -d $DIR --json
```

```json
{
  "memory_dir": "/path/to/memory",
  "atom_count": 97,
  "event_count": 168,
  "by_type": { "fact": 12, "belief": 63, "decision": 8 },
  "by_status": { "active": 85, "draft": 7, "archived": 5 },
  "index": { "exists": true, "atoms": 97, "tags": 45, "paths": 97 },
  "embeddings": { "exists": true, "count": 50, "model": "text-embedding-3-small" }
}
```

### mk remember

```bash
mk remember -d $DIR -t fact "The API rate limit is 1000 req/min" \
  --tags api infrastructure --confidence 0.95 --json
```

```json
{
  "id": "FACT-2026-04-05-THE-API-RATE-LIMIT-IS-1000-1a2b3",
  "type": "fact",
  "status": "active",
  "confidence": 0.95,
  "tags": ["api", "infrastructure"],
  "embedded": true
}
```

**Note:** `--tags` is space-separated (variadic), not comma-joined.

### mk recall

```bash
mk recall -d $DIR --task "pagination API" --embed --max-tokens 4000 --json
```

> **Always pass `--embed`** when embeddings are configured — it adds semantic re-ranking on top of FTS, so conceptual queries that miss on exact keywords still surface the right atom. Omit `--embed` for the FTS-only path (offline, or no embedding key). There is no `--no-embed` flag — omitting the flag *is* the FTS-only mode.

Returns the full `ContextBundle` object:

```json
{
  "atoms": [...],
  "episodes": [...],
  "index": "...",
  "handoff": "...",
  "constraints": "...",
  "decisions": "...",
  "open_questions": "...",
  "token_estimate": 3200
}
```

When `--task` is provided, atoms are re-ranked by composite score (FTS BM25 + optional cosine similarity + temporal decay + type weights). Without `--task`, returns type-grouped atoms within token budget.

Optional flags:
- `--include-episodes` — include session episodes
- `--include-drafts` — surface auto-extracted draft atoms (session-end extract output), which are excluded from recall by default
- `--decay-weight N` — weight for temporal decay (0–1, default 0.2)
- `--decay-half-life N` — recency half-life in days (default 30)
- `--no-graph` — disable graph-walk boost

### mk reflect

```bash
mk reflect -d $DIR --json
```

```json
{
  "deduped": 2,
  "expired": 1,
  "promoted": 3,
  "archived": 1,
  "conflicts_found": 0
}
```

Consolidation: deduplicates identical content, expires atoms past TTL, promotes vetted draft atoms to active (status-only, no type change — `open_question`s immediately; `fact`/`preference`/`decision` after 48h at confidence ≥ 0.7 with no active contradiction; `belief`/`procedure` held for review), detects contradictions. Idempotent — fast when nothing changed.

### mk gc

```bash
mk gc -d $DIR --json
```

Same output shape as `mk reflect`. Alias with GC framing — archives expired atoms.

### mk doctor

```bash
mk doctor -d $DIR --json
```

```json
{
  "healthy": true,
  "issue_count": 0,
  "issues": []
}
```

Exit code 1 when issues found. Use for health checks — distinguishes "no results" (normal) from "broken state" (needs attention).

**Integration-health checks (#305)** — beyond store/schema checks, `mk doctor` answers the post-upgrade / post-incident questions:
- `mk-version` — warns if a stale `mk` on PATH shadows the running kernel version.
- `embedding-key-source` — reports which env var supplied the embedding key (`EMBEDDING_API_KEY`, or the `OPENAI_API_KEY` / `VOYAGE_API_KEY` fallback) — last-4 only, never the key value; warns if a provider is set but no key resolves.
- `embeddings-vectors-fresh` — warns when embeddings are configured but the store has **0 vectors** for >0 atoms (embedding stalled, e.g. "key set, 0 vectors"); a partial count is reported as info (SECRET/PERSONAL atoms are never embedded).
- `smoke-recall` — read-only FTS probe that the recall/index path is queryable (no egress). Set `MK_DOCTOR_SMOKE_EMBED=1` (with a key, network not skipped) to also smoke the embedding recall path.
- `sync-liveness` — reports how long since the last reindex (`.memory-index.db` mtime). It only **warns** when you've declared a freshness SLA by setting `MK_SYNC_MAX_AGE_HOURS` (so an idle / manually-managed store with no nightly cron isn't a false positive); past that threshold it flags a silently-stopped nightly sync.

All are side-effect-free (read-only — a plain `mk doctor` never migrates the index). Boundary: `mk doctor` = integration health; knowledge/composition health (e.g. belief monoculture) stays in `mk lint`.

### mk checkpoint

```bash
mk checkpoint -d $DIR --json
```

```json
{
  "event_id": "evt-...",
  "token_estimate": 4200,
  "atom_count": 85,
  "markdown": "...",
  "error": null
}
```

Full handoff bundle — reflect + recall + context in one call.

### mk episode

```bash
mk episode --session-id sess-123 --summary "Implemented pagination API" -d $DIR --json
```

```json
{
  "episode_id": "EP-2026-04-05-sess-123",
  "file": "EPISODES/EP-2026-04-05-sess-123.md"
}
```

### mk episodes

```bash
mk episodes -d $DIR --limit 5 --json
```

Returns an array of episode objects.

### mk wander

```bash
mk wander -d $DIR --tags philosophy accounting --steps 5 --json
```

```json
{
  "seeds_used": ["BELI-..."],
  "steps_taken": 5,
  "activated": [
    { "atom_id": "BELI-...", "activation": 0.85, "type": "belief" }
  ],
  "collisions": [
    {
      "atom_a": "BELI-...",
      "atom_b": "DECI-...",
      "dissimilarity": 0.82,
      "score": 0.42
    }
  ],
  "duration_ms": 12
}
```

**Tip:** Run `mk citations -d $DIR` before wander to index concept-name references — provides frequency data for ACT-R activation scoring, significantly improving wander quality.

**Auto-seeding:** with no `--seed`/`--tags`, seeds are auto-selected **citation-primary** (most-cited first, recency as tiebreak) and drawn **round-robin across atom types** so the walk spans clusters instead of one type-monoculture. Pass `--no-diverse-seeds` for plain top-N by citation weight.

Parameters: `--seed` and `--tags` are space-separated (variadic). `--steps`, `--threshold`, `--top-k`, `--decay`, `--relation-weight`, `--max-collisions` are numeric. `--no-diverse-seeds` is a boolean toggle.

### mk relate

```bash
mk relate SRC-ID supports TGT-ID -d $DIR --json
```

```json
{
  "source_id": "DECI-...",
  "relation_type": "supports",
  "target_id": "FACT-...",
  "created": true
}
```

Relation types: `extends`, `contradicts`, `supports`, `caused_by`, `supersedes`, `related`.

Idempotent — returns `"created": false` if the relation already exists.

### mk relations

```bash
mk relations ATOM-ID -d $DIR --json
```

```json
{
  "atom_id": "DECI-...",
  "outbound": [
    { "target_id": "FACT-...", "relation_type": "supports" }
  ],
  "inbound": [
    { "source_id": "BELI-...", "relation_type": "extends" }
  ]
}
```

### mk citations

```bash
mk citations -d $DIR --json
```

Indexes concept-name references across all atoms. Run before `mk wander` for best results.

### mk render

```bash
mk render $MEMORY_DIR $OUTPUT_PATH --max-tokens 8000
```

Renders atoms into a Markdown file (typically CLAUDE.md). Beliefs with `extends` relations are grouped into developmental arcs. No `--json` flag — output IS the rendered file.

### mk extract

```bash
mk extract ./conversation.log -d $DIR --json
```

```json
{
  "extracted": 5,
  "skipped": 1,
  "possible_duplicates": 2,
  "atoms": [
    { "atom_id": "FACT-2026-04-22-...", "slug": "api-rate-limit", "type": "fact", "status": "new" },
    { "atom_id": null, "slug": "old-fact", "type": "fact", "status": "possible_duplicate", "possible_duplicate_of": "FACT-2026-04-01-..." }
  ]
}
```

Reads a conversation log, calls an LLM to extract facts/decisions/beliefs/preferences, reconciles against the existing store, and writes draft atoms. Extracted atoms have `status: draft` and `source: auto-extracted` metadata.

Optional flags:
- `--model <model>` — LLM to use. Omit for Claude CLI (`claude -p`), or pass an Ollama model name (e.g. `qwen2.5:14b`)
- `--dry-run` — preview extractions without writing files
- `--max-atoms <n>` — max atoms to extract (default: 20)
- `--skip-lines <n>` — skip first N lines of the log (e.g. CLAUDE.md preamble)
- `--agent-id <id>`, `--session-id <id>` — tag extracted atoms

**Environment:** Set `CLAUDE_PATH` to override the Claude CLI binary path (default: `claude` on PATH).

### mk consolidate

```bash
mk consolidate -d $DIR --json
```

```json
{
  "processed": 8,
  "promoted": 5,
  "skipped": 3,
  "errors": 0,
  "dry_run": false,
  "atoms": [
    { "atom_id": "FACT-2026-04-22-...", "slug": "api-rate-limit", "type": "fact", "status": "promoted", "title": "API rate limit is 1000/min" },
    { "atom_id": "FACT-2026-04-22-...", "slug": "old-fact", "type": "fact", "status": "skipped", "title": "...", "possible_duplicate_of": "FACT-2026-04-01-..." }
  ]
}
```

Reviews auto-extracted draft atoms and promotes them to active. Detects possible duplicates via BM25 ranking against the active store.

Optional flags:
- `--dry-run` — preview without writing
- `--all` — include ALL draft atoms, not just auto-extracted ones
- `--type <type>` — filter by atom type (e.g. `belief`, `fact`)
- `--limit <n>` — max atoms to process (default: 50)
- `--duplicate-threshold <n>` — BM25 rank threshold for duplicate detection (default: -2.0)
- `--agent-id <id>`, `--session-id <id>` — for event attribution

### mk reindex

```bash
mk reindex -d $DIR --embed
```

Rebuilds SQLite index from files. `--embed` computes embeddings for all atoms (requires `EMBEDDING_PROVIDER` + `EMBEDDING_API_KEY`).

---

## Error Handling

| Exit code | Meaning | Action |
|-----------|---------|--------|
| 0 | Success (including "no results") | Parse JSON output |
| 1 | Error or validation failure | Check stderr for details, run `mk doctor --json` |

"No results" from `mk recall` is normal (exit 0, empty atoms array) — the memory may simply not contain relevant atoms yet. "Broken state" (exit non-zero) means something needs repair — run `mk doctor --json` and follow the `issues` array.

---

## Multi-Agent Memory

**Preferred: per-agent isolation** — multiple agents share one memory directory with private stores and controlled sharing:

```bash
# Initialize with per-agent isolation
mk init $MEMORY_DIR -a agent-alpha
mk init $MEMORY_DIR -a agent-beta   # adds second agent store

# Each agent reads/writes to their own store
mk remember -d $MEMORY_DIR -a agent-alpha -t fact "Redis for caching" --json
mk remember -d $MEMORY_DIR -a agent-beta  -t fact "PostgreSQL for storage" --json

# Share specific atoms across agents
mk share FACT-2026-xxx --from agent-alpha -d $MEMORY_DIR --json

# Agent Beta recalls: sees own atoms + shared ones
mk recall -d $MEMORY_DIR -a agent-beta --task "data layer" --embed --json

# View all agents at a glance
mk status -d $MEMORY_DIR --all-agents --json
```

**Migration from shared to isolated:**

```bash
mk migrate -d $MEMORY_DIR --strategy partition --json   # route by creating agent_id
mk migrate -d $MEMORY_DIR --strategy clone-to-shared     # or make everything shared
mk migrate -d $MEMORY_DIR --strategy fresh                # or just enable mode
```

See the **[isolation guide](isolation.md)** for full details.

**Alternative: separate directories + merge** — for fully independent agents (different hosts, async sync):

```bash
mk merge -d $AGENT_A_MEMORY --from $AGENT_B_MEMORY/events.ndjson
mk reflect -d $AGENT_A_MEMORY    # post-merge: dedup, detect conflicts
```

---

## Library Import (Alternative)

The same npm package provides both CLI and TypeScript SDK. For zero-overhead integration (no Node.js startup cost):

```typescript
import { createAtom, recall, reflect, wander, extractFromLog, consolidateAtoms } from 'memory-kernel';
```

See [SDK reference](sdk-reference.md) for the full API. CLI and library are functionally equivalent — choose based on whether you prefer process isolation (CLI) or in-process performance (library).
