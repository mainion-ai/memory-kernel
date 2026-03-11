# Changelog

All notable changes to this project will be documented in this file.

## [0.6.0] — 2026-03-11

### Added
- **FTS5 full-text search** (`searchFts`) — BM25 ranked search over atom bodies via SQLite FTS5 virtual table with Porter stemmer. Returns `null` when index absent; empty array for no matches. Special-char queries sanitized to prevent FTS5 syntax errors. Schema version bumped to 3 (auto-rebuild on open).
- **Task-aware recall** — `recall(memoryDir, { task })` uses `searchFts` to re-rank atoms by BM25 relevance when a task string is provided. Falls back gracefully when index is absent; empty task string is a no-op.
- **Episode store** (`src/episodes.ts`) — per-session markdown summary artifacts in `EPISODES/`. `writeEpisode`, `readEpisode`, `listEpisodes`, `linkEpisodeToAtom` APIs. Session IDs sanitized to kebab-case; last-write-wins for duplicate IDs.
- **Conflict detection heuristic** in `reflect()` — detects active fact/decision atom pairs with overlapping scope paths and confidence diff > 0.3. Creates a conflict atom in `CONFLICTS/` per pair. Idempotent: re-running reflect does not duplicate conflict atoms. Returns total active conflict atom count.

### Tests
- **Stress test suite extended** with 16 edge-case tests covering the four new Milestone C features (Blocks 15–18 in `test/stress.test.ts`):
  - Block 15 (FTS5 edge cases): null before reindex, empty results vs null, special chars, reindex idempotency.
  - Block 16 (Task-aware recall): deterministic ordering, graceful fallback without index, empty task no-crash.
  - Block 17 (Episode store): session ID sanitization, last-write-wins, `limit: 0`, link to archived atom, null for missing ID.
  - Block 18 (Conflict heuristic): pair above threshold creates conflict atom, pair below threshold no conflict, reflect idempotency.
- Total: **398 tests passing** (up from 382).

## [0.5.1] — 2026-03-11

### Tests
- **Stress test suite** (`test/stress.test.ts`) — 54 new tests across 14 describe blocks probing edge cases, error paths, and invariants not covered by the existing suite.
  - Path traversal: `updateAtom`, `archiveAtom`, `replayFromFile` with crafted paths.
  - Extreme inputs: Unicode slugs, 1000-char slugs, empty slugs, 256 KB bodies, YAML-like content in body, special characters (`\t`, `\\`, `"`).
  - Dedup edge cases: identical bodies, interleaved dups/unique, cross-type no-dedup, whitespace-only diff deduplication.
  - TTL/expiry: `ttl_days=0`, `ttl_days=null` persistence, no double-expiry on second reflect.
  - Auto-promotion boundary: confidence ≥ 0.9 promoted, 0.899 not promoted, accepted beliefs not re-promoted.
  - Compact + replay invariant: state preserved after compact, double-compact removes 0, non-mutation events preserved.
  - Event log corruption: binary noise mid-log, truncated JSON, all-whitespace log, duplicate event IDs.
  - Index/file divergence: stale index gracefully skipped in recall, empty-dir reindex, LIMIT enforcement, negative LIMIT no-crash.
  - `archiveAtom` idempotency: double-archive no crash, `updateAtom` on archive path works.
  - `updateAtom` no-op: empty updates don't rewrite file; body update does.
  - Recall edge cases: SECRET/PERSONAL exclusion, `max_tokens=1`, path boundary (no prefix false positives), prefix match.
  - Special atom types: conflict atoms in `CONFLICTS/`, conflict detection in reflect, empty scope arrays.
  - Replay edge cases: empty event list, V1 archive event, non-existent file, full create→update→update lifecycle.
  - Large-scale performance: 500 atoms reflect < 15 s, 50 × create→update→archive lifecycle.
- **Replay snapshot validation** — `replay()` / `replayFromFile()` now validate atom snapshots against `AtomFrontmatterSchema` at replay time. Events with invalid `type`, `status`, or out-of-range `confidence` are reported in `errors` and excluded from the reconstructed atom map (not silently accepted). The stress test asserts this validated behavior.
- Total: **383 tests passing** (up from 329).

## [0.5.0] — 2026-03-10

### Security
- **Path traversal guard in `updateAtom`** — `assertWithinDir` now validates `filePath` before any file operations, matching `archiveAtom`.
- **Path traversal guard in `replayFromFile`** — crafted atom IDs containing `../` in event logs can no longer write files outside the output directory.
- **Path traversal guards in `reflect`** — `processExpiry`, `dedup`, and `archiveAtom` archive paths are now validated with `assertWithinDir`.
- **Markdown injection defense** — renderer output sanitizes atom IDs and body text to prevent format injection from crafted content. New `sanitizeId()` escapes `[]()*~|` in bold/strikethrough contexts.
- **SQL LIKE injection fix** — replaced unescaped column-as-LIKE-pattern in `queryIndex` reverse path match with `INSTR`-based check.

### Fixed
- **`reflect()` index sync** — expiry, dedup, and promotion now update the SQLite index inline (previously required manual `reindex` after reflect).
- **`reflect()` events_emitted undercount** — now correctly counts all per-atom events (expired + deduped + promoted + 1 for reflect_completed).
- **`reflect()` dedup shared reference hazard** — clones atoms before mutation to prevent corruption when 3+ duplicates exist.
- **`recall()` pathOverlaps false positives** — fixed string prefix match to require path separator boundary (`src/comp` no longer matches `src/components`).
- **`recall()` token budget ignores base view cost** — `applyTokenBudget` now subtracts base view tokens before allocating atom budget.
- **`updateAtom` field clearing** — `scope`, `links`, `provenance` can now be cleared by passing `undefined` (uses `'field' in opts.updates` checks).
- **`updateAtom` status guard** — changed from truthy check to `!== undefined` for consistency with other optional field updates.
- **`bootstrap` backup pollution** — backup files are no longer created on no-op runs (when all atoms are already imported).
- **`bootstrap` events_written semantics** — returns 0 when nothing was written (previously returned misleading counts).
- **`countEvents` / `readEvents` divergence** — `countEvents` now parses JSON to skip malformed lines, matching `readEvents` semantics exactly.
- **`normalizeTimestamp` invalid input** — throws a meaningful error instead of uncaught `RangeError` on invalid date strings.
- **`renderOpenQuestions` rejected questions** — rejected questions are now displayed in their own section instead of being silently dropped.
- **`checkpoint` CLI error surfacing** — `result.error` from reflect failures is now printed as a warning to stderr.
- **`schema.ts` ttl_days validation** — changed `.positive()` to `.min(0)` to allow ephemeral atoms with `ttl_days: 0`.
- **`schema.ts` separate ID counters** — atom and event ID generators now use independent counters with random nonces to prevent interleaving.
- **`schema.ts` DEFAULT_TTLS typing** — typed as `Record<AtomType, number | null>` instead of `Record<string, ...>`.
- **CLI directory guards** — `recall`, `reflect`, `gc` commands now check for directory existence before operating.
- **`package.json` version** — corrected from `0.1.1` to `0.5.0`.

### Added
- **Log compaction** (`compactLog`) — removes intermediate mutation events, keeping only the latest per atom plus all non-mutation events. Creates timestamped backup before writing. Available via `mk compact` CLI command.
- **SQLite connection caching** — `openIndex` reuses cached connections keyed by resolved directory. DDL only runs on first open. New `closeIndex(memoryDir)` and `closeAllIndexes()` for explicit cleanup.
- **SQLite schema versioning** — `PRAGMA user_version` tracks index schema version. Stale databases from older versions are auto-rebuilt on open.
- **`queryIndex` LIMIT support** — optional `limit` parameter caps result set size.
- **`CompactResult` type** — exported from public API.
- **`autoPromote` ID documentation** — clarified that promoted atoms intentionally retain their original `BELI-` prefix as an immutable origin identifier.

### Changed
- **`reflect()` single-pass optimization** — reads atoms from disk once and filters the in-memory list between phases, reducing from 5× to 1× filesystem scan. Views still re-read for accuracy.
- **Tmp file naming strengthened** — `writeFileAtomic` and `writeEvidence` now use monotonic counter + random nonce in addition to PID, preventing collision across concurrent writes.
- **`bootstrapEvents` idempotency** — checks for existing `atom_imported` events before importing, skipping duplicates and reporting `skipped` count.

### Tests
- 329 tests passing (up from 282).
- Sprint 1: index sync in reflect, path traversal guards, bootstrap idempotency, checkpoint error handling, ttl_days=0, events_emitted count, PERSONAL exclusion.
- Sprint 2: pathOverlaps boundary, token budget, dedup clone with 3 duplicates, field clearing, normalizeTimestamp validation, markdown sanitization, countEvents consistency, rejected questions rendering.
- Sprint 3: log compaction (5 tests), connection caching + LIMIT (4 tests), reflect single-pass + review gaps (4 tests), countEvents/readEvents consistency (2 tests).

## [0.4.0] — 2026-03-10

### Added
- **Event Log V2** — mutation events (`atom_created`, `atom_updated`, `atom_archived`, `atom_promoted`, `atom_expired`, `atom_imported`) now carry `schema_version: 2` with an inline `atom_snapshot` (serialized frontmatter+body). Backward compatible: V1 events still parse.
- **Evidence Store** (`src/evidence.ts`) — content-addressed blob store using SHA-256 hashes. Functions: `hashEvidence`, `writeEvidence`, `readEvidence`, `evidenceExists`, `listEvidence`, `assertValidHash`. Atomic writes, idempotent, path-traversal safe.
- **Replay Engine** (`src/replay.ts`) — deterministic state reconstruction from events. `replay(events)` folds mutation events into an atom map and generates all 5 views. `replayFromFile(path, { outputDir })` reads NDJSON and optionally writes atoms + views to disk.
- **Bootstrap Migration** (`src/bootstrap.ts`) — `bootstrapEvents({ memoryDir, agent_id, session_id })` reads existing atoms, generates `atom_imported` V2 events, backs up `events.ndjson`, and prepends import events to the log.
- **`mk bootstrap-events` CLI** — `mk bootstrap-events -d <dir> [--agent-id] [--session-id]`. Migrates pre-V2 memory to full event-sourced state.
- **`mk replay` CLI** — `mk replay --from <file> [--output-dir dir] [--evidence-dir dir]`. Reconstructs atoms and views from an event log.
- **`MUTATION_ACTIONS` constant** and `isMutationAction()` helper exported from schema.
- **`ReplayResult` and `BootstrapResult` types** exported from public API.

### Changed
- **Retain emits V2 events** — `createAtom`, `updateAtom`, `archiveAtom` all include `schema_version: 2` and `atom_snapshot` in their events.
- **Reflect emits V2 events** — `processExpiry`, `dedup`, and `autoPromote` now include snapshots. Dedup also emits `atom_archived` events (previously silent).

### Tests
- 282 tests passing (up from 193).
- `test/evidence.test.ts` — 29 tests (hash, idempotency, round-trip, binary, large buffer, path traversal, listing).
- `test/schema-v2.test.ts` — 13 tests (V1 compat, V2 acceptance, mutation actions).
- `test/replay.test.ts` — 25 tests (empty, create, update, archive, lifecycle, views, determinism, V1 fallback, evidence, large stream, replayFromFile).
- `test/bootstrap.test.ts` — 11 tests (empty, import, backup, sorting, timestamps, refs, round-trip).
- `test/milestone-b.test.ts` — 11 integration tests (full lifecycle, views parity, evidence round-trip, bootstrap+modify+replay, determinism, regression).

## [0.3.0] — 2026-03-10

### Added
- **View regeneration parity** — `reflect()` now auto-regenerates all 5 views: INDEX.md, DECISIONS.md, CONSTRAINTS.md, OPEN_QUESTIONS.md, HANDOFF.md (previously only INDEX.md).
- **`src/renderers.ts`** — 5 pure renderer functions (`renderIndex`, `renderDecisions`, `renderConstraints`, `renderOpenQuestions`, `renderHandoff`) with no filesystem I/O. Exported via public API.
- **`ViewBudget` type** — configurable `maxLines` per view with truncation indicator.
- **`checkpoint()` API** — generates a handoff bundle: runs reflect, recalls scoped atoms, assembles markdown, emits `checkpoint_created` event. Exported via public API.
- **`mk checkpoint` CLI command** — `mk checkpoint -d <dir> [--task "..."] [--max-tokens N] [--no-reflect]`. Markdown to stdout, metadata to stderr (Unix-composable).

### Changed
- **`regenerateViews()` refactored** — replaced 60 lines of inline INDEX.md rendering in `reflect.ts` with calls to pure renderers.
- **HANDOFF.md is now data-driven** — shows status summary, recent events (last session), active conflicts, top 5 decisions, and open questions.

### Tests
- 193 tests passing (up from 152).
- `test/renderers.test.ts` — 32 pure renderer tests (determinism, grouping, budget enforcement, empty state, frontmatter validation).
- `test/checkpoint.test.ts` — 8 integration tests (empty memory, atom inclusion, event emission, skipReflect, token budget, task passthrough).
- Kernel integration test verifying all 5 views are regenerated by reflect().

## [0.2.0] — 2026-03-10

### Security
- **Path traversal protection** — `readView`, `writeView`, and `archiveAtom` now validate that resolved paths stay within `memoryDir`. Prevents arbitrary file read/write/delete via crafted `viewName` or `filePath`.

### Fixed
- **Atomic writes leave no orphan temp files** — `writeFileAtomic` cleans up the `.tmp` file if `renameSync` fails after `closeSync`.
- **Corrupted event log no longer crashes reads** — `readEvents` skips malformed JSON lines instead of throwing on the entire log.
- **`parseAtom` validates required fields** — missing `id`, `type`, or `status` in frontmatter now throws a clear error instead of producing a broken `Atom` that crashes downstream.
- **Belief promotion renames file** — when `reflect` promotes a belief to a fact, the file is renamed from `BELI-*.md` to `FACT-*.md` to match the new type.
- **Reflect re-reads atoms between phases** — `processExpiry`, `dedup`, and `autoPromote` no longer share a stale in-memory list; each phase works on current disk state.
- **SQLite busy timeout** — `openIndex` sets `busy_timeout = 5000` so concurrent processes don't get `SQLITE_BUSY` immediately.
- **Unique atom IDs** — `generateAtomId` appends a random counter suffix (`TYPE-DATE-SLUG-xxxx`) to prevent collisions when two atoms share the same type, slug, and date.
- **Unique event IDs** — `generateEventId` includes `process.pid` to avoid collisions across concurrent processes.
- **`listAtoms` is resilient** — a single corrupted atom file no longer aborts the entire listing; bad files are skipped with a warning.
- **Index auto-sync on retain** — `createAtom`, `updateAtom`, and `archiveAtom` now update the SQLite index automatically (no manual `reindex` needed after writes).
- **PERSONAL classification excluded from recall** — both `PERSONAL` and `SECRET` atoms are now excluded from default recall queries, matching the PRD.
- **LIKE wildcard injection** — path queries in `queryIndex` now escape `%` and `_` characters to prevent unintended SQL LIKE pattern matching.
- **`updateAtom` with empty updates** — no-op calls (empty `updates` and no `body`) now return early without rewriting the file or emitting a spurious event.
- **`render-claude-md.ts` crash** — replaced `fs.realpathSync` with `path.dirname(path.resolve(...))` to avoid `ENOENT` when the output directory doesn't exist.
- **Zod default mismatch** — removed the `default('TEAM')` from the `classification` schema field since `parseAtom` doesn't run Zod transforms, making the runtime value consistent.

### Changed
- **CLI version is dynamic** — `mk --version` now reads from `package.json` instead of a hardcoded string.
- **`mk gc` shows full results** — previously hid dedup/promotion counts; now shows all reflect output.

### Added
- `tsconfig.test.json` — separate TypeScript config that includes test files for type-checking (`npm run lint:all`).
- `lint:all` script in `package.json` — runs `tsc --noEmit` against both `src/` and `test/` files.

### Documentation
- Fixed `updateAtom` and `recall` signatures in SDK Usage section to match actual API.
- Fixed Reflect operations box to show correct order and descriptions.
- Updated atom ID examples to show counter suffix format.
- Fixed query flow diagram to use correct `recall(dir, { types, tags })` signature.
- Added note about PERSONAL/SECRET exclusion in Recall box.
- Added note about index auto-sync in Retain box.
- Documented flat directory layout (no recursive scan) in `listAtomFiles` JSDoc.
- Documented `detectConflicts` as a v0.1 stub counting existing conflict atoms.
- Documented that only `INDEX.md` is auto-regenerated by reflect (other views are manual).
- Marked `task` and `include_episodes` fields as `@todo v0.2` in `RecallQuery` type.

### Tests
- Fixed vacuous assertions in corruption tests to verify specific expected behavior.
- Renamed misleading "concurrent writes" test to "sequential writes".
- Updated all atom ID regex expectations to match new counter suffix format.
- 152 tests passing.

## [0.1.1] — 2026-03-09

### Changed
- Updated README with full documentation.

## [0.1.0] — 2026-03-09

### Added
- Initial release.
- Core operations: retain, recall, reflect.
- CLI tool (`mk`) with init, status, recall, reflect, gc, doctor, reindex, remember commands.
- SQLite index for fast queries.
- Atom types: fact, decision, constraint, belief, preference, open_question, procedure, entity_summary, conflict.
- NDJSON append-only event log.
- `activate-memory` script for bootstrapping memory from CLAUDE.md.
- `render-claude-md.ts` script for NanoClaw integration.
- 124 tests.
