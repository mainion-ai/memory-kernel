# Behavioral contracts

The non-obvious contracts that integrators otherwise learn by trial and error. Several fleet-deployment near-misses came from these being undocumented (#310). The machine-readable counterpart to the JSON shapes here is the set of exported Zod schemas (#301) — `import { RecallOutputSchema, DoctorOutputSchema, RememberOutputSchema, EvalOutputSchema } from 'memory-kernel'` and `parse()` instead of guessing.

---

## 1. Draft-visibility matrix

Which atoms surface where depends on **status** and on the **`auto-extracted` tag** (the `AUTO_EXTRACTED_TAG` constant stamped by `mk extract` on session-end drafts), *not* on bare `status: draft`. This asymmetry is deliberate: hand-authored drafts are work you chose to write, so they surface; auto-extracted drafts are unvetted machine output, so they're gated until promoted.

| Atom state | In `mk recall` / `mk_context_bundle`? | In `mk render` (CLAUDE.md)? | Notes |
|---|---|---|---|
| `active` | ✅ yes | ✅ yes | the normal case |
| `draft`, **hand-authored** (no `auto-extracted` tag) | ✅ yes | ✅ yes | surfaces immediately — vetting is your call |
| `draft` + `auto-extracted` tag (from `mk extract`) | ❌ no (opt in with `--include-drafts` / `include_drafts: true` / `mk_recall` `include_drafts`) | ❌ no | unvetted until `mk reflect`/`mk consolidate` promotes it |
| `superseded` | ❌ no | ❌ no | excluded from default recall; kept on disk for audit |
| `archived` / `expired` | ❌ no | ❌ no | terminal; kept on disk |

The exclusion is enforced in **both** the file-scan path (`filterAtoms` / `isUnvettedDraft`, `src/recall.ts`) and the SQLite path (`queryIndex`, `src/index-db.ts`), and in `renderFill` (`src/render.ts`), so it holds whether or not an index exists. See [lifecycle.md](lifecycle.md) for the full status state machine.

---

## 2. JSON output shapes

Every command takes `--json`; the shape is stable within a major version. Authoritative, machine-checkable schemas are exported (#301) and test-enforced against real CLI output, so they can't drift:

| Command | Schema (`from 'memory-kernel'`) | Key fields |
|---|---|---|
| `mk recall` / `mk_context_bundle` | `RecallOutputSchema` | `index`, `handoff`, `constraints`, `atoms[]`, `episodes?`, `token_estimate`, `recall_status?` |
| `mk doctor` | `DoctorOutputSchema` | `healthy`, `issue_count`, `issues[]`, `checks[]`, `fixes?` (with `--fix`) |
| `mk remember` | `RememberOutputSchema` | `id`, `type`, `status`, `confidence`, `tags[]`, `embedded`, `embedding_warning`, `tag_warning` |
| `mk eval` | `EvalOutputSchema` | `fixtures[]` (each: `pass_rate`, `total`, `passed`, `embed_used`, `results[]`), `ok`, `exit_code` |
| `mk grounding` | _(no exported Zod schema yet)_ | `summary` (`total`, `actionable`, `by_quadrant`), `reports[]` (`atom_id`, `type`, `prior`, `grounding_score`, `quadrant`, `actionable`, `reason`, `inputs{…}`), `shown` — see §2.1 |

Schemas are `.passthrough()` — an **additive** field in a later version won't break a `parse()`, but the documented fields are guaranteed present. Treat any field not in the schema as internal/unstable.

### `recall_status` semantics (set only when `task` was passed)
- **`match`** — ≥1 FTS or semantic hit; `atoms` is the match set.
- **`no_match`** — FTS *and* semantic both empty; `atoms` is `[]` by design (#214 — no confidently-irrelevant fallback). Not an error.
- **`fts_unavailable`** — the FTS query couldn't run (table missing, or a query that crashed past the sanitization layer); recall fell back to file-scan. See FTS rules below.

### `mk extract` size guard (#355, v1.35.0+)
- **Oversized input** — when the assembled prompt (system + log) exceeds `--max-input-chars` (default 500 000) and `--truncate` is **not** set, `mk extract` exits **code 2** (distinct from the generic `exitWithError` code 1) and, under `--json`, prints `{ "error": <human message>, "reason": "input_too_large", "exit_code": 2, "input_chars": <number>, "limit": <number> }` (`error` is the same human-readable string as every other command's `--json` error; `reason` is the stable machine token). A wrapper should branch on exit code 2 or the `reason: "input_too_large"` token and retry with `--truncate` / `--skip-lines`.
- **Truncation** — when `--truncate` dropped content, the normal `ExtractResult` JSON carries an additive `truncation: { original_chars, sent_chars, omitted_chars }` field (absent for normally-sized input). The **most-recent (tail)** content is kept — the right default for session-end extraction, and it composes with `--skip-lines`, which trims the head preamble; the omitted **head (oldest)** is summarized by `omitted_chars` and flagged by a marker prepended to the sent slice.

### 2.1 `mk grounding` shape + read-only contract (#245, v1.35.0+)

`mk grounding --json` emits the full engine result plus a filter-aware row count:

```jsonc
{
  "summary": { "total": 12, "actionable": 3,
               "by_quadrant": { "well-grounded": 9, "review": 2, "promote": 1, "noise": 0 } },
  "reports": [
    { "atom_id": "FACT-…", "type": "fact", "prior": 0.90, "grounding_score": 0.31,
      "quadrant": "review", "actionable": true,
      "reason": "stated confidently (0.90) but little usage grounding (0.31)",
      "inputs": { "n_access": 1, "session_diversity": 1, "n_conflict": 0,
                  "days_since_last_read": 30, "age_days": 120, "sessions_since_creation": 7 } }
  ],
  "shown": 1
}
```

- **`summary` is always the full graded set**; **`reports` honors `--actionable-only`**, and **`shown` = `reports.length`** so a consumer never mistakes `summary.total` for the number of rows present.
- **`grounding_score` ∈ [0.01, 1]** is **prior-independent** — a posterior over *use* (recency + read-frequency, ×`0.6` per conflict; a never-read atom is `0.01` regardless of age). `inputs.age_days` is *reported* but is **not** a score term.
- **Read-only contract:** `mk grounding` **writes no atom files** and **does not build or open the SQLite index** (it reads `events.ndjson` directly). The confidence write-back (mutating `confidence`) is **deferred and gated on `human_edit` provenance events (#247)** — until then this command is purely advisory.

---

## 3. FTS sanitization rules

`mk recall --task <q>` runs the task through SQLite FTS5, which treats several characters as syntax. `searchFts()` (`src/index-db.ts`) sanitizes the query before matching; without that, punctuation crashes the query and yields `recall_status: fts_unavailable`.

- **Stripped from the query**: `.` `,` `;` `?` `!` (extended in v1.27.0, #214) — so `192.168.1.136` or `how does paging work?` match cleanly instead of erroring.
- **Apostrophes** (`'`): historically caused `fts_unavailable` (#283); sanitization was hardened, but `recall_status: fts_unavailable` remains the diagnostic signal if a query still can't tokenize.
- **Length cap**: queries are bounded (`MAX_QUERY_LENGTH`) to prevent polynomial-backtracking on pathological input.
- **Detect it**: a `--json` recall with `recall_status: "fts_unavailable"` means the query didn't tokenize — simplify it (drop unusual punctuation) or rely on the file-scan fallback. `no_match` (vs `fts_unavailable`) means the query *did* run and genuinely found nothing.

See [troubleshooting.md](troubleshooting.md) for the `fts_unavailable` runbook.
