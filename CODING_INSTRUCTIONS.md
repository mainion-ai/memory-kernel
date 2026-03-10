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
