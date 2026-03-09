# Memory Kernel — Build Plan

**Started:** 2026-03-09
**Builder:** mainion-ai (Claude agent on Raspberry Pi 5)
**Status:** In progress — v0.1 MVP

## What this is

A model-agnostic, file-first memory kernel for AI agents. Prevents context degradation, compaction loss, and cross-session amnesia through typed memory atoms with explicit lifecycle controls.

Based on [memory-kernel-prd.md](./docs/memory-kernel-prd.md) with scope trimmed to single-agent MVP.

## Architecture (v0.1)

```
memory-kernel/
  src/
    schema.ts        — Atom types, validation (Zod)
    event-log.ts     — Append-only NDJSON event logger
    store.ts         — Filesystem read/write (atomic writes)
    index.ts         — SQLite index for fast lookups
    retain.ts        — Capture events + update atoms
    recall.ts        — Progressive disclosure context loader
    reflect.ts       — Consolidate, TTL/GC, promotion, dedup
    format.ts        — Canonicalization (stable YAML + markdown)
    types.ts         — Shared TypeScript types
  cli/
    mk.ts            — CLI entry point
    commands/         — init, checkpoint, recall, reflect, gc, doctor
  templates/
    INDEX.md          — Routing index template
    HANDOFF.md        — Working state template
    DECISIONS.md      — Decision log template
    CONSTRAINTS.md    — Constraints template
    OPEN_QUESTIONS.md — Open questions template
    atom.md           — Single atom template
  test/
    schema.test.ts
    event-log.test.ts
    store.test.ts
    retain.test.ts
    recall.test.ts
    reflect.test.ts
    format.test.ts
    integration/
      replay.test.ts       — Deterministic replay
      checkpoint.test.ts   — Checkpoint/handoff generation
```

## Build order

1. **Foundation** — types, schema (Zod), atom templates
2. **Store** — atomic file writes, directory layout creation (`mk init`)
3. **Event log** — append-only NDJSON writer/reader
4. **Retain** — capture events, create/update atoms
5. **Recall** — progressive disclosure context loader
6. **Reflect** — consolidation, TTL, promotion, GC, dedup
7. **Format** — canonicalization (stable YAML sort, timestamps)
8. **SQLite index** — fast lookups by type/status/scope/tags
9. **CLI** — `mk` commands wrapping SDK
10. **Tests** — unit per module + integration (replay, checkpoint)

## Scoped OUT of v0.1

- Multi-agent merge / CRDTs
- MCP server
- Encryption at rest
- Benchmark eval suites (LongMemEval, LoCoMo)
- Adapters (Letta, LangGraph, Mem0)
- Semantic/vector recall
- Graph-based recall

## Key decisions made

| # | Decision | Why |
|---|----------|-----|
| 1 | TypeScript | Matches NanoClaw, runs on RPi, npm ecosystem |
| 2 | File-first, SQLite as index cache | Files are truth, index is rebuildable |
| 3 | NDJSON for event log | Simple, streamable, grep-friendly |
| 4 | Zod for schema validation | Runtime + compile-time safety |
| 5 | Atomic writes via temp+rename | Crash safety without WAL complexity |
| 6 | `provenance` and `links` optional in v0.1 | Reduce atom boilerplate for MVP |
| 7 | No LLM calls in v0.1 reflect | Deterministic reducers only; LLM-assisted consolidation deferred |
| 8 | Event log as source of truth | Views are derived; replay rebuilds them |

## Tech stack

- TypeScript 5.x + Node.js
- Zod (schema validation)
- better-sqlite3 (index)
- Commander.js (CLI)
- Vitest (testing)
- gray-matter (YAML frontmatter parsing)
- js-yaml (YAML serialization)
