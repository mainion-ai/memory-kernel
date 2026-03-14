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
| `test/fts.test.ts` | Dedicated FTS5: `searchFts()` ranking, BM25, Porter stemming, injection safety, reindex rebuilds FTS, task-aware recall ordering |
| `test/episodes.test.ts` | Dedicated episodes: `writeEpisode`, `readEpisode`, `listEpisodes`, `linkEpisodeToAtom`, recall with `include_episodes`, episodes excluded from `listAtoms` |
| `test/merge.test.ts` | Multi-agent event-log union merge: dry-run, conflict detection, idempotency, event deduplication |
| `test/mcp.test.ts` | MCP contract tests for all 8 tools (handlers called directly, no transport needed) |
| `test/mcp-resources.test.ts` | MCP contract tests for all 4 resources (URI, mimeType, placeholder vs real content) |
| `test/crypto.test.ts` | AES-256-GCM encryption: encrypt/decrypt SECRET atoms, key derivation (PBKDF2), `isEncrypted()`, event snapshot encryption |
| `test/retain-encrypted.test.ts` | Integration: createAtom/updateAtom/archiveAtom with `MEMORY_ENCRYPTION_KEY` set — verifies SECRET atoms are encrypted on disk and decrypted on read |
| `test/recall-audit.test.ts` | Read audit logging: `atom_read` events emitted on recall with `agent_id`/`session_id`, correct `meta.atoms_returned` and `meta.token_estimate` |
| `test/import.test.ts` | `importFromFile()`, `previewImport()`, `extractChunks()`: heading extraction, type/confidence inference, dry-run mode |
| `test/compaction-loss.test.ts` | 13 PR-gate torture tests: section survival (Numbers, Conditional Logic, Rationale, Cross-links, Open Questions), multi-cycle stability, replay determinism, reflect idempotence, recall correctness |
| `test/stress.test.ts` | Edge cases, error paths, and invariants across all subsystems |

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

### `recall()` — takes two separate arguments, NOT a single object

```typescript
// WRONG — memoryDir is not inside RecallQuery
recall({ memoryDir: dir, task: 'pagination' });

// CORRECT
recall(dir, { task: 'pagination' });
// signature: recall(memoryDir: string, query: RecallQuery = {})
```

### `searchFts()` — FTS5 phrase queries require adjacency

`searchFts()` wraps the query in a quoted phrase (`"..."`) which requires all tokens to appear in
exact sequence in the document. For multi-word queries, prefer single distinctive keywords:

```typescript
// Multi-word phrase "pagination api" fails if words aren't adjacent in body text
searchFts(dir, 'pagination api');  // may return [] if not adjacent

// Single keyword is safer and uses stemming (paginat* matches pagination/paginate)
searchFts(dir, 'pagination');  // returns all atoms containing any form of "pagination"
```

### `writeEpisode()` — session ID is sanitised to kebab-case; accepts opts

Episode IDs are `EP-{sanitised-session-id}`. The sanitisation lowercases and replaces
non-alphanumeric characters with hyphens. Full signature:

```typescript
writeEpisode(dir, 'My Session 2026/03', 'Summary.');
// → 'EP-my-session-2026-03'

// With opts (tags, started_at, agent_id) and operationOpts:
writeEpisode(dir, 'sess-001', 'Summary.', { tags: ['auth'], agent_id: 'claude' });
writeEpisode(dir, 'sess-001', 'Summary.', { tags: ['auth'] }, { agent_id: 'claude' });
// agent_id may appear in either opts (4th) or operationOpts (5th); operationOpts takes precedence.
```

`writeEpisode` also emits a `session_ended` event to the event log with `meta.episode_id`.

### `searchFts()` — atom IDs use uppercase slug segments

Atom IDs have the format `TYPE-YYYY-MM-DD-SLUG-suffix` where SLUG is uppercase.
Use case-insensitive comparison when matching atom IDs from FTS results:

```typescript
// Atom created with slug 'pagination' gets ID like 'DECI-2026-03-11-PAGINATION-abc12'
const results = searchFts(dir, 'pagination');
expect(results![0].atom_id.toLowerCase()).toContain('pagination');  // correct
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

## PRD v1.2 — Implementation Status (as of v1.0.0)

Reference PRD: `memory-kernel-prd-v1.2.md` (2026-03-10).

### What's DONE ✅

| PRD Requirement | Implementation |
|---|---|
| **v0.1 MVP** (§6.1) — all 6 items | Directory layout, checkpoint, context loader, TTL/promotion/GC, CLI (14 cmds), SDK |
| **FR-1** Evidence Store | `src/evidence.ts` — SHA-256 content-addressed, atomic writes, dedup by hash |
| **FR-2** Event Log | `src/event-log.ts` — NDJSON, V2 snapshots, fsync, compaction |
| **FR-2a** Episode Store | `src/episodes.ts` — writeEpisode, readEpisode, listEpisodes, linkEpisodeToAtom; CLI: mk episode/mk episodes |
| **FR-3** State Views | `src/renderers.ts` — INDEX, HANDOFF, DECISIONS, CONSTRAINTS, OPEN_QUESTIONS (line budgets enforced) |
| **FR-4** Retain | `src/retain.ts` — createAtom, updateAtom, archiveAtom (all emit V2 events, auto-index) |
| **FR-5** Task-aware recall | `src/recall.ts` + `src/index-db.ts` — FTS5 BM25 ranking on `query.task`; `--task` and `--include-episodes` in CLI |
| **FR-6** Reflect (deterministic) | `src/reflect.ts` — expiry, dedup, autoPromote, conflict detection heuristic, view regeneration |
| **FR-7** All 9 atom types | `src/types.ts` — decision, constraint, open_question, belief, fact, procedure, entity_summary, preference, conflict |
| **FR-13** Data classification | PUBLIC, TEAM, PERSONAL, SECRET — enforced in recall filter + SQLite index query |
| Atomic writes + crash safety | tmp → fsync → rename in store.ts + evidence.ts; WAL mode in SQLite |
| Deterministic replay | `src/replay.ts` — same events → identical atoms + views |
| Event sourcing (§11.1) | V2 events with inline snapshots |
| Canonicalization (§11.3) | Sorted YAML keys, UTC ISO8601, stable headings |
| Progressive disclosure (§11.6) | INDEX ≤ 200 lines, HANDOFF ≤ 80 lines |
| Recall gating (§11.9) | PERSONAL + SECRET excluded by default |
| SQLite FTS5 index (§11.5) | Schema v3: FTS5 virtual table with porter unicode61 tokenizer; BM25 ranking via `searchFts()` |
| **FR-11** Convergent merges (event-log union) | `src/merge.ts` — `mergeEventLogs()` Pattern B; `mk merge` CLI; conflict atoms for concurrent updates |
| **FR-19** MCP server | `src/mcp/` — 8 tools + 4 resources; `resolveConflict()` kernel function; `mk-mcp` bin; contract tests in `test/mcp.test.ts` and `test/mcp-resources.test.ts` |

### What's PARTIAL ⚠️

| Area | What exists | What's missing |
|---|---|---|
| **FR-6 Reflect — conflicts** | Heuristic: same-type active atoms with overlapping scope and confidence gap > 0.3 | Full MV-Register semantics, user-triggered resolution workflow (future milestone) |
| **FR-8 TTL + decay** | Hard TTL expiry works | No gradual confidence decay |
| **FR-9 Promotion** | confidence ≥ 0.9 auto-promote | No corroboration, user confirmation, or evidence triggers |
| **FR-15 Audit** | `atom_read` event emitted by `recall()` when `agent_id`/`session_id` provided (v0.9.0); includes `atom_refs`, `meta.query_task`, `meta.atoms_returned`, `meta.token_estimate` | Passive recall (no agent_id) is not audited — by design |
| **Provenance** | Fields exist on AtomFrontmatter (`provenance.episodes`, `provenance.evidence`). Accepted in createAtom/updateAtom. | Not auto-populated by system (caller must pass explicitly) |

### What's NOT Started ❌

| Area | PRD Section |
|---|---|
| **FR-10** Concurrent writers (advisory locks) | §7.5 |
| **FR-12** Conflict resolution workflow | §7.5 |
| ~~**FR-14** Encryption at rest (SECRET)~~ | ~~§7.6~~ — **Done in v0.9.0** |
| ~~**FR-16** Memory Packet import/export~~ | ~~§7.7~~ — **`mk import` done in v0.9.0** (Letta/LangGraph/Mem0 adapters deferred) |
| ~~**FR-19** MCP server~~ | ~~§7.8~~ — **Done in v0.8.0** |
| ~~Benchmark harness~~ | ~~§12.4~~ — **Done in v1.0.0** (`scripts/bench.ts`, compaction-loss torture tests) |
| ~~Performance benchmarks (p95)~~ | ~~§12.5~~ — **Done in v1.0.0** (p95 ≈ 3ms, target < 50ms ✓) |
| System/E2E tests (multi-process) | §12.3 — deferred |

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

All major Milestone D stubs have been implemented. Remaining stubs for future milestones:

| Stub | Location | Notes |
|---|---|---|
| `provenance.episodes` | `src/types.ts` | Field on AtomFrontmatter. Accepted by createAtom/updateAtom. NOT auto-populated — callers must pass explicitly or use `linkEpisodeToAtom()`. |
| `provenance.evidence` | `src/types.ts` | Field on AtomFrontmatter. Accepted but not auto-populated. Caller must pass evidence hashes. |
| `conflicts` (full CRDT) | `src/reflect.ts` | Heuristic only: same-type active atoms + overlapping scope + confidence gap >0.3. Full MV-Register semantics and user-triggered resolution workflow are future milestones. |
| Letta/LangGraph/Mem0 adapters | future | `mk import` handles generic markdown; provider-specific adapters deferred. |

---

## Milestone Roadmap (PRD v1.2)

### Milestone C: Task-Aware Recall + Episodes → v0.6.0 ✅ COMPLETE
- **FR-2a**: Episode Store — `writeEpisode`, `readEpisode`, `listEpisodes`, `linkEpisodeToAtom` ✅
- **FR-5**: FTS5 index (schema v3) + task-aware BM25 ranking in `recall()` ✅
- **§11.6a**: Episode-aware recall (`include_episodes`, keyword match) ✅
- Conflict detection heuristic in `reflect.ts` ✅
- Tests: dedicated `test/fts.test.ts` (FTS5 search, task-aware recall) and `test/episodes.test.ts` (episode store) suites; `test/stress.test.ts` edge-cases ✅
- CLI: `mk episode`, `mk episodes`, recall `--task`, `--include-episodes` ✅
- Total test count: **434 passing** across 13 test files

### Milestone D: Multi-Agent Merge → v0.7.0 ✅ COMPLETE
- **FR-11**: Event-log union + deterministic reducer (§11.7 Pattern B) ✅
- `mk merge` CLI + `mergeEventLogs()` SDK ✅
- Conflict atoms created for concurrent updates (same atom mutated in local-only and remote-only event sets) ✅
- `merge_completed` event emitted on successful merge ✅
- Total test count: **448 passing** across 14 test files

> Note: FR-10 advisory locks and multi-process E2E tests (§12.3) deferred to a later milestone.

### Milestone E: MCP Server → v0.8.0 ✅ COMPLETE
- **FR-19**: MCP server (`src/mcp/`) — 8 tools + 4 resources via StdioServerTransport ✅
- `resolveConflict()` kernel function in `src/retain.ts`; exported from `src/index.ts` ✅
- `mk-mcp` bin entry + `mcp` dev script ✅
- Contract tests: `test/mcp.test.ts` (19 tests) + `test/mcp-resources.test.ts` (9 tests) ✅
- Total test count: **476 passing** across 16 test files

### Milestone F: Enterprise + Polish → v0.9.0 ✅ COMPLETE
- **FR-14**: AES-256-GCM encryption for SECRET atoms (`src/crypto.ts`, `MEMORY_ENCRYPTION_KEY`) ✅
- **FR-15**: Read audit logging (`atom_read` event when `agent_id`/`session_id` provided) ✅
- **FR-16**: `mk import` / `importFromFile()` — markdown → typed atoms with type/confidence inference ✅
- `test/crypto.test.ts`, `test/import.test.ts` added ✅
- Total test count: **531 passing** across 20 test files

### Milestone G: v1.0 Final Release → v1.0.0 ✅ COMPLETE
- **§12.4** Compaction-loss PR gates: 13 torture tests in `test/compaction-loss.test.ts` ✅
- **§5.2 / §12.4** Benchmark harness: `scripts/bench.ts` + `scripts/bench-baseline.json` (p95 ≈ 3ms ✓) ✅
- README Performance + Troubleshooting sections ✅
- `package.json` version → `1.0.0` ✅
- Total test count: **551 passing** across 21 test files
