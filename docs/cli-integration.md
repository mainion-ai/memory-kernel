# CLI Integration Guide

> **Audience:** Orchestrators (OpenClaw, LangGraph, custom agents) that call memory-kernel via CLI instead of MCP. All commands support `--json` for structured output (v1.7.0+).

---

## Setup

```bash
npm install memory-kernel          # installs mk binary
mk init ~/my-agent/memory          # creates directory structure
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

Everything works without embeddings (FTS-only). No behavior change.

---

## Session Lifecycle

```
Session start  →  mk recall -d $DIR --task "current task" --json
                  (or load pre-rendered CLAUDE.md)

During session →  mk remember -d $DIR -t fact "body text" --json
                  mk remember -d $DIR -t decision "body text" --json
                  mk relate SRC-ID supports TGT-ID -d $DIR --json

Session end    →  mk episode --session-id $SID --summary "text" -d $DIR --json
                  mk render $DIR $OUTPUT_PATH
```

### Nightly cron (recommended)

```bash
mk reflect -d $MEMORY_DIR
mk citations -d $MEMORY_DIR
mk render $MEMORY_DIR $OUTPUT_PATH
```

Order matters: reflect cleans/promotes, citations updates frequency counts for spreading activation, render produces fresh output incorporating both.

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
mk recall -d $DIR --task "pagination API" --max-tokens 4000 --json
```

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
- `--decay-weight N` — weight for temporal decay (0–1, default 0.3)
- `--half-life N` — recency half-life in days (default 14)
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

Consolidation: deduplicates identical content, expires atoms past TTL, promotes beliefs with confidence ≥ 0.9 to facts, detects contradictions. Idempotent — fast when nothing changed.

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

Parameters: `--seed` and `--tags` are space-separated (variadic). `--steps`, `--threshold`, `--top-k`, `--decay`, `--relation-weight`, `--max-collisions` are numeric.

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

## Separate Memory Per Agent

Each agent should have its own memory directory. Share knowledge between agents via event log merge, not shared directories:

```bash
mk merge -d $AGENT_A_MEMORY --from $AGENT_B_MEMORY/events.ndjson
mk reflect -d $AGENT_A_MEMORY    # post-merge: dedup, detect conflicts
```

---

## Library Import (Alternative)

The same npm package provides both CLI and TypeScript SDK. For zero-overhead integration (no Node.js startup cost):

```typescript
import { createAtom, recall, reflect, wander } from 'memory-kernel';
```

See [SDK reference](sdk-reference.md) for the full API. CLI and library are functionally equivalent — choose based on whether you prefer process isolation (CLI) or in-process performance (library).
