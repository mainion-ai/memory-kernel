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
| `test/recall-temporal-decay.test.ts` | `temporalDecay()` unit tests; no-task recency sort; `decay_weight=0` fallback; status-priority ordering |
| `test/recall-decay.test.ts` | Integration: decay ranking with `decay_half_life`/`decay_weight` query overrides |
| `test/recall-scoring.test.ts` | Type-weight multipliers; confidence floor; token reservation two-pass; MCP schema coverage |
| `test/relations.test.ts` | DDL creation; `indexAtom` edge sync; `getRelationsForAtom`; graph-walk boost in recall |
| `test/migrate-relations.test.ts` | `links.related` migration; body-text atom ID mining; dry-run; idempotency |
| `test/isolation.test.ts` | Per-agent isolation: config loading, resolveAgentDir, initAgentStore, listAgents, render config |
| `test/isolation-recall.test.ts` | Union recall: agent + shared merge, agent-wins dedup, token budget, episodes |
| `test/isolation-render.test.ts` | Per-agent render: type_weights, include_shared, renderAgentClaudeMd |
| `test/isolation-wander.test.ts` | Wander graph scoping: agent-only, shared participation, cross-agent invisibility |
| `test/isolation-migrate.test.ts` | Migration strategies: fresh, partition, clone-to-shared, idempotency guard |
| `test/share.test.ts` | Share/unshare: copy to shared, unshare removal, listSharedAtoms, error cases |
| `test/mcp-isolation.test.ts` | MCP isolation: tool routing to agent stores, share/unshare tools, shared-mode rejection |
| `test/openclaw-plugin.test.ts` | OpenClaw plugin: tools (remember/recall/reflect/bundle/status), hooks (bootstrap/compact/session-end), config parsing, SecretRef resolution |
| `test/openclaw-plugin-isolation.test.ts` | OpenClaw plugin isolation: config parsing, effective context resolution, tool routing to agent stores, hook routing, cross-agent isolation, backward compatibility |

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

### `searchFts()` — implicit-AND over tokens with stemming

`searchFts()` sanitises FTS5 operators (`" * ( ) ^ : -` and the `NEAR` keyword) out of the input
and issues an implicit-AND query over the remaining tokens. Each token must appear in the document
in any order, and FTS5 stemming still applies (so `paginat*` matches `pagination`/`paginate`):

```typescript
// Multi-word query — both tokens must appear (any order), stemming still works
searchFts(dir, 'pagination api');  // matches atoms containing both words

// Single keyword — same semantics, just one token
searchFts(dir, 'pagination');  // matches any form of "pagination"
```

Callers should still pass parameterised input; the sanitiser prevents FTS5 syntax errors, not SQL
injection (the SQLite prepared statement is the injection guard).

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

### `RecallQuery` scoring params — query overrides env var (v1.4.0+)

`decay_half_life`, `decay_weight`, `type_weights`, `type_reservations` follow the pattern: query param beats env var beats default. `graph_boost` is tri-state: `true` forces on, `false` forces off, `undefined` follows `RECALL_GRAPH_BOOST` env var.

```typescript
// Force graph boost even when RECALL_GRAPH_BOOST=false is set in env
recall(dir, { task: 'auth', graph_boost: true });

// Zero decay weight = pure relevance ranking, no recency bias
recall(dir, { task: 'auth', decay_weight: 0 });

// Per-call type boosts: triple weight for constraints
recall(dir, { task: 'deploy', type_weights: { constraint: 4.5 } });
```

### `openIndex()` required before `indexAtom()` in tests with relations

`indexAtom()` calls `indexExists()` and no-ops when no index file exists. Tests that create atoms and then assert on relations must call `openIndex(testDir)` in `beforeEach`:

```typescript
beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-test-'));
  initMemoryDir(testDir);
  openIndex(testDir);  // required for indexAtom to actually index
});
```

### `ttl_days >= 1` required (#108)

The schema uses `.min(1).nullable()`. Use `null` to mean "no expiry" and a positive integer (>= 1) for day-based TTLs. Zero was previously accepted but is now rejected (it meant "expire on next reflect" — replace with explicit deletion/archive).

---

## Deduplication rules

- Dedup key: `${type}::${body.trim()}` — same type + trimmed body = duplicate.
- Cross-type identical bodies are **not** deduped.
- `body.trim()` is used — leading/trailing whitespace-only differences dedup.
- The **newer** atom (later `created_at`) is kept; older ones are archived.

---

## Auto-promotion (tiered, status-only — #274 Gap 2)

`autoPromote` (`src/reflect.ts`) graduates `status === 'draft'` atoms to `status === 'active'`. It is **status-only** — the atom's *type* never changes (the old `belief → fact` rewrite was retired). Tiered by type:

- **`open_question`** — promoted immediately (additive, no quality risk).
- **`fact` / `preference` / `decision`** (`AGE_GATED_PROMOTE_TYPES`) — promoted only when **all** hold: age ≥ `DRAFT_PROMOTE_AGE_MS` (48h), `confidence >= DRAFT_PROMOTE_MIN_CONFIDENCE` (0.7), and `!draftContradictsActive` (no same-type/scope active atom with a confidence gap > `CONFLICT_CONFIDENCE_GAP` = 0.3).
- **`belief` / `procedure` / everything else** — held in `draft` for review (beliefs over-produce + drift on re-extraction; procedures must not auto-activate without an executed-once signal).

On promotion the `auto-extracted` tag is stripped and an `atom_promoted` event is emitted with `meta: { from_status, to_status, type }`.

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

## Documentation hygiene — required on every PR

Stale documentation is treated as a regression. Before opening any PR, sweep the .md files whose state your change affects and update them in the same commit:

| .md file | When to update |
|---|---|
| `CHANGELOG.md` | Every user-visible code change — add an entry under `[Unreleased]` or the next version section |
| `CLAUDE.md` | When status (last shipped version, open issues, active phase), workflow conventions, or directory layout change |
| `README.md` | When public API, CLI usage, or onboarding flow changes |
| `RELEASING.md` | When versioning convention, tag flow, or publish path changes |
| `test/README.md` | When test count, harness layout, or run instructions change |
| `docs/superpowers/plans/<PR>.md` | Author a new per-PR plan at PR-start for non-trivial PRs (see existing exemplars in `archive/`) |
| `docs/superpowers/plans/archive/` | `git mv` completed per-PR plans here once their work ships — see the archive README for the convention |
| `packages/openclaw-memory-kernel/INSTALL.md` | When subpackage install path, compat matrix (subpackage × `memory-kernel` × `openclaw` × `@sinclair/typebox` × Node), or deprecation policy changes |
| `packages/openclaw-memory-kernel/CHANGELOG.md` | Every subpackage-affecting change (config field, exported hook, tool name, peer-dep constraint). Subpackage tracks its own SemVer — see [`RELEASING.md` → Subpackage releases](RELEASING.md#subpackage-releases) |
| `skills/mk-memory-setup/SKILL.md` + `skills/mk-doctor/SKILL.md` | When the agent-facing install / upgrade / diagnostic flow changes — these ship to consumers and shape every new install |
| `docs/v2-design/*.md` | **Do not edit.** These are point-in-time design rationale documents, not status reports. Updating them would corrupt the historical artifact. |
| `.github/ISSUE_TEMPLATE/*.md` + `.github/PULL_REQUEST_TEMPLATE.md` | When the bug-report / feature-request / PR-checklist fields change. Keep templates and `CONTRIBUTING.md` in sync — they share content by design |
| `.github/CODEOWNERS` | When maintainer ownership for a directory or file pattern changes — every change should be reviewable on its own |
| `SECURITY.md` | When the supported-version table, contact channel, response timeline, or disclosure window changes |
| `docs/decisions/*.md` | One ADR per significant architectural / governance decision. Numbered (`0001-`, `0002-`, …). New ADRs are append-only; superseding decisions get their own ADR that references the prior one |
| `docs/public-repo-settings.md` | When required public-repo GitHub settings change (branch protection, App carve-outs, GHA permissions, security toggles). This file is both operator checklist and audit snapshot — keep them aligned |
| `docs/governance.md` | When triage doctrine, contributor-licensing stance, or code-of-conduct reference changes |

Version numbers and test counts in any .md file must match `git log origin/main` and `npm test` output at PR-open time. If you find a doc that's stale but unrelated to your PR's scope, file a follow-up issue rather than expanding scope.

### Enforcement

The `docs-hygiene` workflow ([`.github/workflows/docs-hygiene.yml`](.github/workflows/docs-hygiene.yml)) enforces the strictest layer of this table at PR time: any PR that touches `src/**` or `packages/*/src/**` without also touching a `.md` file fails the check. Override via the `docs-hygiene-override` label when the change genuinely needs no doc update (e.g. internal refactor with no API change). Reviewer judgement is the gate on overrides — the label is visible in the PR timeline.

The audit at `docs/audit-vX.Y.Z.md` is the periodic deep pass; the workflow is the per-PR continuous-discipline gate.

### Migration-writing inspiration

When a user-facing migration is required, look at how **nanoclaw v1 → v2** framed its upgrade path: detect existing state, name the host-specific decision points, walk the user through the question-and-answer flow before mutating anything, and offer trade-off explanations in plain language. memory-kernel's `mk migrate` flow (added in v1.20.0) is the closest analogue; subsequent migrations should match that bar of clarity for the agent operating them.

When referencing GitHub issues in PR bodies, phrase the references defensively (`tracked in #N`, `noted in #N`) rather than aggressively (`blocked on #N`, `blocked by #N`). GitHub's PR-issue cross-reference logic can auto-close referenced issues on merge — this fired once on #152 (2026-05-21), causing a false close that had to be reopened by audit.
