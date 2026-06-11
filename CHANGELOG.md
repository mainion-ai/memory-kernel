# Changelog

All notable changes to this project will be documented in this file.

> [!IMPORTANT]
> **License change — MIT → Apache-2.0**
> Effective v1.1.2, memory-kernel is distributed under the [Apache License 2.0](LICENSE) instead of the MIT License.
> See [NOTICE](NOTICE) for full attribution. Apache-2.0 adds patent termination clauses not present in MIT — review the license if this affects your use case.

## [Unreleased]

### Changed — releases now publish CHANGELOG notes + an Announcements discussion

`release.yml`'s main-package job now derives its GitHub-release notes from the curated `CHANGELOG.md` `## [X.Y.Z]` section (via a new shared `scripts/changelog-section.sh`) instead of PR auto-notes, and posts a linked announcement in the public repo's Discussions **Announcements** category (`gh release create --notes-file … --discussion-category "Announcements"`; needs the new `discussions: write` workflow permission). `scripts/sync-to-public.sh` was migrated onto the same extractor so the CHANGELOG-section logic lives in exactly one place.

- **`scripts/changelog-section.sh`** (new) — extract one version's CHANGELOG section; `--body-only` omits the heading. +9 tests (`test/changelog-section.test.ts`).
- **`.github/workflows/release.yml`** — release notes from CHANGELOG; Announcements discussion; `discussions: write`.
- **`scripts/sync-to-public.sh`** — reuse the shared extractor (sibling-relative resolution via `SCRIPT_DIR`).

CI / release-infra only — no version bump.

### Fixed — Dependabot auto-merge workflow could not read status checks

The `.github/workflows/dependabot-auto-merge.yml` poll loop queries the PR's `statusCheckRollup`, which GitHub resolves through `commit.statusCheckRollup`. Reading that nested rollup needs `checks: read` and `statuses: read`, but the workflow's `permissions:` block granted only `contents: write` + `pull-requests: write`. Under the Dependabot-context `GITHUB_TOKEN` (undeclared permissions default to none), the GraphQL drill-down was denied with `Resource not accessible by integration`, so the job failed on its first poll and **every** Dependabot PR fell back to manual merge (e.g. #239).

- **`.github/workflows/dependabot-auto-merge.yml`** — adds `checks: read` and `statuses: read` to the workflow `permissions:` block. No `run:` step or trigger change.

No library code, tests, or build outputs change — CI-infrastructure-only fix, no version bump.

## [1.30.0] — 2026-06-11

Draft-atom lifecycle (#274) — the mk-side prerequisite for #268's session-end extract. Two halves: a recall/render visibility gate (Gap 1) and tiered promotion in `reflect` (Gap 2).

### Added — auto-extracted drafts excluded from recall/render by default (#274 Gap 1)

Session-end extract (#268) lands `status: draft` atoms tagged `auto-extracted`. Those are unvetted, but recall ranked `draft` just below `active`, so they entered live context (and #267's recall-inject) immediately. Recall, the SQLite index query, and fill-mode render now **exclude `status: draft` atoms that carry the `auto-extracted` tag** by default.

- Scoped to the `auto-extracted` tag, **not** all drafts — hand-authored draft beliefs (the developmental-arc resting state, held in draft by Gap 2) still render. An explicit `statuses: ['draft']` filter still surfaces them for inspection.
- New opt-in: `mk recall --include-drafts`, `RecallQuery.include_drafts`, and the `mk_recall` MCP tool's `include_drafts` param (CLI / library / MCP parity).
- Three enforcement points kept in sync via a shared `AUTO_EXTRACTED_TAG` constant (`src/types.ts`, also used by the `mk extract` producer and `mk consolidate`) + a shared `isUnvettedDraft()` predicate: `recall.ts` `filterAtoms` (file-scan path), `index-db.ts` `queryIndex` (SQL path), `render.ts` fill-mode. Isolated recall inherits the exclusion (routes through `recall()`).
- +6 tests (`test/recall-draft-visibility.test.ts`). ([PR #276](https://github.com/mainion-ai/memory-kernel-dev/pull/276))

### Changed — tiered draft promotion in `reflect` (#274 Gap 2)

Replaced the old `belief → fact @ confidence 0.9` auto-promote (which converted the over-produced type — the opposite of the monoculture-fix intent) with type-tiered, **status-only** promotion (draft → active; type unchanged, no file rename):

- **fact / preference / decision:** promote after **48h** if `confidence ≥ 0.7` **and** no contradiction with an existing active atom of the same type/scope (reuses the `detectConflicts` heuristic).
- **open_question:** promote immediately (additive, no quality risk).
- **belief:** held in draft (over-produced + re-extraction drift — review-gated).
- **procedure:** held in draft (interim; the "executed-once" tool-trace signal is a separate sub-task — aspirational procedures must not auto-activate).

Promotion strips the `auto-extracted` tag (matching `mk consolidate`, so a reflect-promoted atom isn't left looking unvetted). The contradiction check shares a single `atomsConflict()` predicate + `CONFLICT_CONFIDENCE_GAP` constant with `detectConflicts` (no drift between the promotion gate and the detector). The `atom_promoted` event now carries `{ from_status, to_status, type }` (was `{ from_type, to_type }`). +11 tests (`test/reflect-tiered-promotion.test.ts`); ~10 existing tests that asserted the old belief→fact rule updated to the new semantics. Closes #274; unblocks #268's fork-side `MK_EXTRACT_ON_END=1`. ([PR #277](https://github.com/mainion-ai/memory-kernel-dev/pull/277))

## [1.29.1] — 2026-06-11

### Fixed — `memory-kernel` bin alias was missing

The package registered two bin entries (`mk` and `mk-mcp`) but not a `memory-kernel` alias matching the package name. Running `npx memory-kernel` — or installing globally and calling `memory-kernel` — failed with `command not found`. Added `memory-kernel` to the `bin` field, pointing at `dist/cli/mk.js`; it is an alias for the canonical `mk` binary (`mk-mcp` remains the MCP-server entry).

## [1.29.0] — 2026-06-10

### Added — `KNOWLEDGE/` canonical dir + `mk observe --mode document` (#244)

A first-class place for finished knowledge docs (design docs, research notes, reports) to flow into the atom store without a manual `mk remember`.

- **Store layout:** `mk init` now creates `KNOWLEDGE/` (added to the canonical `DIRS`), a `KNOWLEDGE/draft/` subdir (never observed — scratch space), and a `KNOWLEDGE/README.md` documenting the convention. `INDEX.md` references it.
- **`mk observe --mode <conversation|document>`:** new flag (default `conversation`, unchanged behavior). `--mode document` swaps in a document-focused observer prompt that extracts the decisions/conclusions a finished doc *establishes* (vs. what *happened* in a conversation). Output still appends to `observations.md` — atom creation stays downstream in `reflect`/`remember` (no direct atom writes).
- **Docs:** `/mk-memory-setup` Step 6c (convention + a seeded standing-preference atom), README (On-Disk Layout + the `mk observe` row), `docs/agent-session-loop.md` (KNOWLEDGE capture), `mk-doctor` Step 3 (expected dirs).
- +5 tests (`observe.test.ts` document-mode + prompt framing; `store-direct.test.ts` KNOWLEDGE scaffold + re-init idempotency).

Deferred follow-up (#256): the nightly mtime-scan observe loop in the `mk init --cron` memory-sync wrapper (`generateCronWrapper()` + `.knowledge-manifest` + `draft/` skip).

### Added — `orphan-prose-refs` doctor check (#243)

New warn-level `mk doctor` check that flags atoms whose **body prose** names another atom by ID (e.g. "Extends BELI-…") where that atom **exists in the store** but the reference is **not** wired as a formal `frontmatter.relations[].target`. These are disconnected islands in the atom graph — connected in human-readable text, invisible to graph traversal / Obsidian.

- Scans all non-archived atoms (`listAtoms` = ENTITIES + CONFLICTS); the referenced ID must exist (ENTITIES + CONFLICTS + ARCHIVE, plus the shared namespace in per-agent mode) so a dead/typo'd ref isn't mistaken for an unwired one. Reuses `buildAllIds` (now exported from the `atom-frontmatter` check).
- Relation words matched case-insensitively against `RELATION_TYPES`; ID prefixes `BELI`/`FACT`/`DECI`/`PREF`/`OPEN`. Self-references and dead refs are skipped; repeated refs to the same target dedupe.
- **Detection-only** — inferring the correct relation type from prose is ambiguous, so no `fix()` in v1; the operator wires the relation manually (or via `mk relink`). Distinct from `atom-frontmatter`'s `broken-relation-ref` (which catches the inverse: a formal relation whose target is missing).
- `src/doctor/checks/orphan-prose-refs.ts` + `run.ts` registry line; `skills/mk-doctor/SKILL.md` Step 4 updated. +12 tests (`test/doctor-orphan-prose-refs.test.ts`).

MINOR — the new `mk observe --mode` flag + `KNOWLEDGE/` dir from #244 set the version; the #243 doctor check (no public API) rides along.

## [1.28.5] — 2026-06-09

### Fixed — `callClaude` could crash on an unhandled `EPIPE` when the child exits early

`callClaude` (`src/llm.ts`) piped the user prompt to the child's stdin (`proc.stdin.write`) without an `error` listener on `proc.stdin`. When the spawned `claude` process exits before reading stdin, the write lands on a closed pipe and raises `EPIPE`; with no listener, Node promotes it to an unhandled exception that crashes the whole process. This surfaced as an **intermittent** Node-24 CI failure (the `llm-spawn-timeout` "child exits 0 immediately" fixture races the child closing stdin) — the run failed with `write EPIPE` even though every test passed. The `close`/`error` handlers on the child already govern the call's real outcome, so the stdin write error is benign and is now swallowed via `proc.stdin.on('error', …)`.

- **`src/llm.ts`** — add a benign `error` listener on `proc.stdin` before writing the prompt.
- **`test/llm-spawn-timeout.test.ts`** — regression test: a fixture that closes its stdin read-end and exits 0, plus a 2 MB prompt to reliably force the write onto the closed pipe. Reproduces the exact `EPIPE` unhandled error without the fix; resolves cleanly with it. (+1 test)

**Version bump:** PATCH (1.28.4 → 1.28.5) — internal robustness fix, no public API change.

## [1.28.4] — 2026-06-09

### Added — `atom-frontmatter` + `atom-relations-section` doctor checks (#227)

Two new `mk doctor` checks covering semantic constraints on atom frontmatter not caught by the existing Zod schema check. They are split by concern so each `CheckResult` carries a single severity, which lets `mk doctor` count and tag errors vs warnings correctly.

**`atom-frontmatter`** — referential integrity + filename consistency (`severity: 'error'`):
- `broken-relation-ref` — `relations[].target` references a non-existent atom ID (scans `ENTITIES/`, `CONFLICTS/`, and `ARCHIVE/`; in per-agent isolation mode the shared namespace is scanned too, so a valid agent→shared edge is not falsely flagged)
- `id-mismatch` — frontmatter `id` does not match the file's basename (sans `.md`)
- `duplicate-id` — two or more atoms in `ENTITIES/`/`CONFLICTS/` declare the same `id`

**`atom-relations-section`** — section/frontmatter drift (`severity: 'warn'`):
- `stale-relations-section` — a `<!-- mk:relations -->` section exists but is missing an outgoing edge present in `frontmatter.relations[]` (i.e. the section was not regenerated after a manual frontmatter edit)

Neither check ships a `fix()` yet — referential/filename errors need human review, and section regeneration (a `renderRelationsSection` round-trip + file write) is deferred to its own PR.

The relations-section parser lives beside its renderer as a new `parseRelationsSection()` in `src/obsidian.ts` (inverse of `renderRelationsSection`), so the bullet format and the underscore↔hyphen display conversion (`relationTypeToDisplay` / `relationDisplayToType`) are defined in one place. It anchors on the *last* sentinel (the section is always at EOF) and strips Obsidian display aliases (`[[target|alias]]` → `target`). These helpers are not re-exported from the package entrypoint — no new public API.

**Also:** extended `ATOM_SCHEMA_MIGRATIONS` (the `atom-schema` auto-fix path) with `references → related` (an untyped link, no directionality to lose). The five directional reverse types (`referenced_by`, `extended_by`, `related_by`, `supported_by`, `applied_from`) map to `null` instead — they surface in `remaining[]` for manual review rather than silently collapsing edge direction under `mk doctor --fix`.

Tests **1679 → 1708** across 116 files.

## [1.28.3] — 2026-06-04

### Fixed — CodeQL alert #4 (`actions/missing-workflow-permissions`) — explicit `contents: read` on CI workflow

[Alert #4](https://github.com/mainion-ai/memory-kernel/security/code-scanning/4) (`medium`) flagged `.github/workflows/ci.yml` for not setting an explicit `permissions:` block on `GITHUB_TOKEN`. The workflow only does `npm ci` + `npm run build` + `npm test` — no write access needed.

- **`.github/workflows/ci.yml`** — adds workflow-level `permissions: contents: read`. No job-level overrides; every step fits within read-only scope.

No library code, tests, or build outputs change. The version bump exists solely to propagate the workflow-permissions hardening to the public mirror on the next tag push (where CodeQL re-runs and closes alert #4).

**Version bump:** PATCH — workflow file change only, no shipped-code change.

## [1.28.2] — 2026-06-04

### Fixed — CodeQL alert #3 (`js/polynomial-redos`) — defensive length cap

After v1.28.1 closed alerts #1 + #2, CodeQL filed a new [alert #3](https://github.com/mainion-ai/memory-kernel/security/code-scanning/3) against the same file (`src/classify-query.ts`). The whitespace-normalize fix from v1.28.1 makes runtime linear in practice, but CodeQL's static analysis can't dataflow-trace through `String.prototype.replace` to see that — it still flags any `.test()` call where the patterns contain multi-`\s+` structure.

- **`src/classify-query.ts`** — `countMatches()` now caps input length at `MAX_QUERY_LENGTH = 10_000` characters **before** the normalize step. CodeQL recognizes the `String.prototype.slice` length-bound as an unconditional cap on total regex work. Real-world queries are <1 KB; the 10K ceiling exists purely as a defensive bound that also protects against any *future* polynomial-prone pattern added to the file.
- **+2 regression tests** in `test/classify-query.test.ts`: (1) truncation behaviour — a temporal signal in the first 10K chars survives, a retrieval signal past the cap is invisible; (2) <50ms bound on 10MB pathological input (linear-time slice + bounded regex work). Tests **1677 → 1679**.

**Version bump:** PATCH — defensive bound, no public API change. `MAX_QUERY_LENGTH` is module-internal (not exported).

## [1.28.1] — 2026-06-04

### Fixed — Two CodeQL `high`-severity findings on the public mirror

First post-publish security pass. Both alerts were filed by GitHub Code Scanning against `mainion-ai/memory-kernel@v1.28.0` after the public release.

- **`js/incomplete-sanitization` in `src/cli/export-obsidian.ts:136`** — the YAML escape for quoted scalars escaped `"` but missed `\`. A frontmatter string value ending in a single backslash produced `"foo\"` which YAML reads as an escaped quote, leaving the string unterminated and corrupting the exported Obsidian vault file. Escape order is now backslash-first (`\\`), then quote (`\"`). `transformAtom` is now exported from `src/cli/export-obsidian.ts` to enable direct regression tests (not part of the documented SDK surface — not re-exported from `src/index.ts`).
- **`js/polynomial-redos` in `src/classify-query.ts:148`** — several classifier patterns contain multiple `\s+` (some inside alternations like `the\s+user`) which can backtrack polynomially on attacker-controlled input full of spaces. `countMatches()` now normalizes whitespace once before the test loop (`query.replace(/\s+/g, ' ')`), so each `\s+` matches exactly one space and the ambiguity is gone. Match semantics on legitimate input are unchanged (verified: single-spaced vs space-padded queries produce identical routes/types).

**+5 regression tests** — 3 in `test/classify-query.test.ts` (single-vs-padded match equivalence, tab/newline normalization, 50k-space adversarial input bounded at <100ms); 2 in `test/obsidian.test.ts` (`parseAtom` round-trip on a backslash-ending value, raw YAML scalar shape `"has:both\"and\\here"`). Total **1672 → 1677**.

**Version bump:** PATCH — security-only, no public API change. `classifyQuery` is unchanged in signature and semantics on normal input. The `transformAtom` export is in a CLI-layer file not re-exported from the package entrypoint.

## [1.28.0] — 2026-06-03

### Added — `mk extract --preference-pass` dedicated preference extraction pass ([#213](https://github.com/mainion-ai/memory-kernel-dev/issues/213))

Per-layer diagnostic (BEN-008) confirmed that the 86.7% IDK rate on preference questions is an extraction failure, not a retrieval failure: preferences were either never stored or their vocabulary was diluted into generic belief atoms during the general extraction pass (where they compete with facts, decisions, and beliefs for the `max_atoms` budget).

- **`src/extract.ts`** — exports a new `PREFERENCE_EXTRACTION_SYSTEM_PROMPT` constant and runs it as a second LLM call when `preferencePass: true`. The prompt enforces specific vocabulary preservation ("prefers quinoa and roasted vegetables for meal prep" not "enjoys healthy food"), covers all preference signal types (explicit, habitual, aversions, tool/software choices, food/drink specifics), and forces subject/preference/context structured fields on every atom. Second-pass candidates are merged with first-pass candidates via in-memory slug dedup before the reconcile loop, so on-disk slug collision detection still handles cross-run dedup as normal.
- **`src/types.ts`** — `ExtractOptions` gains `preferencePass?: boolean` (default `false`).
- **`src/cli/extract.ts`** — `mk extract` gains `--preference-pass` flag that passes through to `extractFromLog`.
- **+11 tests** in `test/extract-preference-pass.test.ts`: single vs double LLM call count; correct system-prompt routing (general vs preference-focused); second-pass atoms get preference enrichment (subject tag, structured body); dry-run correct with preference pass; in-pass slug dedup; cross-run slug dedup; preference pass error propagation; empty log early-return skips preference pass entirely.

**Version bump:** MINOR — `preferencePass` in `ExtractOptions` is new public API.

## [1.27.0] — 2026-05-31

First release after the v1.16.1 → v1.27.0 force-reset on the public mirror (per [ADR 0001](docs/decisions/0001-force-reset-public-main.md)). MINOR for the observable `mk recall` semantics change in #214; carries forward the docs/policy/privacy work that accumulated between v1.26.1 and now.

### Fixed — `mk recall` no longer returns confidently-irrelevant fallback ([#214](https://github.com/mainion-ai/memory-kernel-dev/issues/214))

Two failure modes were folded into one root cause: `queryIndex` returned all status-filtered atoms as the candidate pool, FTS only re-ranked them, atoms with no FTS hit got score 0, and the token budget filled with whatever sorted first by status priority + recency. Result: confidently-irrelevant atoms served as hallucination scaffolds, and matched queries got polluted with non-matched noise.

- **`src/recall.ts`** — when `task` is set, restrict the candidate pool to `(ftsHits ∪ semanticHits)`. When `graph_boost` is enabled, expand with 1-hop neighbours of the anchor set so legitimately-related atoms still surface. Empty anchor set + healthy FTS → return `atoms: []`. Empty anchor set + `searchFts` returned null (FTS unavailable / unparseable post-sanitisation) → file-scan degradation, unchanged.
- **`src/index-db.ts`** — `searchFts()` sanitisation extended to strip `.`, `,`, `;`, `?`, `!` (in addition to the existing FTS5 syntax chars). Pre-fix, `192.168.1.136` crashed with `fts5: syntax error near "."` and the catch block returned `null` — indistinguishable from "FTS table missing", which dropped queries into the no-FTS fallback. Post-fix, dots are stripped and the query becomes a clean OR-token match against the (similarly-tokenised) atom body.
- **`src/types.ts`** — `ContextBundle` gains an optional `recall_status?: "match" | "no_match" | "fts_unavailable"` so callers can distinguish the three outcomes without relying on `atoms.length === 0` semantics.
- **+7 regression tests** in `test/recall-issue-214-task-pool.test.ts`: no-FTS-match returns empty + `no_match`; matched query returns only matched atoms (no noise); dotted-IP query doesn't crash; no-task path preserves old full-pool behaviour; noise atoms don't pollute matched results regardless of pool size; `graph_boost: true` expands the pool with 1-hop neighbours of matched anchors (unrelated atoms still excluded); the existing status filter prevents `supersedes`-chained stale atoms from leaking into the pool via graph expansion.
- **Test-suite update**: nine pre-existing tests in `fts.test.ts`, `recall-scoring.test.ts`, `recall-temporal-decay.test.ts`, `relations.test.ts`, `embedding-knn-normalized.test.ts`, `mcp-isolation.test.ts`, `openclaw-plugin.test.ts`, and `openclaw/openclaw-like.integration.test.ts` were updated. They asserted the old fallback behaviour (off-topic atoms surfacing alongside on-topic ones); fixtures now seed bodies that actually FTS-match the test task so the underlying functionality (reservations, isolation merging, temporal decay, etc.) is exercised on a real matched pool.
- **Diagnostic note**: the original mode-2 report from internal test stores ("single keywords like `NanoClaw` return 0 atoms") does not reproduce on a clean v1.26.1 store — the indexing path was correct. The clean-store reproduction surfaced the three above bugs instead; once `no_match` becomes the new behaviour for unmatched queries, the on-store report would either resolve cleanly (the bug WAS the fallback) or surface as an honest `no_match` revealing a separate per-store indexing degradation. Either outcome unblocks diagnosis.

Full suite: **1653 → 1660** tests across 113 files.

### Privacy — Redact-list expansion for internal sync infra + operator docs

Triggered by the 2026-05-26 sync dry-run on `dryrun-2026-05-26` (workflow run succeeded in 7s; diff stat reviewed). 11 new redact entries added to `.privacy/redact-paths.txt`, grouped into two sections:

- **Internal sync + CI plumbing** (operates on `-dev`, no functional value on public): `.github/workflows/sync-on-tag.yml`, `.github/workflows/docs-hygiene.yml`, `.github/workflows/privacy-scan.yml`, `scripts/sync-to-public.sh`, `scripts/docs-hygiene-check.sh`, `scripts/privacy-scan.sh`, `test/sync-to-public.test.ts`, `test/docs-hygiene-check.test.ts`, `test/privacy-scan.test.ts`.
- **Internal operator + audit docs** (documents our setup, not user-facing reference).

Kept public (explicit decisions documented in `.privacy/audit-v1.26.0.md`):

- `docs/decisions/0001-force-reset-public-main.md` — transparency-positive for early v1.x pinners.
- `docs/dep-watchlist.md` — contributor-useful project hygiene.
- `docs/branding/social-preview.{svg,png}` — public branding.
- `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/CODEOWNERS`, `.github/ISSUE_TEMPLATE/**`, `.github/PULL_REQUEST_TEMPLATE.md` — public-facing CI/governance scaffolding, intended.

Decision rationale recorded in `.privacy/audit-v1.26.0.md` under a new "Additions 2026-05-26 (post-sync-dry-run review)" subsection, with both REDACT and explicit-RETAIN rows for symmetry.

No source changes. No version bump.

### Docs / governance — Public-repo settings doc + ruleset names + social preview ([PR #209](https://github.com/mainion-ai/memory-kernel-dev/pull/209))

Companion follow-up to the #199 decisions PR. Expands `docs/public-repo-settings.md` from a 6-section sketch into a UI-verbatim 10-subsection runbook covering rulesets, Actions, CODEOWNERS, Code-security, and General settings — each section flagging public-vs-dev deltas inline. Walks the GitHub Settings UI top-to-bottom in the order an operator clicks through.

- **Ruleset naming convention.** Public: `main: synced-only (sync-app writes)`. Dev: `main: maintainer fast-loop`. Pattern: lead with branch scope (`main:`), follow with one short intent descriptor; distinct names make the org-wide rulesets list self-explanatory at a glance.
- **`.github/CODEOWNERS`** — `@NePav @mainion-taj` (two-maintainer routing). Initial draft tried `@mainion-ai/maintainers` team routing but `mainion-ai` is a User account, not an Organization — teams aren't available. Comment in the file documents the org-conversion upgrade path.
- **`docs/branding/social-preview.svg` + `social-preview.png`** *(new)* — 1280×640 social-card asset with project title, tagline, event-stream atom motif, and footer. SVG is the design source; PNG is the upload-ready render. Re-render via `rsvg-convert -w 1280 -h 640 social-preview.svg -o social-preview.png`.
- **Doc expansions:**
  - **§1 Ruleset:** end-state bypass list with explicit keep/remove tables (Repository admin / Maintain / Write roles all "remove"; sync App + maintainer "keep"); rule-by-rule recommendations across all 12 GitHub-Ruleset toggles; target-branches walkthrough; "Two-ruleset variant (future)" appendix for stricter force-push posture when a second maintainer joins.
  - **§2 Actions:** 5 sub-sections (2a–2e) matching the UI. **Fork-PR workflows §2c flagged as security-critical** — *Send write tokens off, Send secrets off* are hard "no, ever" with the supply-chain attack class spelled out (malicious fork PR workflow → exfiltrates `MK_SYNC_APP_PRIVATE_KEY` / future `NPM_TOKEN`).
  - **§3 CODEOWNERS:** two-maintainer routing + the "why not a team" explanation + future-org-conversion upgrade path.
  - **§4 Code security and analysis:** 5 sub-sections (4a–4e) matching the UI: Advanced Security, Dependency graph, Dependabot (incl. malware alerts + grouped updates + Dependabot rules + the UI gotcha that "off" for version updates means "don't commit `dependabot.yml`"), Code scanning (CodeQL on, Copilot Autofix off), Secret Protection. Quick post-apply checklist at the end.
  - **§5 General:** 10 sub-sections (5a–5j) matching the page top-to-bottom. Notable additions: Release immutability on (with "if available" qualifier — historically Enterprise-only, rolled out to public in waves); Preserve this repository (GitHub Archive Program) on; Sponsorships off; Require sign-off on web commits off (matches no-DCO stance); auto-close issues with merged linked PRs on; "Danger Zone: don't click anything" note.
- **Public vs dev delta summaries** added across sections — confirms that only Section 1 (ruleset), Section 4 (Private vuln reporting off on dev; CodeQL optional on dev), and Section 5 (Discussions off on dev; Preserve repository N/A on private) actually differ. Most settings are identical between repos.
- **`CODING_INSTRUCTIONS.md`** hygiene table already includes `docs/public-repo-settings.md` (from PR #208) — no additional row needed.

### Docs / governance — Public-repo decisions pass ([#199](https://github.com/mainion-ai/memory-kernel-dev/issues/199) parts a + b + d + e)

Closes [#199](https://github.com/mainion-ai/memory-kernel-dev/issues/199) fully (parts c + f shipped in [PR #207](https://github.com/mainion-ai/memory-kernel-dev/pull/207)).

- **`docs/decisions/0001-force-reset-public-main.md`** *(new)* — ADR for part (a). First sync force-resets public `mainion-ai/memory-kernel` main; pre-sync HEAD (`9305088b`, v1.16.1) and earlier tag SHAs (`v1.15.0`, `v1.12.0`) preserved in the ADR for audit. Subsequent syncs are fast-forward only.
- **`docs/public-repo-settings.md`** *(new)* — operator-facing snapshot of required public-repo GitHub settings for part (b). Branch protection on `main` (require linear history, restrict pushes, allowlist the sync App, allow force-push from the App only), GHA permissions (read+write, fork PRs require approval), Dependabot + secret scanning + private vulnerability reporting all on, Wikis off, Discussions on. Single source of truth — both checklist for first apply and snapshot for ongoing audit.
- **`docs/governance.md`** *(new)* — triage doctrine (part d) and contributor-licensing stance (part e). Doctrine: direct-on-public + back-route — issues and PRs land on the public repo; the maintainer applies accepted PRs through dev with author attribution preserved. Licensing: no CLA, no DCO required; Apache-2.0 §5 inbound-licensing grant is sufficient. Code-of-Conduct reference: Contributor Covenant 2.1.
- **`CONTRIBUTING.md`** — links to `docs/governance.md` and clarifies that the inbound-licensing grant is the Apache-2.0 contribution itself (no separate signing step).
- **`RELEASING.md`** — references the ADR; "Required one-time setup" now points at `docs/public-repo-settings.md` instead of inline TODO.
- **`CODING_INSTRUCTIONS.md`** + `.privacy/public-overrides/CODING_INSTRUCTIONS.md` — Documentation hygiene table gains three rows: `docs/decisions/*.md`, `docs/public-repo-settings.md`, `docs/governance.md`.
- Release-tagging chain narrows to its terminal node: [#152](https://github.com/mainion-ai/memory-kernel-dev/issues/152) public-repo npm publish + OIDC.

### Docs / governance — Public-repo templates pass ([#199](https://github.com/mainion-ai/memory-kernel-dev/issues/199) parts c + f)

- **`.github/CODEOWNERS`** *(new)* — wildcard owner (`* @NePav`). Per-directory routing deferred until the project grows more maintainers.
- **`.github/ISSUE_TEMPLATE/bug_report.md`** *(new)* — mirrors the "Reporting Bugs" checklist from `CONTRIBUTING.md` (version via `npm ls memory-kernel`, Node, OS, repro, expected vs actual, logs).
- **`.github/ISSUE_TEMPLATE/feature_request.md`** *(new)* — what / why / sketch / out-of-scope / alternatives / related.
- **`.github/ISSUE_TEMPLATE/config.yml`** *(new)* — disables blank issues; adds a "Security vulnerability" contact link pointing at `SECURITY.md` so the public tracker doesn't get used for security reports.
- **`.github/PULL_REQUEST_TEMPLATE.md`** *(new)* — mirrors the PR checklist in `CONTRIBUTING.md` (tests, build, docs hygiene, CHANGELOG, version-bump proposal).
- **`SECURITY.md`** — adds an explicit **90-day coordinated disclosure window** ("Patch or mitigation: 90 days from acknowledgement unless otherwise agreed") so external researchers know the upper bound. Existing 48-hour ack / 7-day triage targets unchanged.
- **`CODING_INSTRUCTIONS.md`** — Documentation hygiene table gains three rows: issue/PR templates, CODEOWNERS, SECURITY.md. Same edit applied to the `.privacy/public-overrides/` swap-in.
- Partial-closes #199 (parts c + f). Deferred: (a) initial-state reconciliation, (b) public-repo GH settings (operator), (d) triage doctrine, (e) CLA/DCO stance — each gets its own follow-up.

## [1.26.1] — 2026-05-25

Transitive security fix + docs/policy carry-over from the post-v1.26.0 work. PATCH — no public API change, no source code change.

### Security

- **`qs` forced to `^6.15.2` via `package.json` `overrides`** ([Dependabot alert #33](https://github.com/mainion-ai/memory-kernel-dev/security/dependabot/33), [GHSA-q8mj-m7cp-5q26](https://github.com/advisories/GHSA-q8mj-m7cp-5q26), CVE-2026-8723, medium / CVSS 5.3). The transitive came in via `@modelcontextprotocol/sdk` → `express` → `qs@6.15.0`. The vuln is in `qs.stringify` with `arrayFormat: 'comma'` + `encodeValuesOnly: true` on null/undefined array entries — a code path not reached from this project (we don't call `qs.stringify`; the SDK's express middleware consumes `qs.parse`). Patched defensively to keep the public release surface free of open alerts ([#152](https://github.com/mainion-ai/memory-kernel-dev/issues/152)). `npm ls qs` now shows `6.15.2` at every site; `npm audit` reports 0 vulnerabilities.

### Docs / policy — Subpackage publish strategy locked ([#197](https://github.com/mainion-ai/memory-kernel-dev/issues/197))

Shipped via [PR #205](https://github.com/mainion-ai/memory-kernel-dev/pull/205) (no version bump at the time; carried forward here).

- **`packages/openclaw-memory-kernel/CHANGELOG.md`** — new file, extracted from main-package CHANGELOG entries that mention the subpackage. Versions 0.1.0 → 0.3.0 backfilled with cross-links to the carrying main-package releases.
- **`packages/openclaw-memory-kernel/INSTALL.md`** — gains a *Compat matrix* (subpackage × `memory-kernel` × `openclaw` × `@sinclair/typebox` × Node) and a *Deprecation policy* section restating the soft-warn-then-remove rule.
- **`RELEASING.md`** — gains a *Subpackage releases* section covering the independent `openclaw-memory-kernel-vX.Y.Z` tag prefix, the per-bump rule (MAJOR/MINOR/PATCH keyed off the subpackage's contract, not main-package version), the four-file release checklist for subpackage bumps, and the deprecation policy. Public-repo placement decision (Option A monorepo) recorded. Includes a "Not yet wired — sync-on-tag.yml currently triggers on `v*` only" callout pointing to #152.
- Sixth of the seven release-tagging prereqs landed; two remain ([#199](https://github.com/mainion-ai/memory-kernel-dev/issues/199) public-repo bootstrap → [#152](https://github.com/mainion-ai/memory-kernel-dev/issues/152) npm OIDC + `release.yml` port).

## [1.26.0] — 2026-05-25

**Breaking-ish runtime change** — `engines.node` floor bumped from `>=18` to `>=22.16` ([#198](https://github.com/mainion-ai/memory-kernel-dev/issues/198)). MINOR because no public npm consumers exist pre-[#152](https://github.com/mainion-ai/memory-kernel-dev/issues/152); a strict-SemVer project would treat this as MAJOR.

### Changed

- **`engines.node` is now `>=22.16`** for both the main package and `packages/openclaw-memory-kernel/`. Aligns with OpenClaw's official runtime requirement (Node 22.16+, Node 24 recommended). NanoClaw's `>=20` requirement is looser but moot — Node 20 reached end-of-life 2026-04-30 and NanoClaw users on it should upgrade regardless.
- CI matrix updated from `[18, 20]` to `[22, 24]`. Both Node 18 (EOL 2025-04-30) and Node 20 (EOL 2026-04-30) are now out of support and no longer tested.
- `CONTRIBUTING.md` prerequisite + `README.md` install section updated; `RELEASING.md` gains a SemVer guidance note on engine bumps.

### Out of scope (follow-ups)

- Adopting Node 22+ built-ins (`fetch`, `node:test`, `node:sqlite`, stable `--watch`) in the codebase. Possible once this floor lands; intentionally not bundled with the engine bump.
- Re-evaluating [#177](https://github.com/mainion-ai/memory-kernel-dev/issues/177) (`prebuild-install` deprecation watch). Node 22's stable `node:sqlite` could obviate the `better-sqlite3` dependency entirely — separate experiment.

## [1.25.2] — 2026-05-25

Tier-3 survivors bundle — closes the three issues left after the 2026-05-21 four-bundle drain. PATCH because the only code change ([#176](https://github.com/mainion-ai/memory-kernel-dev/issues/176)) is a behaviour-preserving internal refactor; [#174](https://github.com/mainion-ai/memory-kernel-dev/issues/174) and [#177](https://github.com/mainion-ai/memory-kernel-dev/issues/177) are docs-only.

### Changed

- [#176](https://github.com/mainion-ai/memory-kernel-dev/issues/176) — Removed the `gray-matter` dependency. Atom + episode frontmatter parsing now goes through a thin internal splitter (`src/internal/frontmatter.ts`) backed by the existing `js-yaml@4.x` direct dep. Result: `npm ls js-yaml` shows only `js-yaml@4.x` (the transitive `js-yaml@3.x` from gray-matter is gone). The new module mirrors gray-matter's `parseFrontmatter(raw) → { data, content }` surface so no caller had to change shape. Benchmark on the 100-atom workload (`npm run bench`): recall p95 39.38 ms, well under the 50 ms target.
  - Internal-only — `src/internal/` is not exported from the package entrypoint. PATCH.

### Docs

- [#174](https://github.com/mainion-ai/memory-kernel-dev/issues/174) — New canonical statement of the "files are truth, index is derived cache, `entity_triples` is the exception" invariant in [`docs/invariants.md`](docs/invariants.md). Cross-linked from `CONTRIBUTING.md`, `README.md`, `docs/migration.md`, `docs/agent-quickref-{native,container}.md`, `docs/host-integration-doctrine.md`, `scripts/activate-memory.ts`, and the `src/index-db.ts` header (which previously had the only inline write-up).
- [#177](https://github.com/mainion-ai/memory-kernel-dev/issues/177) — New [`docs/dep-watchlist.md`](docs/dep-watchlist.md) capturing the upstream `prebuild-install` deprecation warning emitted by `better-sqlite3`'s install path. Documents revisit triggers and acceptance criteria so the watch item lives next to the rest of the project docs rather than as a long-lived GitHub issue. Cross-linked from `CONTRIBUTING.md` under a new "Dependency hygiene" sub-heading.

### Tests

- +14 in [`test/internal-frontmatter.test.ts`](test/internal-frontmatter.test.ts) covering edge cases that previously came for free with `gray-matter`: no-fence, empty input, empty frontmatter block, body containing `---`, CRLF line endings, leading UTF-8 BOM (including in the no-fence fallthrough — see PR #193 review), opening fence with no terminating newline, missing closing fence, invalid YAML, scalar/array frontmatter (rejected), nested structures.
- Total **1617 → 1631**.

## [1.25.1] — 2026-05-24

`mk doctor --fix` Phase 2 ([#191](https://github.com/mainion-ai/memory-kernel-dev/issues/191)) — atom-schema migrations. PATCH because no new public CLI flags or exported APIs; `--fix`/`--dry-run` already shipped in v1.25.0 and this release extends what they normalise.

### Added

- `atom-schema` doctor check now exposes a structured probe (Phase 2 commit 1) — `mk doctor --fix --dry-run --json` and `--fix --json` both report the actual legacy value at each failing Zod path under `fixes[].remaining[]`. Survey-mode in commit 1 emitted "no migration registered" for every failure; commit 2 below wires those values into an actual migrations table.
- `mk doctor --fix` now auto-migrates known legacy enum values for atoms (Phase 2 commit 2). The seeded migrations table (`src/doctor/checks/schema-migrations.ts`) covers the examples called out in the issue body plus values surveyed from a real operator store (taj, 2026-05-24): `classification: PUBLIC_FRIENDLY → PUBLIC`, `classification: PRIVATE → PERSONAL`, `status: obsolete → archived`, `status: deprecated → archived`, `relations[].type: caused-by → caused_by`, `relations[].type: applied-to → applied_to`. Unknown legacy values stay in `remaining[]`. Structural failures (e.g. `relations[].target = undefined`, including the legacy `- supersedes: <ID>` shorthand form inside `relations:` arrays) are never auto-migrated and stay in `remaining[]` for manual review. A `.bak` is written alongside each modified atom before the rewrite; if a `.bak` already exists, a timestamp-suffixed fallback name is used so a prior backup is never overwritten. `--dry-run` reports "would migrate …" without touching disk.
- Every `fixes[].applied[]` line for the atom-schema check is now tagged with a leading `[migration]` or `[normalization]` label. `[migration]` lines are the enum mapping changes from the migrations table. `[normalization]` lines are canonical-serialization side effects that the `--fix` rewrite picks up because every atom modification goes back through `serializeAtom()` — currently recognised: comma-joined `scope.tags` strings split into separate items, top-level `tags:` promoted from `scope.tags` (Obsidian compatibility), and the `<!-- mk:relations -->` Obsidian section appended for atoms with relations. Anything else surfaces as a generic "frontmatter re-serialised to canonical key order / formatting" normalisation note. Operators can distinguish migration intent from incidental cleanup directly from the output without diffing the `.bak`.

### Known gaps (tracked separately)

- Atoms missing the `status` frontmatter field entirely fail at the `parseAtom()` layer before the schema check sees them. `listAtoms()` emits a stderr warning and skips them; the migrations table can't currently reach them. Tracked as a follow-up to #191.
- Legacy `relations: [- supersedes: <atom-id>]` shorthand (top-level keyed entries inside a `relations:` array) surfaces as two `<undefined>` structural failures per entry rather than a value-level migration target. A shape-level rewriter would be needed.

## [1.25.0] — 2026-05-24

### Added

- `mk doctor --fix` and `--dry-run` flags ([#157](https://github.com/mainion-ai/memory-kernel-dev/issues/157), Phase 1) — auto-remediate three classes of non-destructive findings:
  - `store-schema` — calls `reindex(memoryDir)` when `.memory-index.db` user_version is stale.
  - `store-permissions` — `chmod 0o600` on the index DB and any SECRET-classified atom file whose mode drifted (skipped on win32).
  - `render-config` — writes a default `render.yaml` for any agent dir missing it (refuses to overwrite an invalid file).
  - `--dry-run` previews what would change without writing; alone (without `--fix`) it is a soft no-op.
  - JSON output is additive: existing `{healthy, issue_count, issues, checks}` shape is unchanged; a new top-level `fixes[]` array carries the per-check outcome with a `dry_run` flag.
  - Exit codes for `--fix`: `0` (all fixable resolved), `1` (fixes applied, unfixable issues remain), `2` (a fix threw or an unfixed error-severity issue persists). `--dry-run` mirrors plain-doctor exit codes.
- Phase 2 (`atom-schema` migrations table) deferred to a follow-up PR after surveying real legacy values via `--fix --dry-run`.

## [1.24.3] — 2026-05-21

Tier 3 themed bundles — closing out 18 Tier-3 issues from the
2026-05-16 system review across four bundled PRs. PATCH because none
of the bundles add public API. The new `src/cli/cli-util.ts` and
`src/cli/atom-lookup.ts` helpers are internal to the CLI layer and not
re-exported from the package entrypoint.

### Bundle A — recall cluster ([PR #184](https://github.com/mainion-ai/memory-kernel-dev/pull/184))

- [#112](https://github.com/mainion-ai/memory-kernel-dev/issues/112) — `greedyFill`: `break` → `continue` on oversized atom so smaller atoms further down the score list can still fit the remaining budget.
- [#113](https://github.com/mainion-ai/memory-kernel-dev/issues/113) — Reject NaN in `query.type_weights` at entry; explicit throw with a clear message rather than silent sort corruption.
- [#114](https://github.com/mainion-ai/memory-kernel-dev/issues/114) — Memoize `JSON.stringify(frontmatter)` via `WeakMap<AtomFrontmatter, string>` for token counting.
- [#115](https://github.com/mainion-ai/memory-kernel-dev/issues/115) — Deduct episode tokens from the atom budget when `include_episodes` is set.
- [#116](https://github.com/mainion-ai/memory-kernel-dev/issues/116) — `isolation-recall.ts`: subtract view (INDEX/HANDOFF/CONSTRAINTS) tokens from `maxTokens` cap.

### Bundle B — CLI cleanup ([PR #183](https://github.com/mainion-ai/memory-kernel-dev/pull/183))

- [#121](https://github.com/mainion-ai/memory-kernel-dev/issues/121) — Extract `exitWithError` to `src/cli/cli-util.ts`; remove the 11 per-file copies.
- [#172](https://github.com/mainion-ai/memory-kernel-dev/issues/172) — Add `--json` flag and `exitWithError` plumbing to `bootstrap-events`, `reindex`, `merge`, `import`, `migrate-relations`, `relink`, `render` (the 7 commands that lacked it).
- [#163](https://github.com/mainion-ai/memory-kernel-dev/issues/163) — `test/cli-json.test.ts`: pin `HOME` and `USERPROFILE` in the `mk()` helper's env block so doctor's wrapper-drift check doesn't leak the host's deployed wrapper into the test.
- [#122](https://github.com/mainion-ai/memory-kernel-dev/issues/122) — Clarify `--from` semantics across `merge` / `replay` / `import`: `replay --from` now accepts both file and directory (auto-locates `events.ndjson`); `merge` stays dir-only; `import` stays file-only (semantic differences are real and documented).
- [#123](https://github.com/mainion-ai/memory-kernel-dev/issues/123) — `render` gains `-d, --dir` and `-o, --output` flags; positional form kept as deprecated fallback with stderr warning.

### Bundle C — schema / event-log invariants ([PR #182](https://github.com/mainion-ai/memory-kernel-dev/pull/182))

- [#108](https://github.com/mainion-ai/memory-kernel-dev/issues/108) — `schema.ts`: enforce `ttl_days >= 1` (reject 0).
- [#109](https://github.com/mainion-ai/memory-kernel-dev/issues/109) — Add `conflict_resolved` to `MUTATION_ACTIONS` so `compactLog` doesn't over-prune those events.
- [#110](https://github.com/mainion-ai/memory-kernel-dev/issues/110) — Conflict event `atom_snapshot` field now stores the full atom (frontmatter + body), not stringified frontmatter alone.
- [#111](https://github.com/mainion-ai/memory-kernel-dev/issues/111) — `MemoryEvent.schema_version`: convert to discriminated union for downstream narrowing.
- [#119](https://github.com/mainion-ai/memory-kernel-dev/issues/119) — `episodes.ts`: preserve `started_at` on repeated `writeEpisode` (don't overwrite with new timestamp).
- [#120](https://github.com/mainion-ai/memory-kernel-dev/issues/120) — `classify-query.ts`: deterministic tie-break in `inferredType` (stable lexicographic secondary key).

### Bundle D — misc internal ([PR #181](https://github.com/mainion-ai/memory-kernel-dev/pull/181))

- [#70](https://github.com/mainion-ai/memory-kernel-dev/issues/70) — Extract duplicated `findAtomFile` from `relate.ts` / `supersede.ts` to new `src/cli/atom-lookup.ts`.
- [#117](https://github.com/mainion-ai/memory-kernel-dev/issues/117) — `relink.ts`: hoist concept-pattern regex compilation out of the per-atom inner loop (was quadratic on the write path).
- [#118](https://github.com/mainion-ai/memory-kernel-dev/issues/118) — `enrich-relations.ts`: cap LLM `reasoning` field at 2000 chars with truncation marker.
- [#124](https://github.com/mainion-ai/memory-kernel-dev/issues/124) — Mark `assertWithinDir`, `writeFileAtomic`, `openIndex`, `closeIndex` as `@internal` via JSDoc.

### Tests

- `npm test` — **1558/1558** pass locally (1511 v1.24.2 baseline + 47 across the four bundles: 17 A + 15 B + 10 C + 5 D).

## [1.24.2] — 2026-05-20

Month-2 Wave 3 of the post-Sprint-3 remediation plan — three independent
hygiene + coverage items shipped in parallel ([#104](https://github.com/mainion-ai/memory-kernel-dev/issues/104),
[#105](https://github.com/mainion-ai/memory-kernel-dev/issues/105),
[#106](https://github.com/mainion-ai/memory-kernel-dev/issues/106)).
PATCH because no public-API additions.

### Added — direct test coverage for embed-sync / event-log / migrate / store ([#104](https://github.com/mainion-ai/memory-kernel-dev/issues/104))

- Four new test files (\`test/embed-sync.test.ts\`,
  \`test/event-log-direct.test.ts\`, \`test/migrate-direct.test.ts\`,
  \`test/store-direct.test.ts\`) add **+68 direct tests** for modules
  previously covered only through integration paths. Coverage focuses on
  error paths and edge cases an internal system review flagged —
  \`assertWithinDir\` traversal attacks, \`writeFileAtomic\` tmp
  cleanup on rename failure, the PR-12 \`0o600\` mode invariant, the
  PR-13 \`appendEvent\` lock interaction, the PR-9 bulk-load path, and
  \`migrate\`'s partition / fallback strategies under \`MK_ISOLATION\`.

### Changed — packaging metadata hygiene ([#105](https://github.com/mainion-ai/memory-kernel-dev/issues/105))

- Both \`package.json\` files now declare \`"engines": { "node": ">=18" }\`
  to match the CI matrix (Node 18 + 20).
- \`packages/openclaw-memory-kernel/package.json\` gains a \`"files": [...]\`
  allowlist (dist + plugin manifest + skills + INSTALL.md), shrinking
  \`npm pack\` from 29.8 kB / 8 files down to 18.8 kB / 6 files. Pre-fix,
  the published tarball would have shipped \`src/index.ts\` and
  \`tsconfig.json\`.
- Root \`tsconfig.json\` switched from \`Node16\` to \`NodeNext\` for both
  \`module\` and \`moduleResolution\`, matching the subpackage's
  pre-existing configuration. No code changes required.
- gray-matter (unmaintained, ships js-yaml 3.x transitively) and
  better-sqlite3's deprecated \`prebuild-install\` are acknowledged for
  now; replacement / migration tracked in [#176](https://github.com/mainion-ai/memory-kernel-dev/issues/176)
  and [#177](https://github.com/mainion-ai/memory-kernel-dev/issues/177).

### Changed — \`@sinclair/typebox\` moved to peerDependencies (subpackage breaking)

- In \`packages/openclaw-memory-kernel\`, \`@sinclair/typebox\` is no longer
  a runtime dependency; it is now a \`peerDependencies\` requirement
  (\`^0.34.0\`, non-optional). Consumers of the \`openclaw-memory-kernel\`
  plugin must install typebox themselves. This is a breaking change
  for the **subpackage only** — its version bumps **0.2.0 → 0.3.0**.
  The main \`memory-kernel\` package is unaffected.

### Docs — \`entity_triples\` preservation invariant documented ([#106](https://github.com/mainion-ai/memory-kernel-dev/issues/106))

- \`src/index-db.ts\`'s file-level header now spells out the exception to
  the "files are source of truth" framing: \`entity_triples\` is
  LLM-extracted at write time and not derivable from atom markdown
  alone. Reindex preserves it via a \`_saved_triples\` TEMP-table
  snapshot mechanism. Embeddings get the same treatment for a different
  reason (cost, not derivability). Project-wide invariant formalization
  tracked in [#174](https://github.com/mainion-ai/memory-kernel-dev/issues/174).

## [1.24.1] — 2026-05-20

Month-2 Wave 2 of the post-Sprint-3 remediation plan — three independent
API-contract / performance / observability fixes shipped in parallel
([#101](https://github.com/mainion-ai/memory-kernel-dev/issues/101),
[#102](https://github.com/mainion-ai/memory-kernel-dev/issues/102),
[#103](https://github.com/mainion-ai/memory-kernel-dev/issues/103)).
PATCH because no public-API additions — all new helpers are `@internal`.

### Fixed — `observations.md` double-append on retry ([#103](https://github.com/mainion-ai/memory-kernel-dev/issues/103))

- `observeConversation` in `src/observe.ts` now dedups against the
  `## Session ${date}` header before appending. Pre-fix, a retry after
  a crash mid-LLM-call (observer wrote, process died before exit, user
  re-ran the same command) double-appended the same session block.
  Post-fix, the append is skipped and a stderr warning is emitted on
  dedup hit: `mk: warning: observations.md already contains "..." —
  skipping append (idempotent retry)`. PR-12's `0o600` chmod on the
  successful-write path is preserved (regression-guarded on POSIX).
  Internal helper `appendObservationSection` extracted for testability;
  not re-exported through `src/index.ts`.

### Fixed — `tagDistance` BFS frontier unbounded growth ([#102](https://github.com/mainion-ai/memory-kernel-dev/issues/102))

- `tagDistance` in `src/wander.ts` now caps BFS frontier expansion at
  500 nodes per step. Pre-fix, a hub tag (one tag shared by thousands
  of atoms) could pull the entire shared-tag set into the frontier in
  one step, causing a performance cliff at scale — measured ~950ms for
  10 000 atoms in a hub-tag-only graph; post-fix ~19ms (50× speedup).
  When the cap fires, a one-shot stderr warning is emitted and distance
  results may be conservative (atoms reachable only beyond the 500th
  frontier slot report unreachable instead of their true distance).
  Cap is an internal constant `BFS_FRONTIER_CAP = 500`, not exported.

### Fixed — `--json` error contract on 3 CLI commands ([#101](https://github.com/mainion-ai/memory-kernel-dev/issues/101))

- `mk citations`, `mk export-obsidian`, and `mk obsidian-init` now
  route their missing-directory error through the project-standard
  `exitWithError(msg, opts.json)` helper. Pre-fix, `mk citations -d
  /nonexistent --json` printed `✗ Memory directory not found: ...` to
  stderr and exited 1 — scripts driving the command with `--json`
  received plain text instead of the documented `{"error":"..."}`
  envelope. `export-obsidian` and `obsidian-init` previously had an
  inline `if (opts.json) { ... } else { ... }` — already
  contract-correct, refactored for consistency; their new tests
  function as regression guards. A separate follow-up
  ([#172](https://github.com/mainion-ai/memory-kernel-dev/issues/172))
  tracks adding `--json` to the seven commands in #101 that lack the
  flag entirely (a feature add, not a contract fix).

## [1.24.0] — 2026-05-20

Month-2 Wave 1 of the post-Sprint-3 remediation plan — three independent
reliability + observability fixes shipped in parallel ([#98](https://github.com/mainion-ai/memory-kernel-dev/issues/98),
[#99](https://github.com/mainion-ai/memory-kernel-dev/issues/99),
[#100](https://github.com/mainion-ai/memory-kernel-dev/issues/100)).
MINOR because PR-14 adds a new public option (`CallLLMOptions.timeoutMs`).

### Added — `CallLLMOptions.timeoutMs` ([#99](https://github.com/mainion-ai/memory-kernel-dev/issues/99))

- The `CallLLMOptions` public interface (re-exported from `index.ts`)
  gains an optional `timeoutMs?: number` field, defaulting to `120_000`.
  Callers can now control the spawn timeout per-call rather than relying
  on the hardcoded constant. Production call sites (`extract.ts`,
  `observe.ts`) are unchanged; the field is purely additive.

### Fixed — `compactLog` ↔ `appendEvent` lost-write race ([#98](https://github.com/mainion-ai/memory-kernel-dev/issues/98))

- `compactLog` and `appendEvent` in `src/event-log.ts` now coordinate via
  an advisory file lock (`proper-lockfile`). Pre-fix, an `appendEvent`
  that landed between `compactLog`'s re-read and the rename inside
  `writeFileAtomic` was silently lost — the rename clobbered the
  post-append on-disk file with the pre-append `finalCompacted` content.
  Post-fix, `appendEvent` waits for the lock before opening the log;
  `compactLog` holds it across read-modify-write. Lock file is
  `events.ndjson.lock` (sibling, mkdir/rmdir-based, 10s stale threshold).
  Adds `proper-lockfile@^4.1.2` as a runtime dependency.

### Fixed — spawn timeout SIGKILL fallback ([#99](https://github.com/mainion-ai/memory-kernel-dev/issues/99))

- `callClaude` in `src/llm.ts` no longer hangs indefinitely when the
  Claude CLI child traps SIGTERM. Pre-fix, the wrapping promise resolved
  only via `proc.on('close')`, so a misbehaving child that absorbed
  SIGTERM left the parent stuck. Post-fix, SIGTERM is followed by a
  5-second SIGKILL grace and the promise rejects immediately on timeout
  regardless of child exit state. `callOllama` already had the correct
  `AbortController` pattern and is unchanged.

### Fixed — `listAtoms` stderr warnings on corrupted atom files ([#100](https://github.com/mainion-ai/memory-kernel-dev/issues/100))

- `listAtoms` in `src/store.ts` now writes a stderr line for every
  parse failure, not just `EncryptionKeyMissingError`. Pre-fix, a
  malformed YAML / missing-frontmatter / truncated atom silently dropped
  out of recall and views with no signal. Format: `mk: warning: failed
  to parse <relativePath>: <ErrorClassName>: <message> — skipping`. The
  encryption-key-missing branch retains its specific user-actionable
  message.

## [1.23.2] — 2026-05-19

### Fixed — privacy filter for the FTS recall path ([#135](https://github.com/mainion-ai/memory-kernel-dev/issues/135))

- `searchFts`, `getTermDocumentFrequencies`, and `getAtomsMatchingTerm`
  now JOIN against the `atoms` table and exclude SECRET/PERSONAL rows,
  mirroring the predicate already applied in `queryIndex` and
  `getAllEmbeddings` ([#134](https://github.com/mainion-ai/memory-kernel-dev/pull/134)).
  Closes the lexical sibling of the semantic side-channel that PR-6 sealed:
  pre-fix, a SECRET atom with a dominant BM25 rank could shift the
  normalized scores of visible TEAM atoms downstream in `src/recall.ts`,
  and IDF damping / coverage-boost computations counted SECRET docs in
  the corpus statistics. Post-fix, document frequency is computed over
  the visible corpus only. NULL-classification atoms (legacy
  pre-classification rows) remain visible.

### Fixed — store-file permissions tightened to 0o600 ([#138](https://github.com/mainion-ai/memory-kernel-dev/issues/138))

- `events.ndjson`, view files (`INDEX.md`, `HANDOFF.md`, `CONSTRAINTS.md`,
  etc.), and `observations.md` are now written with mode `0o600` on POSIX
  hosts. PR-7 ([#137](https://github.com/mainion-ai/memory-kernel-dev/pull/137))
  chmoded SECRET atom files and the SQLite index; this PR extends the
  defense to the remaining plaintext store files. The event envelope
  (`atom_refs`, `agent_id`, `session_id`, `touched_paths`) is plaintext
  even when SECRET atom bodies are encrypted, so the file mode protects
  against the existence-leak of SECRET atom IDs. Stores created before
  v1.23.2 are upgraded automatically on the next `appendEvent` /
  `compactLog` / `writeView` call. Windows: `fs.chmodSync` is a no-op;
  same caveat as PR-7. Test assertions skip on Windows.

## [1.23.1] — 2026-05-19

### Fixed — wrapper-drift false positive on the mk binary itself

- `mk doctor`'s `wrapper-drift` check ([#160](https://github.com/mainion-ai/memory-kernel-dev/pull/160))
  no longer flags the mk binary (`#!/usr/bin/env node`) as a "hand-rolled
  wrapper." The broadening in #158/1.23.0 pulled in any script whose
  body matched `looksLikeMkInvocation` — but the mk binary's own source
  contains `mk render`/`mk reflect` strings (help text, self-calls), so
  it matched too. A test installation hit this in the 1.23.0 dogfood
  (`/home/<user>/.npm-global/bin/mk` flagged as hand-rolled).
- Phase-5 script resolution in `discoverWrappers()` now also requires the
  candidate to be a shell script. New exported helper
  `isShellScript(content)` parses the first-line shebang, takes the
  basename of the final whitespace-separated token, and checks against
  `{sh, bash, zsh, dash, ksh, ash, fish}`. The mk binary's `node`
  shebang fails this check; bash/sh wrappers (both mk-generated and
  hand-rolled) pass.

### Known limitation

- Shell scripts with no shebang line are no longer detected as wrappers.
  Caught during review of #160. Workaround: add
  `#!/usr/bin/env bash` (or any shell shebang) to the top of the script.
  A future PR could add a fallback heuristic on file extension
  (`.sh`/`.bash`) if this turns out to matter in practice.

## [1.23.0] — 2026-05-19

### Changed — wrapper-drift now flags hand-rolled wrappers

- `mk doctor`'s `wrapper-drift` check ([#158](https://github.com/mainion-ai/memory-kernel-dev/pull/158))
  used to be silent when a discovered wrapper script didn't carry the
  `# mk:generator-version=` header from `mk init --cron`. After the
  dogfood run on 2026-05-19, a hand-rolled `~/mk-memory/memory-sync.sh`
  was working but invisible to the check — exactly the case the check
  exists to catch. The check now emits two kinds of warning:
  - mk-generated wrapper, older than binary → existing
    `mk init --cron --update` hint.
  - hand-rolled wrapper, no mk: header → new
    `regenerate with mk init --cron so future drift can be detected` hint.
- `discoverWrappers()` now also resolves script references that match the
  `looksLikeMkInvocation` heuristic, not just ones carrying the mk-generated
  header. The `isMkGenerated` flag distinguishes the two downstream.
- The crontab itself (source `"crontab -l"`) is excluded from the check
  so a user crontab full of inline `mk reflect` / `mk render` lines
  doesn't get flagged as a "wrapper" — only the referenced script files do.

### Notes

- A test installation on 2026-05-19 ran 1.22.0 with the previous (header-less)
  `memory-sync.sh` and got a `healthy: true` from `mk doctor` despite
  being one binary upgrade away from a silent flag-rename breakage.
  Upgrading to 1.23.0 and re-running `mk doctor` will now surface the
  recommendation to regenerate via `mk init --cron --force`.

## [1.22.0] — 2026-05-19

### Fixed — fill-mode type-aware selection (#154)

Fill mode (the default for `mk render`, used by every cron job) sorted atoms
by recency and greedily filled the token budget — so on stores with many
recent belief atoms (developmental arcs, reflections), facts/decisions/
procedures/preferences were starved out and the rendered CLAUDE.md was a
belief monoculture. The monoculture warning (PR #146) detected the problem
but couldn't fix it. This had been broken for 30+ days on the active
deployment fleet.

Fill mode now routes through the same two-pass type-aware budget algorithm
as task-driven recall (`src/recall.ts`):

- **Pass 1 — reserve per type:** guarantee per-type token quotas (scaled to
  ≤ 30% of total budget via `MAX_RESERVATION_RATIO`).
- **Pass 2 — fill remainder:** fill the remaining budget by recency from
  atoms that did not get a reserved slot.

The two-pass implementation was extracted from `src/recall.ts` into a new
`src/budget.ts` module so both callers (recall and render) share one
algorithm. The Pass-2 tie-breaker is parameterised (score for recall,
recency for fill render).

### Added

- New `type_reservations` field on per-agent `render.yaml`:
  ```yaml
  type_reservations:
    decision: 800
    fact: 1200
    procedure: 600
    constraint: 400
    conflict: 400
    preference: 400
    belief: 4000
  ```
  Empty/missing → falls back to `DEFAULT_FILL_TYPE_RESERVATIONS` from
  `src/schema.ts`, which covers all 8 atom types.
- `RenderClaudeMdOptions.typeReservations` — programmatic override.
- `src/budget.ts` — public `selectAtomsWithReservations(atoms, maxTokens,
  reservations, pass2Mode)`.

### Changed — `recall()` no-task ordering

When `recall()` is called without a `task` query and the score map is empty
(constitution-pipeline-style callers), the budget helper now orders atoms by
`updated_at` descending rather than by the upstream `status-priority +
temporalDecay(created_at)` order that the pre-refactor single-pass greedy
fill preserved. Functional tests all pass for both orderings; callers that
need the prior behaviour can pass an explicit score map derived from
status-priority and decay to force `mode: 'score'`.

### Fixed — `parseRenderStats` undercounted arc-rendered beliefs

The monoculture warning's parser counted only `### atom-id` headings. Belief
developmental arcs render their entries as `**ATOM-ID**` bullets (indented
under an `### Arc:` header), so an arc-heavy store rendered correctly but
the warning still fired with bogus low counts. The parser now recognises
atom IDs by their `generateAtomId()` shape (`TYPE-YYYY-MM-DD-...`) in both
`### ID` and `**ID**` contexts, and skips the structural `### Arc:` and
`### Standalone beliefs` subheadings.

## [1.21.1] — 2026-05-18

### Fixed — post-merge review of #146 / #149 / #150 / #151

Four issues surfaced by the code-review pass over the 1.21.0 release cohort.
All are bug fixes — no public API changes.

- **`applyCrontabLine` no longer destroys sibling crontab entries on path-prefix collision (#149 follow-up).**
  The previous implementation matched the target script path with `.includes()`,
  so `mk init --cron --install-cron --output /home/me/memory-sync.sh` would
  silently overwrite an unrelated `/home/me/memory-sync.sh.bak` entry. The
  match now requires the path to appear as a whole shell token (bounded by
  whitespace, quotes, or line ends), so siblings with `.bak` / `-disabled`
  suffixes are left alone. The function's docstring previously claimed
  "exact match"; the code now matches that contract.

- **`extractScriptPaths` discovers wrappers under paths that contain spaces (#150 follow-up).**
  The path-extraction regex excluded spaces, so a LaunchAgent plist pointing
  at `~/Library/Application Support/mk/sync.sh` (the common location on macOS)
  was truncated at the first space and the wrapper was missed by
  `mk doctor`'s wrapper-drift check. The extractor now handles three
  encodings: bare unquoted paths, single/double-quoted paths, and
  `<string>...</string>` plist elements.

- **Release workflow now enforces CLAUDE.md's five-place version rule (#151 follow-up).**
  The "Verify tag matches `package.json`" step is replaced by
  "Verify all five release-version places agree", which checks the tag
  against `package.json`, both `package-lock.json` entries (top-level +
  `packages[""].version`), the `packages/openclaw-memory-kernel/package.json`
  `memory-kernel` dep pin (must be `^X.Y.Z`), and the presence of a
  `## [X.Y.Z]` heading in `CHANGELOG.md`. Any mismatch fails the job before
  publishing. `RELEASING.md` TL;DR and rollback sections were rewritten to
  list all five steps and link to CLAUDE.md > Versioning.

- **`src/deprecations.ts` docstring no longer cites a non-existent flag (#146 follow-up).**
  The constraint comment on `DEPRECATED_FLAGS` referenced `mk remember --text --fill`,
  but `mk remember` takes the body as a positional argument and has no `--text`
  flag. The docstring is updated to describe the real footgun
  (`mk remember "--fill is removed"` losing the `--fill` token) and the
  documented workarounds.

### Internal

- `packages/openclaw-memory-kernel/package.json` `memory-kernel` dep pin
  bumped from `^1.20.0` to `^1.21.1`, restoring the lockstep convention
  documented in CLAUDE.md > Versioning.

## [1.21.0] — 2026-05-18

### Added — CLI hardening + agent ops tooling

Four features landed in this release, all addressing fleet-drift patterns
observed on the active deployment fleet in May 2026 (#140, #141, #142 upstream half, #143).

- **Stderr deprecation warnings + degenerate-output guard (#141, [#146](https://github.com/mainion-ai/memory-kernel-dev/pull/146)).**
  New `src/deprecations.ts` runs against `process.argv` before commander
  parses. Removed flags get stripped with a one-line stderr hint instead of
  a bare "unknown option" error. Seeded with `--fill` (removed in 1.18.9).
  Honors `MK_NO_DEPRECATION_WARNINGS` / `MK_QUIET`. `mk render` also gains
  an empty-output and monoculture-output stderr warning — the silent-success
  case that left a test installation's CLAUDE.md empty for 30 days.

- **`mk init --cron` — canonical memory-sync wrapper generator (#143, [#149](https://github.com/mainion-ai/memory-kernel-dev/pull/149)).**
  `mk init --cron --dir <mem> --claude-md <out> --output <script>` emits
  the canonical shell wrapper (`reflect → render → git commit + push`) with
  machine-parseable `# mk:KEY=VALUE` header lines. `--update` regenerates
  in place, inheriting paths from the existing header. `--install-cron
  "0 23 * * *"` idempotently adds/replaces the matching crontab line.
  `--force` for explicit overwrites. Eliminates the hand-rolled wrapper
  drift that affected a host on the 1.18.9 upgrade.

- **`mk doctor` orchestrator + drift/store/render-config checks (#140, [#150](https://github.com/mainion-ai/memory-kernel-dev/pull/150)).**
  `mk doctor` is now a check-registry orchestrator that runs seven checks
  by default: `atom-schema`, `broken-links`, `active-conflicts`,
  `store-schema`, `store-permissions`, `render-config`, `wrapper-drift`.
  Exit codes 0/1/2 (healthy/warn/error). `--skip wrappers|network|cron|
  store` excludes categories. `--json` output is backward-compatible
  (kept `{ healthy, issue_count, issues }`, added `checks: []` alongside).
  New `src/doctor/discover-wrappers.ts` scans crontab, /etc/cron.\*,
  `~/Library/LaunchAgents/`, `~/.config/systemd/user/`,
  `/etc/systemd/system/`; the `wrapper-drift` check flags any
  mk-generated wrapper whose embedded version (from #143's header) is
  older than the running binary.

- **Release workflow with provenance (#142 upstream half, [#151](https://github.com/mainion-ai/memory-kernel-dev/pull/151)).**
  `.github/workflows/release.yml` runs on `v*` tag push: full tests →
  tag/version sanity check → `npm publish --provenance --access public` →
  `gh release create --generate-notes`. Sigstore-signed via GitHub Actions
  OIDC. Operator doc in [`RELEASING.md`](./RELEASING.md). npm publish is
  dormant until OIDC trusted-publisher setup completes on npmjs.com —
  tracked in [#152](https://github.com/mainion-ai/memory-kernel-dev/issues/152).

### Backward-compatibility note

- `mk doctor -d /nonexistent --json` now exits **2** (was 1). Per the
  0/1/2 exit-code spec from #140: a missing memory dir is a hard runtime
  error, not a content issue. Updates needed in any consumer that depends
  on the prior behavior. The healthy/warn paths are unchanged.

### Sequencing

These four PRs follow a deliberate order — #141 (catches drift at the
moment of failure), then #143 (eliminates the hand-rolled wrappers
that produce drift), then #140 (audits + flags wrappers via the headers
#143 writes), then #142 upstream (ships releases that downstream hosts
can consume). The downstream half of #142 (per-host poller) is gated
on #152.

## [1.20.0] — 2026-05-18

### Performance
- KNN search now uses dot product on pre-normalized vectors instead of
  cosine similarity (#95). New vectors are stored unit-norm; legacy rows
  are lazily normalized on first read and written back. The hot loop in
  `recall()` skips per-iteration `sqrt`. Empirically ~20-30% faster wall-
  clock on 10k atoms; same top-K within float tolerance.
- `atom_embeddings.normalized` column added via idempotent `ALTER TABLE`
  (no schema-version bump — additive migration, safe on existing DBs).
  The new column is also preserved across `reindex()` so the lazy
  migration runs at most once per row.

### Added
- `normalizeVector(v)` and `dotProduct(a, b)` exported from `memory-kernel`.

### Notes
- First `recall()` after upgrade may trigger a one-time write-back of
  up to 10k rows as legacy un-normalized vectors are migrated. Bounded
  by `MAX_EMBEDDINGS_FOR_KNN` and run inside a single transaction.

## [1.19.2] — 2026-05-18

### Performance
- `extractCitations` and `indexCitations` now compile each concept-name
  regex once via a new internal `compileConceptRegexes` helper (#94).
  Drops total `new RegExp()` calls from O(sources × targets) to O(targets).
  At N=10k atoms with ~3 concept names per atom, that's ~30M compiles
  dropped to ~30k — empirically ~10× faster on the citations hot path.
  Also drops a redundant `body.toLowerCase()` step (the `i` flag on the
  compiled regex handles case folding).

## [1.19.1] — 2026-05-18

### Performance
- `embedAllAtoms` now bulk-loads all `body_hash` rows in a single SELECT
  instead of issuing one SELECT per atom (#93). At N=10k atoms the
  staleness-check phase drops from ~10k round-trips to 1 — empirically
  ~10× faster wall-clock on the embed-sync hot path.

## [1.19.0] — 2026-05-18

### Breaking
- **Public API surface tightened (#90).** The following symbols are no longer
  exported from `memory-kernel` (still available via direct module import
  for in-repo use):
  - From `./index-db`: `indexAtom`, `removeFromIndex`,
    `getTermDocumentFrequencies`, `getCorpusSize`, `getAtomsMatchingTerm`,
    `indexEpisode`, `removeEpisodeFromIndex`, `searchEpisodeFts`
  - From `./llm`: `callLLM`, `resolveProvider` (use the feature wrappers
    `extractFromLog`, `observeConversation`, `enrichRelations`,
    `confirmConflictWithLLM` instead). The `LLMProvider` and `CallLLMOptions`
    types remain exported for advanced consumers wiring custom providers.
  - From `./relink`: `ATOM_ID_PATTERN` — replaced by the factory
    `createAtomIdPattern()` which returns a fresh stateless regex per
    call (eliminates the `lastIndex` reset footgun).

### Changed
- `RenderClaudeMdOptions.typeWeights` is now typed
  `Partial<Record<AtomType, number>>` (was `Partial<Record<string, number>>`).
  Two unsafe `as any` casts in `src/render.ts` removed.

## [1.18.9] — 2026-05-17

### Security

- **Random PBKDF2 salt per encrypted file (#96):** SECRET atom encryption now uses a 16-byte random salt per file embedded in a new `MKENC:v2` envelope (`MKENC:v2:<salt>:<iv>:<payload>`). Two installations using the same passphrase no longer derive the same key. Backward compatibility for the legacy `MKENC:v1` envelope is preserved on read — old files continue to decrypt. New `encryptAtomWithCredential` / `decryptAtomWithCredential` exports in `src/crypto.ts` are the credential-string API; legacy `encryptAtom` / `decryptAtom` / `resolveKey` are retained as `@deprecated` (bodies unchanged) so existing tests and external consumers keep working. The four production callers in `src/store.ts`, `src/retain.ts`, and `src/replay.ts` now use the credential API.
- **SECRET file mode 0o600 (#97):** `writeFileAtomic` accepts an optional `mode` parameter. `writeAtom` passes `0o600` for SECRET-classified atoms and follows with a defense-in-depth `fs.chmodSync` (try/catch-wrapped). The SQLite index file (`.memory-index.db`) and its `-wal` / `-shm` sidecars (when present) are chmoded `0o600` inside `openIndex` / `openIndexRaw`. Non-SECRET file modes unchanged.

## [1.18.8] — 2026-05-17

### Security

- **Privacy filter on embedding store (#87):** `getAllEmbeddings` now excludes SECRET and PERSONAL atoms at the SQL layer (JOIN to `atoms` with classification predicate). Prevents SECRET/PERSONAL atoms from donating semantic-similarity scores to visible neighbors via the recall graph-boost. Mirrors the same filter already applied in `queryIndex`.
- **Prompt-injection escape on LLM ingestion (#88):** `src/extract.ts` and `src/observe.ts` now wrap user-controlled conversation text in a `<document>` boundary and XML-escape `<`/`>` in the body before inserting into the LLM prompt. Hostile inputs containing `</document>\nIgnore previous instructions` can no longer close the boundary early. observe.ts gains the boundary it lacked. Shared helper `escapeXmlBoundary` lives in `src/store.ts`; prompt construction extracted into testable `buildExtractPrompt` / `buildObservePrompt` helpers.

### Deferred

- **#89 CLI output containment — wontfix.** `render` and `export-obsidian` are intentionally projection commands that write outside the memory dir. Strict `assertWithinDir(memoryDir, …)` would break their purpose. Containment remains enforced on store-mutation commands. See [#89](https://github.com/mainion-ai/memory-kernel-dev/issues/89) for the close-out rationale.

## [1.18.7] — 2026-05-17

### Fixed — Transaction wrappers for index operations (#85)

Three multi-statement write paths in `src/index-db.ts` now run inside a single `db.transaction(...)`, eliminating partial-state hazards when a fault interrupts the block mid-flight.

- **Schema upgrade block.** The DROP/CREATE/`user_version` sequence in `openIndex` was non-atomic. A crash between the first `DROP TABLE` and the final `user_version` pragma left the index header on the old schema version while the tables were half-rebuilt; the next `openIndex` re-entered the upgrade path and DROPed the partial schema again, destroying any rows the application inserted in the partial-success window. After the fix, the block commits atomically or rolls back fully — the next open sees either the prior schema fully intact or the new schema fully built.

- **`removeFromIndex`.** Three sequential `DELETE`s against `atoms`, `atom_fts`, and `atom_embeddings` are now one transaction. A throw on any DELETE rolls back the prior DELETEs; no more orphan FTS rows or dead vectors after a partial removal.

- **`indexEpisode`.** The DELETE/INSERT FTS upsert is now one transaction. The function still swallows errors silently (FTS is an optimization), but the original episode row is now preserved on INSERT failure instead of silently lost.

- **Regression tests:** `test/index-db-schema-upgrade-crash.test.ts` adds 6 cases — three rollback assertions (one per fix site, using `vi.spyOn` on `Database.prototype.prepare`/`exec` to inject mid-block faults) and three happy-path regression guards.

### Public API

No signature changes. `removeFromIndex`, `indexEpisode`, and `openIndex` keep identical public types and externally observable success-case behavior. The change is only visible under fault injection or real crash recovery.

## [1.18.6] — 2026-05-17

### Fixed — TOCTOU race in concurrent supersede (#107)

- **CAS guard in `detectAndResolveConflicts`.** Two parallel `mk extract` runs could both confirm a Tier-2 conflict against the same active atom and both call `supersedeAtoms` — leaving two atoms each holding a redundant `supersedes` relation pointing at the same target. `findCandidateConflicts` already filters out non-active candidates at Tier-1, so the race window was narrowly the Tier-1-query → supersede-write gap, dominated by the Tier-2 LLM latency (seconds).

  The fix re-reads the candidate atom's `status` from the index immediately before the supersede write. If the status is no longer `'active'`, the resolution is recorded as the new `stale_decision` action and the supersede is skipped. Race window collapses from human-scale (LLM call) to a single function-call gap (microseconds).

- **Regression tests:** `test/conflict-detect-toctou.test.ts` adds 3 cases — race-skip path (mocked LLM mutates candidate status mid-call), `supersede_failed` disambiguation (file deleted, status unchanged), and happy-path regression guard.

### Added

- **`ConflictAction` enum** gains `'stale_decision'`. Distinguishes "skipped because preconditions changed between detection and write" from `'supersede_failed'` (write attempted, threw). The new value is additive; existing callers that switch on `ConflictAction` will hit their default branch until they opt in.

### Public API

No signature changes. `supersedeAtoms` kernel function semantics unchanged — the CAS check lives in the orchestrator (`detectAndResolveConflicts`) because only the orchestrator has Tier-1 evidence that the candidate was active when picked.

## [1.18.5] — 2026-05-17

### Fixed — crash atomicity in the write path (#84)

- **Event-first write ordering** for `createAtom`, `updateAtom`, `archiveAtom`, and `resolveConflict` in `src/retain.ts`. Previously these functions performed the file/index mutation BEFORE appending the v2 event, so a crash between the two steps left the file system in the new state but the event log without a record — replay could not reconstruct the mutation. Worst case was `archiveAtom`, which `unlinkSync`'d the source file before `appendEvent`; a crash there destroyed atom data with no recovery path.

  New ordering: emit the v2 event with full atom snapshot FIRST, then perform the file mutation (and unlink, for archive/resolve), then update the index. On crash at any point after the event append, the event log alone is sufficient for replay to reconstruct.

- **`createAtom` collapsed from a 2-write pass to 1-write.** Auto-relink (body-reference + concept-name extraction) now runs before event emission so the snapshot already carries extracted relations; eliminates the redundant `writeAtom` + `indexAtom` pass that previously happened post-relink.

- **Regression tests:** `test/retain-crash-atomicity.test.ts` adds 5 cases using `fs.renameSync` / `fs.unlinkSync` spies to simulate mid-operation crashes and verifies the event log contains the snapshot in each scenario.

### Public API

No signature changes. Behavioral change only: events now represent intent (pre-mutation commit) rather than fact (post-mutation acknowledgment) — but since v2 events carry the full snapshot inline, replay semantics are unchanged.

## [1.18.4] — 2026-05-16

### Fixed

- **Archive basename collision** (#86). `src/reflect.ts` previously used `path.basename(filePath)` as the archive destination across `processExpiry`, `dedupById`, and body-content `dedup`. Two atoms whose source files share a basename (e.g. a manually-imported `CONFLICTS/foo.md` and `ENTITIES/foo.md`) would silently overwrite each other in `ARCHIVE/`. Fix: prefix the archive filename with the atom ID via a new `archiveDestination()` helper; regression test in `test/reflect-archive-collision.test.ts` covers all three call sites.

### Changed — documentation

- **README lifecycle clarification** (#92). The "Lifecycle" paragraph previously said `reflect` "promotes them to active", which conflated two distinct promotions. `reflect` auto-promotes beliefs with confidence ≥ 0.9 to facts (type promotion, file renamed). `mk consolidate` separately promotes draft atoms of any type to active (status promotion, manual review). Both mechanisms now spelled out explicitly.
- **CHANGELOG backfill** (#92). The previous `## [Unreleased]` section actually described what shipped in v1.18.3 (rename `container/skills/` → `skills/`, lifecycle-atom seeding, host-aware setup, mk-doctor universal checks). Promoted the section to `## [1.18.3] — 2026-05-16` and added the missing render/extract/supersede commits that landed between v1.18.2 and v1.18.3.

## [1.18.3] — 2026-05-16

### Changed — repository layout

- **Renamed `container/skills/` → `skills/`.** Both `mk-memory-setup` and `mk-doctor` are host-side skills (run via Claude Code on the operator's machine, not inside a container), so the old location was misleading; `container/` was empty otherwise. No npm-package impact — the published `memory-kernel` package only ships `dist/`, `README.md`, and `LICENSE`.

### Added — agent lifecycle as typed memory + multi-host setup

- **`mk-memory-setup` now seeds 8 lifecycle atoms** (7 procedure + 1 constraint) so the agent's operating manual lives inside memory-kernel itself and is recallable per task — see `skills/mk-memory-setup/seed-atoms/lifecycle/`. The `seed-atoms/seed-lifecycle.sh` script is the canonical entry point.
- **`mk-memory-setup` is now host-aware.** SKILL.md auto-detects (or asks) whether the host is NanoClaw, OpenClaw, an MCP client (Claude Desktop, Cursor, Continue), or generic, and routes to the matching `references/<host>.md`. Universal core (install CLI, init store, seed atoms, cron) stays in SKILL.md; host-specific plumbing lives in references.
- **`mk-doctor` adds three universal checks:** `mk lint` (semantic health), `mk closure --trajectory` (drift detection), and a lifecycle-atom audit (catches agents bootstrapped before lifecycle seeding existed). Host-specific checks branch on detected host.

### Fixed — render + extract + supersede hardening

- **`mk render` defaults to `--fill` mode** so generated CLAUDE.md surfaces all eligible atoms instead of the prior token-budgeted slice. Adds `procedure` type to the render pipeline and a catch-all branch for unknown types (#79).
- **`renderAgentClaudeMd` no longer drops the fill flag** when called from per-agent isolation paths; fuzzy-arm cap restored after range-review (#79).
- **Path boundary bug fixed in SQL index queries**; test alignment for unconditional indexing.
- **Semantic conflict detection for `mk supersede`** (#75, #77) — extends the Tier-1/Tier-2 conflict pipeline from `mk extract` to the supersede flow.
- **`mk extract` PR review fixes** — path traversal guard, stdin handling restored, vacuous check removed.
- **`mk render --fill` + TTL backfill script** smoke-test stabilization.
- **Test reliability:** replaced `setTimeout`-based backdating in conflict-detect tests with deterministic timestamp manipulation.

## [1.18.2] — 2026-05-13

### Fixed — semantic conflict detection durability (#77 review)

- **`reindex()` no longer wipes `entity_triples`.** Triples are LLM-extracted at ingestion and are not serialized in atom markdown, so the previous behaviour (clear without repopulate) silently destroyed all triple data and disabled Tier-1 conflict detection on every `mk reindex`. Triples are now snapshotted to a temp table at the start of reindex and restored at the end for atoms that still exist (orphaned triples are dropped, matching the embedding-preservation pattern in the same transaction).
- **`findCandidateConflicts` now excludes `expired` atoms** in addition to `superseded` and `archived`, bringing it in line with `queryIndex()` / `wander` and the rest of the active-status convention. Previously an expired atom could be returned as a conflict candidate and silently auto-superseded.

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
