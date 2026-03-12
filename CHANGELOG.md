# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0] — 2026-03-12

### Added
- **Compaction-loss test suite** (`test/compaction-loss.test.ts`) — 13 torture tests as PR gates per PRD §12.4.
  - **5 section-survival tests** — each of the five compaction-resistant body sections (Numbers, Conditional Logic, Rationale/Why, Cross-links, Open Questions) is asserted to survive one reflect cycle verbatim; Open Questions section also asserted across two successive reflect cycles.
  - **2 multi-cycle stability tests** — full rich-atom body asserted byte-identical after 5 reflect cycles; all 5 view files verified to contain expected section headings after 5 reflect cycles.
  - **2 replay-determinism tests** — `replayFromFile(path, { timestamp })` produces byte-identical views on back-to-back calls; compact-then-replay produces state-derived views identical to pre-compact replay (HANDOFF excluded: its Recent Activity section is event-history-based).
  - **2 reflect-idempotence tests** — `reflect(reflect(x))` body-stripped views equal `reflect(x)` views; second reflect on unchanged atoms produces zero promotions, deduplication, and expiry events.
  - **2 recall-correctness tests** — belief promoted to fact (confidence ≥ 0.9) is returned by `recall({ types: ['fact'] })`; atom IDs returned by `recall` are identical before and after `compactLog + reflect`.
- **Benchmark harness** (`scripts/bench.ts`) — reproducible performance report per PRD §5.2 / §8.
  - 100-atom workload; 50 recall iterations; single reflect and replay call.
  - Outputs JSON report to stdout: `recall` p50/p95/p99 (target: p95 < 50ms), `reflect` elapsed, `replay` elapsed with event count.
  - Warns to stderr when p95 target is exceeded.
  - `npm run bench` — print report; `npm run bench:baseline` — pin to `scripts/bench-baseline.json`.
- **Pinned baseline** (`scripts/bench-baseline.json`) — recorded on Node v20, darwin; recall p95 ≈ 2.97ms (target: 50ms).
- **README: Performance section** — latency table, `npm run bench` usage, note on SQLite index fallback, 500-atom stress test reference.
- **README: Troubleshooting section** — 6 entries covering `Cannot find module`, FTS null returns, encrypted-atom skip, reflect idempotence, recall-after-merge, and conflict-resolution workflow.

### Modified
- **`package.json`** — version `1.0.0`; added `bench` and `bench:baseline` npm scripts.

### Tests
- 551 tests passing across 21 files (up from 531 across 20 files).

## [0.9.0] — 2026-03-12

### Added
- **Encryption at rest for SECRET atoms** (`src/crypto.ts`) — AES-256-GCM using Node.js built-in `crypto`. No new npm dependencies. Encrypted file format: `MKENC:v1:<base64(12-byte IV)>:<base64(ciphertext + 16-byte auth tag)>`.
  - `MEMORY_ENCRYPTION_KEY` env var: 64-char hex (32 bytes direct) or passphrase (PBKDF2, salt=`memory-kernel-v1`, 100 000 iterations).
  - `isEncrypted()`, `encryptAtom()`, `decryptAtom()`, `resolveKey()` exported from `src/crypto.ts`.
  - `writeAtom()` in `src/store.ts` encrypts `classification === 'SECRET'` atoms when key is set.
  - `readAtom()` in `src/store.ts` auto-decrypts MKENC:v1 content; throws a clear error when key is absent.
  - `listAtoms()` skips encrypted atoms without key and emits a stderr warning.
  - `createAtom()` / `updateAtom()` / `archiveAtom()` / `resolveConflict()` in `src/retain.ts` encrypt `atom_snapshot` in the event log for SECRET atoms (via `snapshotAtom()` helper).
  - `replay()` in `src/replay.ts` decrypts encrypted snapshots before `parseAtom()`; gracefully pushes errors and continues when key is absent.
- **Read audit logging** — `recall()` now emits an `atom_read` event when `agent_id` and `session_id` are present in `RecallQuery`. Fully backward-compatible (no event when fields are absent).
  - `'atom_read'` added to `EVENT_ACTIONS` in `src/types.ts` and propagated to `MemoryEventSchema` automatically.
  - `agent_id?` and `session_id?` added to `RecallQuery` interface.
  - `handleRecall` and `handleGetContextBundle` in `src/mcp/tools.ts` pass agent/session ids through for audit.
- **`mk import` command** — imports a markdown file as memory atoms.
  - `src/import.ts` — `importFromFile(opts)`, `previewImport(filePath)`, `extractChunks(content)`. Extraction strategy: H2/H3 heading sections → bullet fallback → whole-file fallback. Chunks < 20 chars are skipped.
  - Type inference from keywords: `decision`, `constraint`, `open_question`, `belief`, `fact`.
  - Confidence inference from content signals: URL/inline-code → 0.9; uncertain language → 0.5; default prose → 0.75.
  - CLI: `mk import --from <file> [--dir <dir>] [--type <type>] [--classification <c>] [--agent-id <id>] [--session-id <id>] [--dry-run]`

### Modified
- **`src/index.ts`** — exports `importFromFile`, `previewImport`, `ImportFromFileOpts`, `ImportResult`.
- **`package.json`** — version `0.9.0`.

### Tests
- 531 tests passing (up from 476).
- `test/crypto.test.ts` — 17 unit tests: `isEncrypted`, `resolveKey` (hex / passphrase / undefined / deterministic), round-trip encrypt/decrypt, random IV, wrong key throws, tampered ciphertext throws, non-MKENC input throws, unicode/multi-line content.
- `test/retain-encrypted.test.ts` — 8 integration tests: SECRET atom file starts with `MKENC:v1:`, TEAM atom is plaintext, `readAtom` decrypts, event log snapshot encrypted for SECRET, TEAM snapshot plaintext, `listAtoms` returns both with key set, `readAtom` throws without key, `listAtoms` skips SECRET with warning when key absent.
- `test/recall-audit.test.ts` — 7 tests: `atom_read` emitted with correct fields when agent/session provided; NOT emitted when fields absent (multiple cases); separate events per call.
- `test/import.test.ts` — 17 tests: `extractChunks` unit tests (heading, bullet, plain, too-short), `previewImport` dry-run, `importFromFile` (atoms created, event log, bullet files, defaultType/defaultClassification overrides, TEAM default), type inference (decision/constraint/open_question/belief/fact), confidence inference (URL, code, uncertain).

## [0.8.0] — 2026-03-12

### Added
- **MCP server** (`src/mcp/server.ts`) — StdioServerTransport entry point; configured via `MEMORY_DIR` (required), `MCP_AGENT_ID`, and `MCP_SESSION_ID` environment variables. Exposed as the `mk-mcp` bin.
- **8 MCP tools** (`src/mcp/tools.ts`) — thin adapter over the existing kernel API. All tool outputs include a `provenance` block (`memoryDir`, `agent_id`, `session_id`, `executed_at`, optional `event_id` / `atom_refs`).
  - `remember` → `createAtom()`
  - `recall` → `recall()`
  - `reflect` → `reflect()`
  - `gc` → `reflect()` (GC-focused alias)
  - `merge` → `mergeEventLogs()` (validates `remote_dir` exists first)
  - `list_conflicts` → `queryIndex` / `listAtoms` filtered by `type === 'conflict'`
  - `resolve_conflict` → `resolveConflict()`
  - `get_context_bundle` → `checkpoint()`
- **4 MCP resources** (`src/mcp/resources.ts`) — read view files fresh per request, fall back to placeholder if not yet generated.
  - `memory://decisions` → `DECISIONS.md`
  - `memory://constraints` → `CONSTRAINTS.md`
  - `memory://handoff` → `HANDOFF.md`
  - `memory://open-questions` → `OPEN_QUESTIONS.md`
- **`resolveConflict()` kernel function** (`src/retain.ts`) — sets conflict atom status to `resolved`, archives it to `ARCHIVE/`, emits `conflict_resolved` V2 event, removes from SQLite index. Idempotent: already-archived atoms return early.
- **`McpContext` type** (`src/mcp/context.ts`) — shared context (`memoryDir`, `defaultAgentId`, `defaultSessionId`) threaded through all handlers; `resolveAgentId` / `resolveSessionId` helpers support per-call overrides.

### Modified
- **`src/index.ts`** — exports `resolveConflict`, `RetainOptions`, `ResolveConflictOptions`, `ResolveConflictResult`.
- **`package.json`** — version `0.8.0`; added `@modelcontextprotocol/sdk ^1.12.0` dependency; added `mk-mcp` bin entry; added `mcp` dev script (`tsx src/mcp/server.ts`).

### Fixed
- **`src/episodes.ts`** — pre-existing TypeScript strict-null error in episode sort comparator (`started_at` is optional; added `?? ''` guards).

### Tests
- 476 tests passing (up from 448).
- `test/mcp.test.ts` — 19 contract tests for all 8 tools (no transport needed; handlers called directly).
- `test/mcp-resources.test.ts` — 9 contract tests for all 4 resources (URI, mimeType, placeholder before reflect, real content after reflect).

## [0.7.0] — 2026-03-12

### Added
- **Multi-agent event-log union merge** (`src/merge.ts`) — `mergeEventLogs({ localDir, remoteDir, agent_id, session_id, dryRun? })` deduplicates events by `event_id`, sorts by `(timestamp, event_id)`, replays the merged log, writes atoms + views, creates `conflict` atoms for atoms mutated in both local-only and remote-only event sets, and emits a `merge_completed` event.
- **`mk merge` CLI command** — `mk merge -d <dir> --remote <path> [--agent-id <id>] [--session-id <id>] [--dry-run]`. Prints a merge summary (atoms written, conflicts created, events merged).
- **`MergeOptions` / `MergeResult` / `MergeConflict` types** — exported from the public API (`src/index.ts`).

### Tests
- 448 tests passing (up from 434).
- `test/merge.test.ts` — 388-line suite covering: basic merge, dry-run no-write, conflict detection for concurrent updates (same atom mutated in both local-only and remote-only event sets), idempotent re-merge, event deduplication by `event_id`, timestamp sort ordering, and `merge_completed` event emission.

## [0.6.0] — 2026-03-11

### Added
- **FTS5 full-text search** (`searchFts()`) — SQLite FTS5 virtual table with Porter stemming and Unicode normalization. Returns BM25-ranked `{ atom_id, rank }[]` results. Returns `null` gracefully when the index doesn't exist so callers can fall back to unranked results. New `indexExists()` export checks for the index file.
- **Task-aware recall** — `recall(dir, { task: '...' })` re-ranks candidates using FTS BM25 scores. Atoms with strong text matches rise to the top; unmatched atoms retain status-priority order. Same query + same store always produces identical atom ordering (deterministic).
- **Episode Store** (`src/episodes.ts`) — per-session markdown summaries written to `EPISODES/{EP-id}.md`. Session IDs are sanitised to kebab-case. Functions exported from public API: `writeEpisode()`, `readEpisode()`, `listEpisodes()`, `linkEpisodeToAtom()`. Episodes are isolated from `listAtoms()` (not scanned as atoms).
- **Episode-aware recall** — `recall(dir, { include_episodes: true })` populates `ContextBundle.episodes` with recent session summaries formatted as markdown strings. When combined with `task`, episodes are keyword-filtered by summary text. Episode token cost is included in `token_estimate`.
- **Active conflict detection heuristic** (`src/reflect.ts`) — `reflect()` now detects potential conflicts between pairs of `fact` and `decision` atoms that share overlapping scope paths and have confidence values differing by more than 0.3. Detected conflicts are written as `conflict` atoms to `CONFLICTS/`, emit `conflict_detected` events, and link back to both source atoms. `result.conflicts_found` reports the total active conflict atom count (pre-existing + newly created this cycle).
- **`mk episode` CLI command** — `mk episode -d <dir> --session-id <id> --summary "text" [--tags a,b]`. Writes an episode file and prints the episode ID to stdout.
- **`mk episodes` CLI command** — `mk episodes -d <dir> [--limit N] [--tags a,b]`. Lists episodes newest-first.
- **`mk recall --task <text>` flag** — passes `task` to `recall()` for FTS-backed re-ranking.
- **`mk recall --include-episodes` flag** — includes session episodes in recall output.
- **FTS5 schema version 3** — `PRAGMA user_version` bumped to 3. Databases from earlier schema versions are auto-rebuilt on first open.

### Fixed
- **`conflicts_found` semantic** — `reflect()` result now reports the total count of active conflict atoms (pre-existing + newly created), not just atoms created in the current cycle. Aligns with test expectations and PRD intent.

### Tests
- 434 tests passing (up from 383).
- `test/fts.test.ts` — 15 new tests: `searchFts()` ranking, null when index absent, empty array on no match, BM25 rank property, Porter stemming, limit parameter, injection safety for FTS5 special chars, whitespace-only query, `reindex()` rebuilds FTS, subsequent `searchFts()` returns expected results, task-aware recall ordering, determinism, no-match fallback, fallback without index.
- `test/episodes.test.ts` — 21 new tests: `writeEpisode()` creates file with correct frontmatter, session ID sanitisation to kebab-case, tags in frontmatter, `session_ended` event emission, idempotent overwrite (last-write-wins), agent_id from opts; `readEpisode()` returns null for non-existent, round-trip; `listEpisodes()` empty/newest-first/limit/tags-filter/all; `linkEpisodeToAtom()` add/idempotent/multiple; episodes excluded from `listAtoms()`; `recall()` populates `bundle.episodes`, hidden by default, keyword filtering, token estimate.

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
- **Finding #1 documented** (see `CODING_INSTRUCTIONS.md`): `replay()` / `replayFromFile()` silently accept invalid atom type/status/confidence in snapshots — no Zod validation at the replay layer. The stress test asserts this **actual** (silent) behavior so any future schema-validation addition will be a conscious, visible change.
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
