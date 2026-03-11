# Coding Instructions

Development guidelines for contributors and AI agents working on memory-kernel.

---

## Test Structure

Tests live in `test/` and run with `npm test` (vitest). There are two layers:

| File | Purpose |
|---|---|
| `test/comprehensive.test.ts` | Full integration: retain/recall/reflect lifecycle |
| `test/kernel.test.ts` | Unit tests for core operations |
| `test/renderers.test.ts` | Pure renderer tests |
| `test/checkpoint.test.ts` | Checkpoint/handoff generation |
| `test/evidence.test.ts` | Content-addressed blob store |
| `test/schema-v2.test.ts` | V1/V2 event compat, mutation actions |
| `test/replay.test.ts` | Deterministic replay from events |
| `test/bootstrap.test.ts` | Event bootstrap migration |
| `test/milestone-b.test.ts` | Integration: full event-sourced lifecycle |
| `test/index-db.test.ts` | SQLite index, LIMIT, caching |
| `test/stress.test.ts` | Edge cases, error paths, invariants |

### Standard test boilerplate

```typescript
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  initMemoryDir,
  createAtom,
  // ... other imports
  closeAllIndexes,
} from '../src/index.js';

const AGENT = 'test-agent';
const SESSION = 'test-session';
let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-test-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

const base = (dir: string) => ({
  memoryDir: dir,
  agent_id: AGENT,
  session_id: SESSION,
});
```

Always call `closeAllIndexes()` **before** `fs.rmSync` in `afterEach` — SQLite connections must be released before the directory is deleted.

---

## API Gotchas

### `updateAtom` — `body` is top-level, not inside `updates`

```typescript
// WRONG — body is not a frontmatter field
updateAtom({ ...base(dir), filePath, updates: { body: 'new', confidence: 0.9 } });

// CORRECT
updateAtom({ ...base(dir), filePath, updates: { confidence: 0.9 }, body: 'new' });
```

`updates` accepts only: `{ status?, confidence?, scope?, links?, provenance? }`.

### `archiveAtom` idempotency — use the archive path for the second call

`archiveAtom` checks `atom.frontmatter.status === 'archived'` and returns early. But the idempotency only triggers when the file is at the **archive path** — the original `ENTITIES/` path no longer exists after the first call.

```typescript
const atom = createAtom({ ...base(dir), ... });
archiveAtom({ ...base(dir), filePath: atom.filePath! });

// second call must use ARCHIVE/ path
const archPath = path.join(dir, 'ARCHIVE', path.basename(atom.filePath!));
archiveAtom({ ...base(dir), filePath: archPath }); // idempotent, no crash
```

### `ReflectResult` fields

```typescript
const r = reflect({ memoryDir: dir, agent_id: AGENT, session_id: SESSION });
// r.deduped, r.expired, r.promoted, r.archived, r.events_emitted
// r.conflicts_found  ← NOT r.conflicts
```

### `ReplayResult` — archived atoms are ABSENT from the map

`atom_archived` events call `atoms.delete(id)`. There is no `r.archived` set.

```typescript
const r = replayFromFile(eventsFile, { outputDir });
expect(r.atoms.has(archivedId)).toBe(false); // correct
// NOT: r.archived.has(archivedId)           // wrong — field doesn't exist
```

### `queryIndex` — `limit` is in the third `opts` argument

```typescript
// WRONG
queryIndex(dir, { limit: 2 });

// CORRECT
queryIndex(dir, {}, { limit: 2 });
// signature: queryIndex(memoryDir, query, opts?)
```

### `ttl_days: 0` is valid (ephemeral atoms)

The schema uses `.min(0)` not `.positive()`. Zero means the atom expires immediately on the next reflect.

---

## Deduplication rules

- Dedup key: `${type}::${body.trim()}` — same type + trimmed body = duplicate.
- Cross-type identical bodies are **not** deduped.
- `body.trim()` is used — leading/trailing whitespace-only differences dedup.
- The **newer** atom (later `created_at`) is kept; older ones are archived.

---

## Auto-promotion threshold

`confidence >= 0.9` for `status === 'draft'` beliefs only.

- `0.9` IS promoted.
- `0.899` is NOT promoted.
- `status === 'accepted'` beliefs are NOT promoted even at `confidence = 1`.

---

## Replay layer — schema validation

`replay()` validates atom snapshots against `AtomFrontmatterSchema` after parsing. Events with invalid `type`, `status`, or out-of-range `confidence` values are rejected with an error entry and excluded from the atom map:

```typescript
const badSnapshot = `---\nid: XXXX-bad\ntype: invalid_type\n...\n---\nbody`;
const event: MemoryEvent = { ..., action: 'atom_created', atom_snapshot: badSnapshot };
const r = replay([event]);
expect(r.errors).toHaveLength(1);       // validation error reported
expect(r.atoms.has('XXXX-bad')).toBe(false);  // atom excluded
```

Validation happens at both write time (`createAtom`/`updateAtom`) and replay time (`replay()`/`replayFromFile()`). This prevents corrupt or hand-crafted event log entries from poisoning reconstructed state.

---

## Writing stress tests

When adding tests to `test/stress.test.ts`, follow these conventions:

1. **Test actual behavior, not hoped-for behavior.** If the current code silently accepts invalid input, write the assertion for that behavior (with a comment explaining it's a known gap, not a desired invariant). This makes any future change to that behavior visible.

2. **Use the `patchExpiry` helper** for TTL-related tests:

   ```typescript
   function patchExpiry(filePath: string): void {
     const c = fs.readFileSync(filePath, 'utf-8');
     fs.writeFileSync(filePath, c
       .replace(/ttl_days: \d+/, 'ttl_days: 0')
       .replace(/created_at: [^\n]+/, 'created_at: 2000-01-01T00:00:00Z')
       .replace(/updated_at: [^\n]+/, 'updated_at: 2000-01-01T00:00:00Z'));
   }
   ```

   This patches both `ttl_days` and timestamps directly (no YAML parser needed).

3. **Long-running tests** need an explicit timeout:

   ```typescript
   it('500 atoms: reflect completes in < 15s', { timeout: 30000 }, () => { ... });
   ```

4. **Path traversal tests** — assert `toThrow(/traversal|outside/i)` or verify the file was not written outside `outputDir`. Don't assume the exact error message.

5. **Event log corruption tests** — write raw bytes or malformed JSON directly via `fs.writeFileSync` to the events file, then test that the reader/replay handles them gracefully without crashing.

6. **Performance tests** — prefer timing assertions (`< 15000 ms`) over fixed thresholds. The observed baseline for 500 atoms is ~63ms; the test allows 15s for slow CI environments.

---

## Event log format

Events are NDJSON (one JSON object per line) in `events.ndjson`. Mutation actions carry V2 fields:

```json
{
  "event_id": "EVNT-2026-03-11-...",
  "timestamp": "2026-03-11T00:00:00.000Z",
  "agent_id": "test-agent",
  "session_id": "test-session",
  "action": "atom_created",
  "atom_refs": ["DECI-2026-03-11-..."],
  "schema_version": 2,
  "atom_snapshot": "---\nid: ...\n---\nbody"
}
```

Mutation actions: `atom_created`, `atom_updated`, `atom_archived`, `atom_promoted`, `atom_expired`, `atom_imported`.

Non-mutation events (`session_started`, `reflect_completed`, `gc_completed`, etc.) are preserved by `compactLog` — never removed.

---

## Log compaction invariant

After `compactLog(dir)`:
- Each atom has at most **one** mutation event (the latest).
- All non-mutation events are preserved.
- A second `compactLog` removes 0 more events.
- The reconstructed atom state (body, confidence, status) is identical before and after compaction.

Test this invariant whenever you add new mutation event types.

---

## Security rules

All file paths from user/external input must pass `assertWithinDir(memoryDir, resolvedPath)` before any file I/O. This applies to:
- `updateAtom({ filePath })` — already guarded
- `archiveAtom({ filePath })` — already guarded
- `replayFromFile` output paths — already guarded via `atomFilePath` + `assertWithinDir`
- Any new operation that accepts a file path parameter

If you add a new operation that writes files, add the guard and a corresponding path traversal test in `test/stress.test.ts`.

---

## PRD v1.2 — Implementation Status (as of v0.5.0)

Reference PRD: `docs/memory-kernel-prd-v1.2.md` (2026-03-10, local-only, gitignored).

### What's DONE ✅

| PRD Requirement | Implementation |
|---|---|
| **v0.1 MVP** (§6.1) — all 6 items | Directory layout, checkpoint, context loader, TTL/promotion/GC, CLI (13 cmds), SDK |
| **FR-1** Evidence Store | `src/evidence.ts` — SHA-256 content-addressed, atomic writes, dedup by hash |
| **FR-2** Event Log | `src/event-log.ts` — NDJSON, V2 snapshots, fsync, compaction |
| **FR-3** State Views | `src/renderers.ts` — INDEX, HANDOFF, DECISIONS, CONSTRAINTS, OPEN_QUESTIONS (line budgets enforced) |
| **FR-4** Retain | `src/retain.ts` — createAtom, updateAtom, archiveAtom (all emit V2 events, auto-index) |
| **FR-6** Reflect (deterministic) | `src/reflect.ts` — single-pass: expiry, dedup, autoPromote, view regeneration |
| **FR-7** All 9 atom types | `src/types.ts` — decision, constraint, open_question, belief, fact, procedure, entity_summary, preference, conflict |
| **FR-13** Data classification | PUBLIC, TEAM, PERSONAL, SECRET — enforced in recall filter + SQLite index query |
| Atomic writes + crash safety | tmp → fsync → rename in store.ts + evidence.ts; WAL mode in SQLite |
| Deterministic replay | `src/replay.ts` — same events → identical atoms + views |
| Event sourcing (§11.1) | V2 events with inline snapshots |
| Canonicalization (§11.3) | Sorted YAML keys, UTC ISO8601, stable headings |
| Progressive disclosure (§11.6) | INDEX ≤ 200 lines, HANDOFF ≤ 80 lines |
| Recall gating (§11.9) | PERSONAL + SECRET excluded by default |
| SQLite index (§11.5, partial) | Metadata index with connection caching + schema versioning — **no FTS5 yet** |

### What's PARTIAL ⚠️

| Area | What exists | What's missing |
|---|---|---|
| **FR-5 Recall — task-aware** | `RecallQuery.task` field defined (`@todo v0.2`). Accepted by CLI `--task`. **Completely ignored by recall().** | FTS5 index + keyword scoring needed (required for v1) |
| **FR-5 Recall — episodes** | `RecallQuery.include_episodes` field defined (`@todo v0.2`). `ContextBundle.episodes` field exists. **Never populated.** | Episode loading logic needed |
| **FR-2a Episode Store** | `EPISODES/` directory scaffolded by `initMemoryDir()`. **Zero implementation.** | writeEpisode, readEpisode, listEpisodes, linkEpisodeToAtom |
| **FR-6 Reflect — conflicts** | Counts pre-existing conflict atoms | Does not detect new conflicts (scope overlap, contradictions) — `@todo v0.2` |
| **FR-8 TTL + decay** | Hard TTL expiry works | No gradual confidence decay |
| **FR-9 Promotion** | confidence ≥ 0.9 auto-promote | No corroboration, user confirmation, or evidence triggers |
| **FR-15 Audit** | All writes logged as events | Read access (recall) not logged |
| **Provenance** | Fields exist on AtomFrontmatter (`provenance.episodes`, `provenance.evidence`). Accepted in createAtom/updateAtom. | **Never auto-populated** by any system operation |

### What's NOT Started ❌

| Area | PRD Section |
|---|---|
| **FR-10** Concurrent writers | §7.5 |
| **FR-11** Convergent merges (CRDT or event-log union) | §7.5 |
| **FR-12** Conflict detection + resolution workflow | §7.5 |
| **FR-14** Encryption at rest (SECRET) | §7.6 |
| **FR-16** Memory Packet import/export | §7.7 |
| **FR-19** MCP server | §7.8 |
| `mk merge` CLI + `merge()` SDK | §7.8 |
| System/E2E tests (multi-process) | §12.3 |
| Benchmark harness (LongMemEval, LoCoMo) | §12.4 |
| Performance benchmarks (p95) | §12.5 |

---

## PRD v1.0 → v1.2 Key Deltas

These are the **new requirements** added in PRD v1.2 that were not in v1.0:

| Delta | PRD Section | Summary |
|---|---|---|
| **FR-2a Episode Store** | §7.1 (new) | New store for per-session artifacts. Helpers needed: `writeEpisode()`, `readEpisode()`, `linkEpisodeToAtom()`. |
| **Task-aware recall (FTS)** | §7.2, §11.5 | `RecallQuery.task` must influence ranking. SQLite FTS5 required for v1. Embeddings optional/v2. |
| **Episode-aware recall** | §7.2, §11.6a (new) | Recall includes episodes on demand (by provenance, `include_episodes`, or task/keyword match). |
| **FTS index required** | §11.5 | "Implement SQLite FTS (FTS5) index over atom titles/body" + deterministic lexical fallback. |
| **Benchmarks relaxed** | §5.2 | v1 goal = "harness runnable + baseline recorded", not competitive scores. |
| **LoCoMo explicitly vNext** | §3.2 | Full memory reasoning system is non-goal for v1. |
| **LLM-assisted reflect deferred** | §7.2 FR-6 | "v1 default: deterministic (no LLM calls)" made explicit. |
| **memory-kernel acknowledged** | §10.8 (new) | npm package listed as near-complete v0.1 MVP baseline. |

---

## Existing Stubs & TODOs in Code

These are wired into the type system but have no implementation. Future milestones should activate them:

| Stub | Location | Notes |
|---|---|---|
| `RecallQuery.task` | `src/types.ts:123` | `string \| undefined`, marked `@todo v0.2`. Passed through CLI `--task` and checkpoint but **ignored** by `recall()`. |
| `RecallQuery.include_episodes` | `src/types.ts:129` | `boolean \| undefined`, marked `@todo v0.2`. Never checked by `recall()`. |
| `ContextBundle.episodes` | `src/types.ts:140` | `string[] \| undefined`. Field exists but never populated. |
| `EPISODES/` directory | `src/store.ts:18` | Created by `initMemoryDir()`. Contains no files — no episode write logic exists. |
| `detectConflicts()` | `src/reflect.ts:296` | Only counts existing conflict atoms. `@todo v0.2` — does not detect new conflicts. |
| `provenance.episodes` | `src/types.ts:63` | Field on AtomFrontmatter. Accepted but never auto-populated. |
| `provenance.evidence` | `src/types.ts:64` | Field on AtomFrontmatter. Accepted but never auto-populated. |

---

## Milestone Roadmap (PRD v1.2)

### Milestone C: ✅ COMPLETE → v0.6.0
- **FR-2a**: Episode Store — `writeEpisode`, `readEpisode`, `listEpisodes`, `linkEpisodeToAtom` ✅
- **FR-5**: FTS5 index (schema v3) + task-aware BM25 ranking in `recall()` ✅
- **§11.6a**: Episode-aware recall (`include_episodes`, keyword match) ✅
- Conflict detection heuristic in `reflect.ts` ✅
- Tests: `test/stress.test.ts` blocks 15–18 (FTS5, task-aware recall, episode store, conflict heuristic) ✅
- CLI: `mk episode`, `mk episodes`, recall `--task`, `--include-episodes` ✅
- Total test count: **398 passing** across 11 test files

### Milestone D: Multi-Agent Merge → v0.7.0
- **FR-10**: Concurrent writers (advisory locks)
- **FR-11**: Event-log union + deterministic reducer (§11.7 Pattern B)
- **FR-12**: Conflict detection in reflect (scope overlap, contradictions)
- `mk merge` CLI + `merge()` SDK
- Multi-process E2E tests (§12.3)

### Milestone E: MCP Server → v0.8.0
- **FR-19**: MCP server (remember, recall, reflect, gc, list_conflicts, resolve_conflict)
- MCP contract tests (§12.2)

### Milestone F: Enterprise + Polish → v1.0
- **FR-14**: Encryption at rest for SECRET atoms
- **FR-15**: Read audit logging
- **FR-16**: Memory Packet import/export (Letta, LangGraph, Mem0)
- Performance benchmarks (§12.5)
- Benchmark harness (§12.4) — report-only
