# Changelog

All notable changes to this project will be documented in this file.

> [!IMPORTANT]
> **License change — MIT → Apache-2.0**
> Effective v1.1.2, memory-kernel is distributed under the [Apache License 2.0](LICENSE) instead of the MIT License.
> See [NOTICE](NOTICE) for full attribution. Apache-2.0 adds patent termination clauses not present in MIT — review the license if this affects your use case.

## [Unreleased]

### Changed — repository layout

- **Renamed `container/skills/` → `skills/`.** Both `mk-memory-setup` and `mk-doctor` are host-side skills (run via Claude Code on the operator's machine, not inside a container), so the old location was misleading; `container/` was empty otherwise. No npm-package impact — the published `memory-kernel` package only ships `dist/`, `README.md`, and `LICENSE`.

### Added — agent lifecycle as typed memory + multi-host setup

- **`mk-memory-setup` now seeds 8 lifecycle atoms** (7 procedure + 1 constraint) so the agent's operating manual lives inside memory-kernel itself and is recallable per task — see `skills/mk-memory-setup/seed-atoms/lifecycle/`. The `seed-atoms/seed-lifecycle.sh` script is the canonical entry point.
- **`mk-memory-setup` is now host-aware.** SKILL.md auto-detects (or asks) whether the host is NanoClaw, OpenClaw, an MCP client (Claude Desktop, Cursor, Continue), or generic, and routes to the matching `references/<host>.md`. Universal core (install CLI, init store, seed atoms, cron) stays in SKILL.md; host-specific plumbing lives in references.
- **`mk-doctor` adds three universal checks:** `mk lint` (semantic health), `mk closure --trajectory` (drift detection), and a lifecycle-atom audit (catches agents bootstrapped before lifecycle seeding existed). Host-specific checks branch on detected host.

## [1.18.2] — 2026-05-13

### Fixed — semantic conflict detection durability (#77 review)

- **`reindex()` no longer wipes `entity_triples`.** Triples are LLM-extracted at ingestion and are not serialized in atom markdown, so the previous behaviour (clear without repopulate) silently destroyed all triple data and disabled Tier-1 conflict detection on every `mk reindex`. Triples are now snapshotted to a temp table at the start of reindex and restored at the end for atoms that still exist (orphaned triples are dropped, matching the embedding-preservation pattern in the same transaction).
- **`findCandidateConflicts` now excludes `expired` atoms** in addition to `superseded` and `archived`, bringing it in line with `queryIndex()` / `wander` and the rest of the active-status convention. Previously an expired atom could be returned as a conflict candidate and silently auto-superseded.
- **`mk render --fill` now honored in isolated mode.** `renderAgentClaudeMd` previously accepted `fill` via `RenderClaudeMdOptions` but never destructured or forwarded it, so `--fill` silently fell back to recall-based rendering for any agent in per-agent isolation. Adds `renderFillIsolated()` for the agent ∪ shared union path; for agents with `include_shared: false` the call delegates to `renderClaudeMd(..., { fill: true })`.
- **Removed dead `mockClaude` helper in `test/extract.test.ts`.** It mocked `execFile`, but the shared `callLLM` layer now uses `spawn` — so the mock would have been ineffective if ever called. It was unused; deleting avoids future confusion.
- **Doc fixes:** `loadAtomGraph` JSDoc now mentions `superseded` exclusion; `reindex()` FK-OFF comment now names `entity_triples` alongside `atom_relations`; `CODING_INSTRUCTIONS.md` updated to reflect that `createAtom()` always indexes (the previous "indexExists no-op" gotcha is gone).

## [1.18.1] — 2026-05-13

### Added — semantic conflict detection for `mk extract`

- **Semantic conflict detection pipeline inside `mk extract`** (#75). New two-tier pipeline runs automatically after atoms are written:
  - **Tier 1:** entity-triple extraction (LLM emits a `triples` field per candidate atom) and deterministic SQL matching on `(subject, predicate)` pairs with a disagreeing object value.
  - **Tier 2:** cheap LLM confirmation per Tier-1 candidate via `callLLM()` (temperature 0, capped at 150 tokens).
  - Confirmed conflicts automatically invoke `supersedeAtoms()` so the older atom is superseded by the newer one. Direction: newer-supersedes-older only.
- **New SQLite table `entity_triples`** (schema v8 — existing indexes auto-rebuild on first open).
- **New public API:** `detectAndResolveConflicts`, `confirmConflictWithLLM`, `insertTriples`, `getTriplesForAtom`, `findCandidateConflicts`; types `EntityTriple`, `TripleInput`, `ConflictCandidate`, `ConflictResolution`, `ConflictAction`.
- **New CLI flags on `mk extract`:** `--no-conflict-detect` (disable the pipeline), `--conflict-confirm-model <model>` (override Tier-2 confirmation model).
- **`ExtractResult` gains `conflicts: number`** (count of `action === 'superseded'`); **`ExtractedAtomResult` gains optional `conflicts: ConflictResolution[]`**.

## [1.18.0] — 2026-05-12

### Added — structured preference ingestion

- **`mk extract` and `mk observe` now ingest preferences as structured atoms.** `CandidateAtom` gains three new optional fields — `subject?`, `preference?`, `context?` — populated by the LLM when a preference signal ("I prefer…", "my favorite…", "I always/never…") is detected. The extraction prompt asks the model to produce these fields explicitly; the runtime canonicalizes the body into a `## Preference` / `**Subject:** …` / `**Preference:** …` / `**Context:** …` template so all preference atoms share one queryable shape. The observer prompt was updated with explicit `PREFERENCE:` markers and concrete examples to keep the two pipelines aligned.
- **Automatic `subject:<topic>` tag** is appended to every preference atom that has a `subject`. Topics are slugified with `[^a-z0-9]+` → `-` (matching `slugExists()`), so subjects like `"C++ / Rust (systems)"` produce a clean `subject:c-rust-systems` tag. Empty slugs after normalization are skipped — no `subject:` tag without a topic.

### Fixed — review-driven hardening of the new preference path

- **FTS possible-duplicate detection now queries the stored body.** Previously `checkPossibleDuplicate` ran against `candidate.body` *before* preference enrichment, so a re-extracted preference would query raw LLM text against an index built from the structured template — and miss. Moved the check to run on the final `body` variable so the query text matches what's indexed.
- **LLM-supplied `subject` / `preference` / `context` are sanitized before template interpolation.** A new internal `sanitizeField()` collapses `\r`, `\n`, and `\t` runs to a single space and trims. An LLM returning a value with a literal newline can no longer inject extra `**…:**` marker lines into the preference body; the body always has exactly three structural lines under `## Preference`.
- **Subject-tag normalization tightened.** The previous `subj.toLowerCase().replace(/\s+/g, '-')` only handled whitespace, so `"C++"` or `"food & drink"` produced malformed tags with raw `+`, `&`, `/`. Now uses the same character class as `slugExists()` and trims leading/trailing hyphens.

### Public API

- `src/types.ts` — `CandidateAtom` adds optional `subject?`, `preference?`, `context?`. Existing extractors that don't set these fields continue to work unchanged; the enrichment block only fires when both `subject` and `preference` are populated.

### Tests

- New tests in `test/extract.test.ts`: structured body generation, original-body fallback when fields are absent, kebab-case subject-tag normalization, special-character slugification (`C++ / Rust (systems)` → `subject:c-rust-systems`), and control-character sanitization (rejects `subject: "coffee\n**Injected:**"` injection). Suite: 1170 → 1176 passing.

## [1.17.1] — 2026-05-12

### Fixed — error-handling polish on `mk supersede` / `mk relate`

- **`findAtomFile` in both `mk supersede` and `mk relate` now surfaces caught errors on stderr** instead of silently swallowing them. SQLite corruption, `better-sqlite3` ABI mismatches, permission errors, and malformed atom files were previously hidden behind a silent fallthrough to file scan; the user now sees `⚠ Index query failed for <id> (<msg>); falling back to file scan.` or `⚠ Skipped unreadable atom file <path>: <msg>`. The fallback to file scan still runs — the change is observability-only.
- **`mk relate`'s mutation block is now wrapped in `try/catch → exitWithError`**, matching `mk supersede`. Previously `assertWithinDir`, `writeAtom`, or `indexAtom` throws would surface as raw Node stack traces; they now exit cleanly with the same error format as the rest of the command.
- **`mk supersede`'s CLI catch handles non-`Error` throws** (`err instanceof Error ? err.message : String(err)`) instead of producing `undefined` for callers that `throw` strings or non-`Error` values.

### Internal

- **`mk supersede` writeAtom→appendEvent ordering hazard documented** inline at the V2-events block in `src/cli/supersede.ts`. The order matches the project-wide convention in `src/retain.ts`; a crash between the two leaves disk ahead of the log until the next supersede run repairs the half via the existing idempotency contract.
- **Comment cleanup in `src/cli/supersede.ts`** to align with the "WHY-only" project convention: removed the file header, the `exitWithError` JSDoc, the `dryRun?` JSDoc, the "Re-index whichever..." inline comment, and the bug-history paragraph from `registerSupersedeCommand`. Shortened `supersedeAtoms` and `findAtomFile` docstrings; resolved the duplicated idempotency comment.
- **New test coverage in `test/supersede.test.ts`** — `findAtomFile` index-absent fallback (deletes `.memory-index.db` mid-test), SECRET-atom integration (verifies `atom_snapshot` is encrypted and plaintext bodies don't leak into events), and symmetric event-count assertion on the repair-missing-status partial-state test. Path-traversal test now matches the stable `Path traversal denied` substring instead of the brittle `/outside|escape|directory/i` regex. Supersede test count: 9 → 14, total suite 1103/1103 passing.

## [1.17.0] — 2026-05-12

### Added — `mk supersede` hardening

- **`mk supersede` now emits V2 mutation events** with `schema_version: 2` and `atom_snapshot`, restoring the `compactLog` invariant (the post-supersede atom state can be reconstructed from the event log alone). Previously both `appendEvent` calls used V1 format and broke replay determinism.
- **New `--agent-id`, `--session-id`, and `--dry-run` flags** on `mk supersede`. Event payloads now carry the real agent/session instead of the hardcoded `'cli'` / `'mk-supersede'`. `--dry-run` reports planned changes without writing files or appending events.
- **Independent idempotency for both halves of supersede.** Re-running `mk supersede A B` after a partial-state crash (e.g. old marked superseded but new missing its `supersedes` relation, or vice versa) now repairs whichever half is missing instead of returning early.
- **`supersedeAtoms()` exported as a pure function** from `src/cli/supersede.ts` for programmatic use and direct testing.
- **`snapshotAtom()` exported from the package barrel** (`src/index.ts`) so CLI commands and downstream consumers can produce SECRET-aware event snapshots without re-implementing the helper.

### Fixed — defense-in-depth on relation writes

- **`mk supersede` and `mk relate` now call `assertWithinDir(memoryDir, file)` before every `writeAtom`.** Both commands derive file paths from user-supplied atom IDs via index lookup or scan; the guard prevents a corrupted index from steering writes outside the memory tree.
- **`mk relate` now stamps `frontmatter.updated_at` on relation additions**, matching the convention enforced in `src/retain.ts`. Previously the on-disk timestamp drifted away from the actual last-mutation time.

## [1.16.1] — 2026-05-12

### Fixed — superseded atoms excluded from active views

- **Exclude `superseded` atoms from default filters** across `renderers.ts` (CLAUDE.md render), `recall.ts` (file-scan recall), `index-db.ts` (indexed recall), and `wander.ts` (spreading activation). Previously, superseded atoms rendered live alongside their canonical successors and showed up in recall/wander results, defeating the point of supersession. Default views now hide them; explicit `query.statuses: ['superseded']` still retrieves them.
- **`filterAtoms` (file-scan recall) now honours explicit status filters.** The default `archived`/`expired`/`superseded` exclusion was previously unconditional, so callers passing `query.statuses: ['superseded']` got zero results from the file-scan path while the index path correctly returned them. Both paths now share the same gate — exclusion only applies when no explicit `statuses` filter is given.
- **`buildGraphFromFiles` (wander file-scan fallback) now excludes `superseded`.** The index-backed `loadAtomGraph` was updated but the file-scan fallback was missed, creating divergent graph contents depending on whether the SQLite index existed. The two paths now agree, restoring the parity the `wanderFromFiles` docstring promises.

## [1.16.0] — 2026-04-25

### Added — Obsidian-native atom compatibility

- **Atom files are now natively Obsidian-compatible.** The ENTITIES/ directory can be opened directly as an Obsidian vault — no export step needed.
- **`## Relations` wikilink section** appended to every atom file that has `frontmatter.relations[]`. Uses `<!-- mk:relations -->` sentinel to delimit the machine-managed section. Stripped on parse — never pollutes `atom.body`.
- **`serializeAtom()` / `parseAtom()` hook** — single integration point in `format.ts`. All code paths that write or read atoms (retain, relink, enrich-relations, import, etc.) get wikilinks for free with zero changes.
- **New module `src/obsidian.ts`** — exports `renderRelationsSection()`, `stripRelationsSection()`, `generateGraphConfig()`, `RELATIONS_SENTINEL`, `TYPE_COLORS`, `TYPE_PREFIXES`.
- **New CLI command `mk obsidian-init`** — writes `.obsidian/graph.json` with type-based color groups (9 atom types, 4-char path-prefix queries). With `--sync`, rewrites all existing atom files to include `## Relations` sections.
- **Tag promotion to top-level YAML field** — `scope.tags` promoted to a top-level `tags:` field in frontmatter (before `scope:`), making tags indexable by Obsidian's native tag search. Tags are merged back into `scope.tags` on parse — round-trip safe.
- **Tag normalization** — new `normalizeTags()` utility splits comma-separated strings, trims whitespace, dedupes, and sorts. Applied automatically during `serializeAtom()` and `parseAtom()` so Obsidian-edited tags are always canonical.
- **Safe writes in `mk obsidian-init --sync`** — uses `writeAtom()` (which handles SECRET encryption + atomic writes) instead of raw `fs.writeFileSync`.
- **23 new tests** covering render/strip pure functions, round-trip serialize/parse, graph config structure, tag promotion/stripping, tag normalization, and integration (atom files on disk).

## [1.15.0] — 2026-04-22

### Added — `mk extract` automatic atom extraction

- **New command `mk extract`** (`src/cli/extract.ts`, `src/extract.ts`) — reads a conversation log file, calls an LLM to identify facts, decisions, preferences, and beliefs worth remembering, reconciles against the existing store (BM25 duplicate detection), and writes draft atoms.
- **LLM providers:** Claude Code CLI (`claude -p`, default) or Ollama HTTP API (pass `--model qwen2.5:14b` or any Ollama model name).
- **Flags:** `<log-path>` (positional), `-d/--dir <dir>`, `--model <model>`, `--dry-run`, `--json`, `--max-atoms <n>` (default 20), `--skip-lines <n>` (skip preamble), `--agent-id <id>`, `--session-id <id>`.
- **SDK:** `extractFromLog(options: ExtractOptions): Promise<ExtractResult>` — same functionality, programmatic access.
- **JSON output:** `{ extracted, skipped, possible_duplicates, atoms: ExtractedAtomResult[] }`

### Added — `mk consolidate` lifecycle promotion

- **New command `mk consolidate`** (`src/cli/consolidate.ts`, `src/consolidate.ts`) — reviews auto-extracted draft atoms and promotes them to active status. Detects possible duplicates against the active store via BM25 ranking.
- **Flags:** `-d/--dir <dir>`, `--dry-run`, `--all` (include all drafts, not just auto-extracted), `--type <type>` (filter by atom type), `--limit <n>` (default 50), `--json`, `--agent-id <id>`, `--session-id <id>`, `--duplicate-threshold <n>` (default -2.0).
- **SDK:** `consolidateAtoms(options: ConsolidateOptions): Promise<ConsolidateResult>` — same functionality, programmatic access.
- **JSON output:** `{ processed, promoted, skipped, errors, dry_run, atoms: ConsolidateAtomResult[] }`

### Added — `mk lint` semantic health checker

- **New command `mk lint`** (`src/cli/lint.ts`, `src/lint.ts`) — checks the memory store for six categories of semantic problems and reports findings grouped by severity:
  - `contradiction` — atoms with mutually inconsistent claims
  - `stale` — facts and decisions not updated within `--stale-days` (default: 90 days)
  - `orphan` — atoms with no relation edges and no tag overlap with other atoms
  - `duplicate` — near-duplicate atom pairs (high body-text similarity)
  - `confidence_drift` — beliefs whose confidence has not changed despite multiple event updates
  - `ttl_warning` — atoms approaching TTL expiry

- **Flags:** `-d/--dir <dir>` (memory directory), `--json` (structured output), `--stale-days <n>` (staleness threshold, default 90), `--fix` (placeholder — warns not yet implemented, runs lint in read-only mode)
- **Exit codes:** exits `1` when the memory directory is not found or `--stale-days` is invalid; exits `0` on all lint outcomes including findings (findings are informational, not fatal)
- **JSON output:** `{ findings: LintFinding[], summary: { total, warnings, info } }`

### Fixed — Recall pipeline quality (PRs #18, #19, #20)

- **Content-length normalization** (`src/recall.ts`, `src/index-db.ts`) — Long atoms (entity summaries, session episodes) previously received inflated BM25 scores purely due to document length. A post-FTS length factor `1 / (1 + K * (wordCount/avgWordCount - 1))` now dampens scores for atoms above average length. `K=0.5` by default. Configurable via `RECALL_LENGTH_NORM_K` env var or `RecallQuery.length_norm_k`. Short atoms are capped at `1.0` (no boost, only penalty for long atoms).

- **FTS OR semantics + query-term coverage boost** (`src/index-db.ts`, `src/recall.ts`) — `searchFts()` previously used implicit AND, requiring all query terms to match. Switched to explicit OR so partial-match atoms enter the result set. A coverage boost multiplier `(matched/total)^P` (default `P=0.5`) then penalizes atoms that match only a fraction of terms, ensuring all-term matches rank higher despite OR expansion. Configurable via `RECALL_COVERAGE_BOOST` env var or `RecallQuery.coverage_boost` (clamped `[0, 2]`).

- **MMR result diversity** (`src/recall.ts`) — After switching to OR semantics, the result set can contain many near-duplicate atoms about the same topic that fill the token budget redundantly. Maximal Marginal Relevance (Carbonell & Goldstein, 1998) now re-ranks after scoring but before token-budget application, balancing relevance with textual diversity using word-trigram Jaccard similarity. Applied to both task and no-task (constitution/render) paths. `RECALL_MMR_LAMBDA` env var (default `0.7`) and per-call `RecallQuery.mmr_lambda` override. `lambda=1.0` disables MMR entirely (zero cost). Trigrams are precomputed once per atom to avoid O(n²) extraction in the selection loop.

### Tests

- Full suite: 1070/1070 passing.

## [1.14.0] — 2026-04-21

### Fixed — IDF hub-damping specificity scoring

- **Stemmer-consistent specificity check** (`src/recall.ts`, `src/index-db.ts`) — `computeSpecificityScores` now uses per-term FTS queries (`getAtomsMatchingTerm`) instead of raw substring matching on body text. Previously, porter-stemmed FTS matches (e.g. "running" → "run") would fail the substring check and receive a false specificity penalty. Title-only FTS matches were also missed since the old check only examined `atom.body`.
- **New helper `getAtomsMatchingTerm`** (`src/index-db.ts`) — Returns the set of atom_ids matching a single term via FTS (porter-stemmed, same sanitisation as `searchFts`).
- **Clamped `idf_damping` from caller** (`src/recall.ts`) — `query.idf_damping` is now clamped to [0, 1] on the query path, matching the env-var path. Previously a caller passing a value >1 or <0 would break the 0–1 contract.

## [1.13.0] — 2026-04-21

### Changed — Episode recall scores against task and respects token budget

- **Episodes now rank by term-overlap + temporal decay** (`src/recall.ts`) — `recall({ include_episodes: true, task })` now scores candidate episodes with a lightweight TF relevance (fraction of query terms appearing in the summary) combined with exponential decay, using the same `relevance * (1 - decayWeight) + recency * decayWeight` composite as atoms. Zero-relevance episodes are dropped when a task is provided. Previously all candidate episodes were bulk-included unranked (~800 tokens each), crowding out atoms in tight budgets.
- **Episode token slice is reserved from the atom budget** (`src/recall.ts`) — When `include_episodes` and `max_tokens` are both set, episodes get up to `MAX_EPISODE_BUDGET_RATIO` (20%) of `max_tokens` and that slice is subtracted from the atom budget up-front so `bundle.token_estimate` stays within `max_tokens`. Previously episodes were added on top of the full atom budget, allowing the bundle to exceed the requested cap.
- **Episode candidate pool raised from 10 to 20** (`src/recall.ts`) — Gives the new scoring pass more candidates to rank against; the 20% budget cap prevents this from bloating output.

### Tests

- `test/episodes.test.ts` — new coverage for score-based ordering, budget-capped selection, zero-relevance filtering, backward-compatible no-task recency sort, and `token_estimate <= max_tokens` invariant for both task and no-task paths with `include_episodes: true`.
- Full suite: 921/921 passing (two unrelated `openclaw-plugin*.test.ts` files fail to import `@sinclair/typebox` in this environment — not touched by this release).

## [1.12.0] — 2026-04-19

### Fixed — Task-focused recall returns relevant atoms

- **FTS multi-word queries now match** (`src/index-db.ts`) — `searchFts()` sanitises FTS5 operators (`" * ( ) ^ : -` and the `NEAR` keyword) and issues an implicit-AND over tokens instead of a quoted phrase. Multi-word queries like `"pagination api"` match documents containing both words in any order (with stemming), rather than requiring exact adjacency and returning `[]`.
- **Task recall no longer pinned to a fixed type set** (`src/recall.ts`) — When `task` is provided, type reservations auto-disable so recall is driven by relevance rather than type quotas. High-relevance atoms (top 30% by score) bypass reservation priority. Total reservation budget is capped at 30% of `maxTokens` with proportional scaling, preventing small budgets from being monopolised.
- **Explicit `no_reservations: true` is now honoured unconditionally** (`src/recall.ts`) — Force-off disables reservations entirely, including any caller-supplied `type_reservations` map. Previously the caller map silently re-enabled reservations despite the explicit disable.

### Added

- **CLI: `--reservations` / `--no-reservations` flags** (`src/cli/mk.ts`) — Override the task-auto-disable behaviour. `--no-reservations` forces reservations off; `--reservations` forces them on even with a task.
- **`RecallQuery.no_reservations`** (`src/types.ts`) — New public field (`true`/`false`/`undefined`) wired through `recall()`.

### Docs

- `CODING_INSTRUCTIONS.md` FTS gotcha rewritten to describe implicit-AND-over-tokens semantics (prior note still documented the removed quoted-phrase behaviour).

### Tests

- `test/recall-scoring.test.ts` — regression test for `no_reservations: true` + `type_reservations` force-off contract.
- Full suite: 983/983 passing.

---

### Changed — OpenClaw Plugin Isolation Hardening

- **BREAKING: Missing agent store now throws by default** — Previously, when an agent store was missing and `autoInitAgentStore` was off, the plugin silently fell back to shared mode. Now it throws with an actionable error message. Set `allowSharedFallback: true` to restore the old behavior.

- **`allowSharedFallback` config field** — New opt-in field (default: false) that restores the pre-hardening fallback behavior for migration/development scenarios.

- **`failIfMissingAgentStore` deprecated** — `true` is now redundant (throwing is the default). Retained for backward compatibility; `failIfMissingAgentStore: false` maps to `allowSharedFallback: true`.

- **Isolation-aware checkpoint** — `mk_context_bundle` and the pre-compaction hook now include shared namespace atoms in isolated mode, matching `mk_recall` and bootstrap behavior. `CheckpointOptions` extended with `baseDir`, `isolated`, `sharedRecall` params. `handleGetContextBundle` in the MCP server now forwards `isolated` and `baseDir` to `checkpoint()` so the tool actually takes the isolated-recall branch when the MCP context is in per-agent mode.

- **`wanderFromFiles` shared-namespace support** — The index-free wander fallback now merges atoms from `sharedMemoryDir` (with `assertWithinDir` path validation), matching the index-backed `wander()` path. Previously the CLI passed `sharedMemoryDir` to both branches but `wanderFromFiles` silently ignored it, so agents without a built index saw zero shared atoms in collision detection.

- **Runtime agent identity wiring** — Bootstrap hook extracts agent identity from `event.context.agentIdentity.id` (or `event.context.agent.id`) when available. Prepares for OpenClaw runtime identity support. Falls back to static `cfg.agentId` when absent.

### Added — OpenClaw Plugin Per-Agent Isolation

- **OpenClaw plugin isolation routing** — All 5 tools (`mk_remember`, `mk_recall`, `mk_reflect`, `mk_context_bundle`, `mk_status`) and 3 hooks (`agent:bootstrap`, `session:compact:before`, `command:new/reset`) now route through `resolveEffectiveMemoryContext()`. In isolated mode, writes go to `agents/{agentId}/`, reads use union recall (agent + shared). Shared mode is fully backward compatible.

- **Plugin config: isolation fields** — 4 new config fields: `isolationMode` (`auto` | `shared-only` | `per-agent-required`), `autoInitAgentStore` (default: false), `sharedRecall` (default: true), `failIfMissingAgentStore` (default: false). Config schema updated in both plugin source and `openclaw.plugin.json` manifest.

- **`recallIsolatedWithEmbeddings()`** (`src/isolation-recall.ts`) — Async variant of `recallIsolated()` with optional embedding-backed recall. When `useEmbeddings: true`, uses `recallWithEmbeddings()` per store instead of FTS-only `recall()`. Same agent-wins-on-collision merge and token budget logic.

- **Enhanced `mk_status`** — In isolated mode, reports: isolation mode, effective agent ID, base dir, shared namespace status, shared atom count, and shared recall enabled/disabled.

- **Enhanced bootstrap observability** — In isolated mode, bootstrap message includes agent routing info: `mk: bootstrap agent=<id> isolated=true shared=<bool> atoms=<n>`.

- **Actionable errors** — Missing agent stores produce clear error messages with `mk init -a <id> <baseDir>` suggestions.

- **Test coverage** — `test/openclaw-plugin-isolation.test.ts` (24 tests): config parsing, effective context resolution, tool routing, hook routing, cross-agent isolation, backward compatibility.

### Added — Per-Agent Memory Isolation

- **Two isolation modes: `shared` (default) and `per-agent`** — backward-compatible by design. In shared mode, everything works unchanged. In per-agent mode, each agent gets `agents/{agentId}/` with its own atoms, index, events, and render config; a `shared/` namespace holds explicitly shared atoms. Mode is set via `config.yaml` or `MK_ISOLATION` env var.

- **Isolation core** (`src/isolation.ts`) — `loadConfig()` / `writeConfig()` for config.yaml management, `isIsolated()` mode check, `resolveAgentDir()` routing (identity in shared mode, `agents/{id}/` in isolated mode), `getSharedDir()`, `listAgents()`, `initAgentStore()`, `initSharedStore()`, `initIsolatedBase()`. Agent ID validation (`assertValidAgentId()`) enforces alphanumeric + dash + underscore only — blocks path traversal via `assertWithinDir()`.

- **Union recall** (`src/isolation-recall.ts`) — `recallIsolated()` searches agent store + shared namespace, merges results with agent-wins-on-collision dedup, applies token budget once at the merge step (not per-source) so shared atoms aren't starved. Episodes merged with dedup.

- **Share/unshare** (`src/share.ts`) — `shareAtom()` copies an atom snapshot from an agent store to the shared namespace (not symlink — re-share to update). `unshareAtom()` removes from shared. `listSharedAtoms()` lists the shared namespace. Events: `atom_shared`, `atom_unshared`.

- **Migration** (`src/migrate.ts`) — `migrate()` converts a shared-mode store to per-agent isolation with three strategies:
  - `fresh` — Write config.yaml + create shared dir, leave existing atoms as-is
  - `partition` — Route atoms to agent subdirs by their creating `agent_id` from the event log
  - `clone-to-shared` — Copy all existing atoms into the shared namespace
  - Backup: timestamped `.mk-backup-*` directory created before destructive operations. Config written first so crash leaves store in "already isolated" state (idempotent on re-run).

- **Per-agent render config** — `render.yaml` per agent directory with fields: `mode` (operational | constitutive | balanced), `max_tokens`, `include_shared`, `type_weights` (per-atom-type recall weight overrides). `loadRenderConfig()` / `writeRenderConfig()` with validation and defaults.

- **`renderAgentClaudeMd()`** (`src/render.ts`) — Render CLAUDE.md for a specific agent in isolated mode. Loads per-agent render.yaml, uses `recallIsolated()` for agent + shared union when `include_shared: true`.

- **Wander scoping** (`src/wander.ts`) — In isolated mode, graph walks are scoped to the agent's own store + shared namespace. Agents cannot traverse into other agents' private stores.

- **CLI additions:**
  - Global `-a, --agent <id>` option threads agent isolation through all commands
  - `mk init -a <agent>` — Initialize in per-agent isolation mode (creates config.yaml, `agents/{agent}/`, `shared/`)
  - `mk status --all-agents` — Per-agent summary showing atom/event counts per agent + shared namespace
  - `mk share <atom-id> --from <agent>` — Share atom snapshot to shared namespace
  - `mk unshare <atom-id>` — Remove atom from shared namespace
  - `mk migrate --strategy <fresh|partition|clone-to-shared>` — Convert shared store to isolated mode

- **MCP additions** (`src/mcp/`):
  - `mk_share_atom` tool — Share atom from agent to shared namespace (isolated mode only)
  - `mk_unshare_atom` tool — Remove atom from shared namespace (isolated mode only)
  - `MCP_AGENT_ID` env var — Determines which agent store the MCP server routes to (defaults to `mcp-server`)
  - All existing tools automatically route to the correct agent store via `resolveMemoryDir()`

- **New types** (`src/types.ts`): `IsolationConfig`, `RenderConfig`, `RenderMode`, event actions `atom_shared` and `atom_unshared`.

- **[Isolation guide →](docs/isolation.md)** — Dedicated documentation covering concepts, quick start, sharing, union recall, migration, CLI/SDK/MCP reference, and troubleshooting.

### Tests — Per-Agent Isolation

- 7 new test modules, ~1,450 lines:
  - `test/isolation.test.ts` — Config loading, agent store init, render config, path validation
  - `test/isolation-recall.test.ts` — Union recall, agent-wins dedup, token budget, episodes
  - `test/isolation-render.test.ts` — Per-agent render with type_weights, include_shared
  - `test/isolation-wander.test.ts` — Graph scoping, shared accessibility, cross-agent invisibility
  - `test/isolation-migrate.test.ts` — All 3 migration strategies, backup, idempotency
  - `test/share.test.ts` — Share/unshare operations, snapshots, re-share, events
  - `test/mcp-isolation.test.ts` — Tool routing, share/unshare tools, shared-mode rejection

### Changed — OpenClaw plugin (SecretRef support for sensitive config)

- **`embeddingApiKey` and `encryptionKey` now accept file SecretRefs** in addition to plain strings. Users can write `{ "source": "file", "provider": "vault", "id": "/openai-api-key" }` and the plugin resolves it locally at init via a `secretProviders` map. Lets users keep sensitive values out of both `openclaw.json` and `~/.openclaw/.env` (which `openclaw gateway install` otherwise inlines into the launchd/systemd service file).
- Resolution is plugin-local because OpenClaw's central SecretRef surface (`openclaw secrets configure` / `secrets apply`) is a hardcoded list that doesn't include third-party plugin config fields. Framed as a short-term workaround in `INSTALL.md`; when upstream adds memory-kernel fields to the central surface, the shadow resolver can be removed and users can rewrite refs in OpenClaw's native form.
- Pointer format is a deliberate subset of RFC 6901: slash-delimited navigation through nested plain-object keys. Array indices and escape sequences (`~0`, `~1`) are explicitly rejected at parse time with clear error messages.
- File-permission hygiene: the plugin `fs.stat`s the vault file and emits `console.warn` if the mode is group/world readable (non-fatal — documented as hygiene advisory, not blocker).
- Schema (both `src/index.ts` `jsonSchema` and `openclaw.plugin.json` `configSchema`) updated to use `oneOf: [string, SecretRef]` for the two fields, plus a new top-level `secretProviders` map.
- 9 new tests in `test/openclaw-plugin.test.ts` covering: string pass-through (regression), flat-key resolution, nested-key resolution, unknown-provider error, missing-file error, pointer-miss error, array-rejection, RFC 6901 escape rejection, loose-mode warning.

### Added — Docs

- **`docs/host-integration-doctrine.md`** — host-agnostic doctrine guide distilled from the OpenClaw memory-kernel-first transition. Covers the three-layer model (kernel primary / transcript search secondary / files support), `AGENTS.md` + `MEMORY.md` templates, a working compaction-prompt template, retrieval order, what belongs (and what doesn't) in memory-kernel, promotion workflow from files → atoms, and health-check criteria.
- README and plugin INSTALL.md now link the doctrine guide so integrators find it before hitting the same "machinery ready, behavior still file-first" trap.

### Changed — OpenClaw plugin (Tier-1 memory-kernel-first polish)

- **Tool descriptions now encode the routing doctrine.** `mk_remember`, `mk_recall`, and `mk_context_bundle` describe themselves as the primary durable-memory surface, with `memory_search` positioned as secondary (transcript / legacy recall) and `memory/*.md` as the support layer (daily logs, raw notes, imports). Agents pick up the routing rule through the tool list even if the host doctrine lags.
- **Bootstrap hook now emits observable signals.** The `agent:bootstrap` handler pushes one of `mk: bootstrap injected N atoms` / `mk: bootstrap — no atoms yet` / `mk: bootstrap failed — <err>` / `mk: no memory dir — file-first fallback` via `event.messages` instead of silently no-opping. Lets host doctrine fall back reliably when recall is unavailable.
- **Pre-compaction hook reports checkpoint summary.** The `session:compact:before` handler now captures `checkpoint()` output and pushes `mk: pre-compact checkpoint saved (N atoms, ~T tokens)` via `event.messages` — gives host compaction prompts a signal to route scratch-vs-durable content instead of re-dumping.
- **Session id now flows from lifecycle events into tool audit trail.** An internal `currentSessionId` tracker is updated by `agent:bootstrap`, `command:new`, `command:reset`, and `session:compact:before` hooks. `mk_remember`, `mk_recall`, `mk_reflect`, and `mk_context_bundle` use it instead of the previous hardcoded `'unknown'`, restoring meaningful audit trails in `events.ndjson`.

### Added — OpenClaw plugin

- **`packages/openclaw-memory-kernel`** — native OpenClaw plugin surfacing memory-kernel through structured tools and lifecycle hooks (runs in-process, no MCP subprocess).
  - Tools: `mk_remember`, `mk_recall`, `mk_reflect`, `mk_context_bundle`, `mk_status`.
  - Named lifecycle hooks registered via `api.registerHook(..., { name, description })`:
    - `mk_bootstrap_recall` (`agent:bootstrap`) — injects recalled atoms into agent bootstrap context.
    - `mk_precompact_checkpoint` (`session:compact:before`) — writes checkpoint before compaction.
    - `mk_session_end` (`command:new`, `command:reset`) — runs `reflect()` and writes an episode.
  - Config fields: `memoryDir`, `encryptionKey`, `agentId`, `embeddingProvider`, `embeddingApiKey`, `embeddingModel`.
  - Auto-reindex on plugin init when no index exists; failures now logged via `console.warn` instead of silently swallowed.
  - Embedding integration: when `embeddingProvider` is set, `mk_recall` and the bootstrap hook use `recallWithEmbeddings` (hybrid FTS5 + vector). If `embeddingApiKey` is not provided and provider is `openai`, the plugin falls back to `OPENAI_API_KEY` from the environment.
  - Bootstrap recall now attributes startup events with `agent_id` and `session_id: "bootstrap"` for audit traceability.
- Plugin manifest at `packages/openclaw-memory-kernel/openclaw.plugin.json` with `configSchema` covering all six config fields.

### Tests

- 16 integration tests in `test/openclaw-plugin.test.ts` exercising every tool + lifecycle hook against a real temp memory directory, covering: atom creation with frontmatter, scope_tags → scope.tags mapping, recall with results and on empty memory, sync reflect, context bundle, status with atoms and with null index, bootstrap injection and skip-on-empty, checkpoint event creation, session-end reflect + episode write, and init reindex.

---

## [1.9.0] — 2026-04-09

### Added

- **`mk closure` — Operational closure metrics** (`src/closure.ts`) — Computes how self-referential a memory store is. Based on Luhmann's operational closure: a system that responds based on internal structure rather than external input. Single closure index predicts both automation resistance (LLM classifier accuracy) and cross-agent transplant compatibility.
  - `closure(memoryDir, options)` — compute all metrics
  - `mk closure -d <dir> [--json] [--trajectory] [--trajectory-days N]` — CLI with human-readable and JSON output
  - Metrics: `closure_index`, `entanglement_pct`, `phase` (early/type-composition/entanglement), `predictions`
  - Trajectory mode shows daily closure evolution
  - Exports: `closure`, `ClosureResult`, `TrajectoryPoint`, `ToolPrediction`

### Tests

- 13 new tests in `test/closure.test.ts`: unit tests for empty store, belief counting, relations, phase detection (3 phases), predictions, body-text cross-references, self-reference exclusion; CLI tests for JSON output, trajectory, error handling, human-readable format.

---

## [1.8.0] — 2026-04-06

### Added

- **Concept-name graph edges** — `mk relink` now creates relation edges from concept-name references in body text (not just atom ID references). Significantly increases graph connectivity for stores with informal cross-references.

### Fixed

- **Wander seed resolution warning** — `mk wander` now warns when seed IDs don't resolve in the graph instead of silently falling back to auto-seeds.

### Changed

- Export `deduplicateRefs` from public API.
- Type fixes and additional code comments from code review.

---

## [1.7.0] — 2026-04-05

### Added

- **`--json` on all CLI commands** — Every command now supports `--json` for machine-readable output. Error paths return `{"error": "..."}` with exit code 1.
- **CLI integration guide** (`docs/cli-integration.md`) — Guide for orchestrators consuming CLI output.

### Fixed

- **`relationWeight` default** — Changed from 0.5 to 1.0 so explicit relation edges properly dominate tag co-occurrence in wander. Previously deliberate associations were weaker than coincidental tag matches.

### Tests

- Added CLI `--json` smoke tests across all commands.

---

## [1.6.0] — 2026-04-04

### Added

- **ACT-R base-level activation with citation frequency** — Wander's base-level activation now follows the ACT-R power-law model: `B_i = ln(n) - d·ln(t)` where `n` = citation count + 1, `t` = age in days, `d` = 0.5 (standard ACT-R decay). Foundational beliefs cited 28 times receive a `ln(28) ≈ 3.3` boost over uncited atoms, making them outrank recent-but-isolated ones. Previously activation used only recency with an effective decay of 1.0 (too aggressive).

- **Concept-name citation extractor** (`src/citations.ts`) — Discovers informal references between atoms by deriving searchable concept names from atom ID slugs and matching against body text. Three citation layers: explicit relations (frontmatter), atom-ID references (body text), and concept-name references (body text, 3.5× larger than atom-ID refs). Stores counts in `atom_citations` SQLite table.
  - `deriveConceptNames(atomId)` — extract searchable keywords from atom slug
  - `extractCitations(memoryDir)` — scan all atoms for cross-references (no DB write)
  - `indexCitations(memoryDir)` — extract and store citations in SQLite (idempotent)
  - `mk citations -d <dir> [--json]` — CLI command showing total mentions, breakdown by type, unique targets, top 10 cited atoms
  - Exports: `extractCitations`, `indexCitations`, `deriveConceptNames`, `CitationEntry`, `CitationResult`

- **`atom_citations` SQLite table** — Schema bumped to **v6**. Table: `(source_id, target_id, count, type)` with FK CASCADE on both columns. Created by index-db.ts DDL alongside all other tables. Cleared on reindex. Included in `indexStats()`.

### Changed

- **Sqrt-sigmoid baseBoost** — Activation modulation changed from `1/(1+exp(-B_i))` (range [0.5, 1.0]) to `1/sqrt(1+exp(-B_i))` (range [0.707, 1.0]). Gentler compression preserves activation flow to structurally important but temporally old hub atoms.

- **`relationWeight` default: 0.5 → 1.0** — Explicit relation edges now carry ~2× the weight of tag co-occurrence (which is diluted by fanout). Previously explicit edges and coincidental shared tags had similar weight. Calibrated down from initial 2.0 after code review (chain dominance at 4×).

- **`indexStats()` return type** — Now includes `citations: number` field.

- **`GraphNode` interface** — Added `citation_count: number` field for wander graph nodes.

### Migration

Schema v5 → v6: run `mk reindex -d <memory-dir>` once after upgrading. The `atom_citations` table is created automatically. Then run `mk citations -d <memory-dir>` to populate citation counts (optional — wander works without them, defaulting to frequency=1).

### Tests

- 12 new tests in `test/citations.test.ts`: concept name derivation (4), citation extraction (4), SQLite storage and idempotency (4).

---

## [1.5.0] — 2026-04-02

### Added

- **`mk relink` — body-text relation extraction** (`src/relink.ts`) — Scans atom bodies for atom ID references and infers relation types from surrounding context (e.g., "extends" near an ID → `extends` edge). Auto-relinks on atom creation.
  - `relinkAll(memoryDir, options)` — scan all atoms, extract references, write relation edges
  - `relinkAtom(memoryDir, atom)` — relink a single atom (called automatically after `createAtom`)
  - `extractBodyReferences(body)` — extract atom ID patterns from text
  - `inferRelationType(context)` — infer relation type from surrounding text
  - `mk relink -d <dir> [--dry-run | --apply]` — CLI with preview mode
  - Exports: `relinkAll`, `relinkAtom`, `extractBodyReferences`, `inferRelationType`, `ATOM_ID_PATTERN`, `RELATION_CONTEXT`, `ProposedRelation`, `RelinkResult`

### Changed

- Auto-relink on `createAtom` — new atoms automatically get relation edges extracted from body text. Event snapshot includes extracted relations.

---

## [1.4.0] — 2026-04-02

### Added

- **Temporal decay scoring (Phase 1)** — Recall now blends keyword/semantic relevance with freshness. Atoms decay exponentially from score 1.0 at age 0, to 0.5 at `decay_half_life` days, to 0.25 at 2× half-life.
  - `RecallQuery.decay_half_life` — half-life in days (default: 30, env: `RECALL_DECAY_HALF_LIFE`)
  - `RecallQuery.decay_weight` — weight of recency in final score, 0–1 (default: 0.2, env: `RECALL_DECAY_WEIGHT`)
  - Score formula: `base = relevance * (1 - decay_weight) + recency * decay_weight`
  - No-task path: atoms sorted by temporal decay instead of raw `updated_at`
  - `decay_weight: 0` falls back to `updated_at DESC` ordering (original behavior preserved)
  - Exported `temporalDecay(createdAt, halfLifeDays)` for testing and custom scoring
  - `--decay-weight` and `--half-life` CLI flags added to `mk recall`
  - `decay_half_life`/`decay_weight` added to `mk_recall` MCP tool schema

- **Type-aware weighting (Phase 2)** — Per-type score multipliers and confidence factors ensure constraints and decisions surface above lower-priority noise.
  - `DEFAULT_TYPE_WEIGHTS`: `constraint` 1.5×, `decision` 1.3×, `procedure` 1.2×, `conflict` 1.1×, `fact`/`preference` 1.0×, `open_question` 0.9×, `belief`/`entity_summary` 0.8×
  - `DEFAULT_CONFIDENCE_FLOOR = 0.7` — `conf_factor = floor + (1 - floor) * confidence` prevents 0-confidence atoms from being entirely zeroed out
  - `DEFAULT_TYPE_RESERVATIONS`: `decision` 800 tokens, `constraint` 400 tokens, `conflict` 400 tokens — guaranteed budget slots regardless of relevance rank
  - `RecallQuery.type_weights` — per-call type multiplier overrides
  - `RecallQuery.type_reservations` — per-call reservation overrides
  - Two-pass token budget: reserved types fill first, then greedy fill with remainder
  - Final score formula: `relevance * (1 - decay_weight) + recency * decay_weight`, multiplied by `typeWeight * confFactor`
  - Env vars: `RECALL_TYPE_WEIGHTS` (JSON object), `RECALL_TYPE_RESERVATIONS` (JSON object), `RECALL_CONFIDENCE_FLOOR`
  - `type_weights`, `type_reservations`, `graph_boost` added to `mk_recall` MCP tool schema
  - Exports: `DEFAULT_TYPE_WEIGHTS`, `DEFAULT_CONFIDENCE_FLOOR`, `DEFAULT_TYPE_RESERVATIONS`

- **Relationship edges (Phase 3)** — Typed graph edges between atoms, stored in SQLite, with single-hop spreading activation in recall.
  - `AtomFrontmatter.relations?: Relation[]` — inline edge list in atom frontmatter
  - `RELATION_TYPES`: `extends`, `contradicts`, `supports`, `caused_by`, `supersedes`, `related`
  - `atom_relations` SQLite table: PK `(source_id, target_id, relation_type)`, both FKs `ON DELETE CASCADE`
  - SQLite schema bumped to **v5** — auto-rebuilds on first `mk reindex` after upgrade
  - `reindex()` uses two-pass strategy: all atoms first, all relations second (avoids FK ordering violations)
  - Graph-walk boost in `recall()`: single-hop spreading activation — high-scoring atoms lift their neighbours
    - Default boost factor: 0.15, env: `RECALL_NEIGHBOR_BOOST`
    - Diminishing returns formula: `boost += score * factor * (1 / (1 + accumulated))` prevents runaway amplification
    - `RecallQuery.graph_boost` — per-call enable/disable (default: true, env: `RECALL_GRAPH_BOOST`)
    - Query param takes precedence over env var
  - New CLI commands:
    - `mk relate <source-id> <type> <target-id>` — write a typed edge to atom frontmatter and index
    - `mk relations <atom-id>` — print inbound and outbound relation table
    - `mk migrate-relations [--dry-run | --apply]` — migrate `links.related` → `relations[]` and mine body text for atom ID references
  - New SDK exports: `getRelationsForAtom`, `addRelation`, `getAllRelations`, `AtomRelation`, `RELATION_TYPES`, `Relation`, `RelationType`
  - `indexStats()` now includes `relations: number`

### Changed

- `max_tokens` now applied even when FTS query matches zero atoms — previously the budget was silently skipped when neither FTS nor semantic signals existed, returning an unbounded response. Now degrades gracefully to greedy insertion-order fill.
- `recall()` no-task sort order changed: status priority is checked **first**, then temporal decay (was decay-first, which caused draft atoms to outrank active ones when newer).
- **Wander collision criteria: dissimilarity instead of type-difference** — Collision detection no longer requires `type_a !== type_b`. Instead, pairs are filtered by tag Jaccard dissimilarity > 0.7 (`1 - |A∩B|/|A∪B|`). Score formula changed from `activation × distance` to `activation × dissimilarity`. This surfaces belief↔belief connections with disjoint tag vocabularies, which were previously discarded (~90% of explicit relations in belief-heavy knowledge bases). New `dissimilarity` field added to `Collision` interface. Tags are now deduplicated during graph construction.

### Environment Variables (v1.4.0)

| Variable | Default | Description |
|----------|---------|-------------|
| `RECALL_DECAY_HALF_LIFE` | `30` | Days until decay factor = 0.5 |
| `RECALL_DECAY_WEIGHT` | `0.2` | Recency weight in final score (0–1) |
| `RECALL_TYPE_WEIGHTS` | (see defaults) | JSON object of per-type multipliers |
| `RECALL_TYPE_RESERVATIONS` | (see defaults) | JSON object of min token slots per type |
| `RECALL_CONFIDENCE_FLOOR` | `0.7` | Min conf factor for zero-confidence atoms |
| `RECALL_NEIGHBOR_BOOST` | `0.15` | Graph-walk spreading activation factor |
| `RECALL_GRAPH_BOOST` | `true` | Enable/disable graph-walk boost globally |

### Migration

Schema v4 → v5: run `mk reindex -d <memory-dir>` once after upgrading. The `atom_relations` table is created automatically. No existing atom files need modification.

Optionally back-fill relation edges from existing data:

```bash
mk migrate-relations -d <memory-dir> --dry-run   # preview what would change
mk migrate-relations -d <memory-dir> --apply      # write changes to disk
```

---

## [1.3.0] — 2026-03-25

### Added

- **Semantic search with embedding support** (`src/embeddings.ts`, `src/embed-sync.ts`) — opt-in vector-based search using Voyage AI or OpenAI embedding APIs. Graceful degradation: no API key = FTS-only, no behavior change.
  - **Two providers:** Voyage AI `voyage-3-lite` (free, 512-dim) and OpenAI `text-embedding-3-small` ($0.02/MTok, 1536-dim). Provider abstraction makes adding new backends trivial.
  - **Hybrid recall re-ranking:** When embeddings are available, `recall()` combines FTS BM25 scores with cosine similarity using configurable weights (default: FTS 0.4, semantic 0.6). Configurable via `SEMANTIC_WEIGHT` env var.
  - **Minimum similarity threshold:** Default 0.3 — filters noise from semantic results when no atoms genuinely match. Configurable via `MIN_SIMILARITY` env var.
  - **SQLite storage:** Vectors stored as Float32Array BLOBs in `atom_embeddings` table (schema v4). FK cascade on atom deletion. Body hash (SHA-256) for staleness detection — atoms are only re-embedded when content changes.
  - **KNN search:** In-memory cosine similarity over stored vectors. Capped at 10K embeddings with warning; `ORDER BY rowid DESC` for recency bias at scale.
  - **CLI integration:** `mk remember` auto-embeds new atoms (warns on failure when provider configured). `mk reindex --embed` batch-embeds all atoms. `mk status` shows embedding count and model.
  - **MCP integration:** `mk_recall` tool now uses `recallWithEmbeddings()` for automatic semantic re-ranking.
  - **`recallWithEmbeddings()`** — async wrapper that embeds the task query and passes the vector to `recall()` for hybrid ranking. Falls back to FTS-only on any error.
  - Exports: `embedText`, `embedBatch`, `getEmbeddingConfig`, `cosineSimilarity`, `serializeVector`, `deserializeVector`, `atomToEmbeddingText`, `embedAtom`, `embedAllAtoms`, `semanticSearch`, `semanticSearchSync`, `recallWithEmbeddings`, `storeEmbedding`, `getAllEmbeddings`, `isEmbeddingStale`, `embeddingStats`.

- **API key fallback:** `getEmbeddingConfig()` falls back to `OPENAI_API_KEY` (when provider is `openai`) or `VOYAGE_API_KEY` (when provider is `voyage`) if `EMBEDDING_API_KEY` is not set. Convenience for environments that already have provider-specific keys.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `EMBEDDING_PROVIDER` | `none` | `voyage`, `openai`, or `none` |
| `EMBEDDING_API_KEY` | — | API key for the chosen provider |
| `EMBEDDING_MODEL` | per-provider | Override model name |
| `EMBEDDING_DIMENSIONS` | per-provider | Override dimensions (OpenAI only) |
| `SEMANTIC_WEIGHT` | `0.6` | Semantic score weight in hybrid ranking (0-1). FTS weight = 1 - this value |
| `MIN_SIMILARITY` | `0.3` | Minimum cosine similarity to include in semantic results |

### Tests

- 28 new tests in `test/embeddings.test.ts`: vector math (6), serialization (3), atomToEmbeddingText (4), config resolution (4), storage CRUD (5), KNN search (3), hybrid recall (2), embedding cleanup on removeFromIndex (1).

---

## [1.2.0] — 2026-03-25

### Added

- **`mk wander` — spreading activation for associative memory exploration** (`src/wander.ts`, `src/cli/mk.ts`) — Tier 1 (no LLM) graph walk through the tag co-occurrence network. ACT-R-inspired base-level activation with recency weighting, lateral inhibition, and collision detection between atoms with high tag Jaccard dissimilarity (> 0.7). Pure computation — runs in <30ms for 200 atoms.
  - `wander(options)` — index-backed (SQLite). Requires `mk reindex`. Reuses module-level connection cache.
  - `wanderFromFiles(options)` — file-scan fallback. No SQLite needed. Slower but works anywhere.
  - `mk wander` CLI with `--seed`, `--tags`, `--steps`, `--threshold`, `--top-k`, `--decay`, `--max-collisions`, `--json` flags. Auto-falls back to file scan when no index exists.
  - Exports: `wander`, `wanderFromFiles`, `WanderOptions`, `WanderResult`, `Collision`, `ActivatedAtom`.
- **Agent-facing documentation** — three new docs for agents setting up memory-kernel:
  - `docs/agent-session-loop.md` — standard recall→remember→wander→render lifecycle
  - `docs/agent-quickref-container.md` — container paths, commands, /tmp workaround
  - `docs/agent-quickref-native.md` — native setup, drift pre-filter, mk binary resolution
- **`/mk-doctor` skill** (`container/skills/mk-doctor/SKILL.md`) — 9-step self-diagnostic for both container and native agents. Auto-detects environment, checks directory structure, runs `mk doctor`, validates index, CLAUDE.md, event log, mounts, and cron.
- **Bootstrap CLAUDE.md** — `renderClaudeMd()` now produces getting-started guidance when memory is empty (0 atoms), so the first session isn't blank.
- **README rewrite** — reduced from ~17k tokens to ~2.5k tokens. Dual-audience (human + agent). "Agents — start here" section links to all agent docs.

### Tests

- 32 new tests: 25 unit tests (seeding, spreading, lateral inhibition, threshold pruning, decay, collision detection, conflict exclusion, edge cases), 5 stress tests (100-200 atoms, dense graphs, topK bounds), 2 conflict atom exclusion tests.
- Total: 603 tests passing across 27 files.

---

## [1.1.2] — 2026-03-18

### Fixed

- **`CONTRIBUTING.md`** — corrected maintainer email address, updated license validity year, and added lint instructions for contributors.

---

## [1.1.1] — 2026-03-18

### Added

- **`CODE_OF_CONDUCT.md`** — Contributor Covenant v2.1 with `mainion@proton.me` enforcement contact.
- **`CONTRIBUTING.md`** — dev setup, workflow, Conventional Commits guide, code style, and bug reporting instructions.
- **`SECURITY.md`** — supported versions table, private vulnerability reporting (GitHub advisory + `mainion@proton.me`), response timeline, and scope definition.
- **`NOTICE`** — Apache-2.0 attribution notice required by the license.

### Changed

- **`LICENSE`** — replaced MIT license text with Apache License 2.0.
- **`README.md`** — updated license section to reference Apache-2.0; added status badges (license, npm version, tests, security policy).
- **`package.json`** — `"license"` field updated from `"MIT"` to `"Apache-2.0"`.

---

## [1.1.0] — 2026-03-17

### Added

- **`mk render` CLI command** (`src/render.ts`, `src/cli/mk.ts`) — promotes the one-off `scripts/render-claude-md.ts` script to a first-class public command. Outputs a token-budgeted `CLAUDE.md` by running `recall()` with the configured budget and applying privacy filtering before writing the file.
- **`container/skills/mk-memory-setup/SKILL.md`** — step-by-step agent skill for setting up memory-kernel inside a Docker/NanoClaw environment, covering container configuration, mounts, cron scheduling, and post-setup verification.
- **`container/skills/mk-memory-setup/README.md`** — companion README for the `mk-memory-setup` skill with usage notes.
- **`docs/sdk-reference.md`** — full SDK reference extracted from README for easier linking and navigation.
- **`docs/nanoclaw-integration.md`** — NanoClaw integration guide extracted from README, covering sparse-checkout install, container mounts, and `mk render` cron setup.

### Fixed

- **`mk render` token budget** — `render.ts` now passes the `recall()` result through to enforce the configured token budget and privacy filtering; previously the budget was set but the filtered output was not used.
- **`container/skills/mk-memory-setup/SKILL.md`** — removed defunct Step 5 (manual `memory-kernel` clone); renumbered remaining steps; replaced deprecated `npx tsx` script invocations with `mk render`; removed stale `KERNEL_CODE_DIR` references.
- **`docs/nanoclaw-integration.md`** — replaced non-existent `skill/mk-memory-setup` branch reference with sparse-checkout from `main`.

### Modified

- **`package.json`** — version `1.0.1` → `1.1.0` (`mk render` is now stable public API).
- **`README.md`** — updated `mk render` usage section; extracted SDK reference and NanoClaw guide into dedicated `docs/` files.

---

## [1.0.1] — 2026-03-15

### ⚠️ Breaking Changes

- **MCP tool names renamed** — All 8 MCP server tool names now carry the `mk_` prefix for namespace clarity and consistency with the native OpenClaw plugin. Update any MCP client config that references the old names:

  | Old name | New name |
  |---|---|
  | `remember` | `mk_remember` |
  | `recall` | `mk_recall` |
  | `reflect` | `mk_reflect` |
  | `merge` | `mk_merge` |
  | `gc` | `mk_gc` |
  | `list_conflicts` | `mk_list_conflicts` |
  | `resolve_conflict` | `mk_resolve_conflict` |
  | `get_context_bundle` | `mk_get_context_bundle` |

  **Migration**: Edit any MCP client config (e.g., `claude_desktop_config.json`, `.cursor/mcp.json`, `~/.openclaw/openclaw.json`) that calls the old tool names.

### Added

- **`docs/openclaw-mcp.md`** — Zero-code MCP quick-start for OpenClaw.
- **`docs/migration.md`** — Migration guide covering 5 paths: raw markdown, pre-v1.0 upgrade, external memory systems, from scratch, multi-agent merge.
- **`docs/when-to-choose-memory-kernel.md`** — Decision guide: when memory-kernel is the right tool vs. overkill.
- **`packages/openclaw-memory-kernel/`** — Native OpenClaw plugin (`openclaw-memory-kernel@0.1.0`): 4 tools (`mk_remember`, `mk_recall`, `mk_reflect`, `mk_context_bundle`), TypeBox schemas, SKILL.md routing guide, INSTALL.md.

---

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
