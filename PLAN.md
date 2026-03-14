# Memory Kernel — Build Plan

**Started:** 2026-03-09
**Builder:** mainion-ai (Claude agent on Raspberry Pi 5)
**Status:** v1.0.0 — Milestone G complete — **RELEASED** ✅

## What this is

A model-agnostic, file-first memory kernel for AI agents. Prevents context degradation, compaction loss, and cross-session amnesia through typed memory atoms with explicit lifecycle controls.

Based on [memory-kernel-prd-v1.2.md](./docs/memory-kernel-prd-v1.2.md) with scope trimmed to single-agent MVP.

## Architecture (v0.1)

> Initial design — current architecture is documented in [README.md](./README.md).

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

- ~~MCP server~~ (implemented in v0.8.0)
- ~~Encryption at rest~~ (implemented in v0.9.0)
- Benchmark eval suites (LongMemEval, LoCoMo)
- Adapters (Letta, LangGraph, Mem0)
- Semantic/vector recall
- Graph-based recall

> Multi-agent merge (event-log union, Pattern B) was originally out-of-scope but was implemented in v0.7.0 (Milestone D).

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
- better-sqlite3 (index + FTS5)
- Commander.js (CLI)
- Vitest (testing)
- gray-matter (YAML frontmatter parsing)
- js-yaml (YAML serialization)

---

## Milestone history

| Version | Milestone | Key deliverables | Tests |
|---------|-----------|-----------------|-------|
| v0.1.0 | Foundation | Core retain/recall/reflect, 9 atom types, NDJSON event log, SQLite index, `mk` CLI | 124 |
| v0.2.0 | Hardening | Path traversal guards, atomic writes, bug fixes, `mk compact`, connection caching | 152 |
| v0.3.0 | Milestone A | 5 pure view renderers, `checkpoint()` API, `mk checkpoint` CLI | 193 |
| v0.4.0 | Milestone B | Event log V2 with snapshots, evidence store, replay engine, bootstrap migration | 282 |
| v0.5.0 | Code review | Security fixes, reflect index sync, reflect single-pass, log compaction, schema versioning | 329 |
| v0.5.1 | Stress tests | 54 stress/edge-case tests across all subsystems | 383 |
| **v0.6.0** | **Milestone C** | FTS5 search, task-aware recall, episode store, conflict detection heuristic | **434** |
| **v0.7.0** | **Milestone D** | Multi-agent event-log union merge, `mergeEventLogs()` SDK, `mk merge` CLI, conflict atoms for concurrent updates | **448** |
| **v0.8.0** | **Milestone E** | MCP server (`src/mcp/server.ts`), 8 tools, 4 resources, `resolveConflict()` kernel function, contract tests | **476** |
| **v0.9.0** | **Milestone F** | AES-256-GCM encryption for SECRET atoms, read audit logging (`atom_read` event), `mk import` / `importFromFile()` | **531** |
| **v1.0.0** | **Milestone G** | Compaction-loss torture tests (13 PR gates), benchmark harness (`scripts/bench.ts`), README Performance + Troubleshooting | **551** |

## Upcoming milestones

> v1.0.0 has shipped. All PRD v1.2 acceptance criteria are met. Future work tracked separately.
