# Troubleshooting

Failure modes seen in real fleet deployment, each with symptom → cause → fix → how to verify (#315). When in doubt, run **`mk doctor -d <dir>`** first — it surfaces most of these (version skew, key/vector state, recall health, sync liveness, cron wrapper paths).

---

## 1. `better-sqlite3` / node-gyp build failure

**Symptom:** `mk` fails on startup with a native-module error (`NODE_MODULE_VERSION` mismatch, or `Error: Could not locate the bindings file`) — typically right after a Node version change or a fresh install.

**Cause:** `better-sqlite3` is a native addon compiled per Node ABI. A different Node version than the one it was built against invalidates the prebuilt binary.

**Fix:**
```bash
npm rebuild better-sqlite3
# or, if a prebuild is available for your platform/Node:
npx node-pre-gyp install --fallback-to-build -C node_modules/better-sqlite3
```

**Verify:** `mk --version` runs without the native error; `mk status -d <dir>` opens the index.

---

## 2. Nightly cron sync can't find `mk` (`command not found`)

**Symptom:** the nightly `mk-memory-sync` timer logs `mk: command not found` (or exits 127) and the rendered `CLAUDE.md` goes stale.

**Cause:** cron/systemd timers run with a minimal `PATH` that excludes the agent's `mk` — especially when `mk` is a **group-npm local dependency** (`…/node_modules/.bin/mk`), in neither the node dir nor `~/.local/bin` (#345).

**Fix:** regenerate the wrapper with `mk init --cron` (v1.33.2+) — it bakes the agent's `MK_BIN` and prepends its dir to `PATH`. Set `MK_BIN` in the environment where you run the generation (`mk init --cron` reads it from the env; there's no `--mk-bin` flag — that one is on `mk upgrade`):
```bash
MK_BIN=/grp/npm/node_modules/.bin/mk mk init --cron --update --output /path/to/sync.sh
```

**Verify:** `mk doctor -d <dir>` is clean (the `wrapper-drift` + `wrapper-memory-dir` checks pass), and `journalctl --user -u mk-memory-sync.service` shows the steps running. Diagnose a live timer with `systemctl --user status mk-memory-sync.timer`.

> Related: if the wrapper *finds* `mk` but renders to a missing dir, see #347 — `mk doctor`'s `wrapper-memory-dir` check flags a baked container path that doesn't exist on the host.

---

## 3. `mk extract` runs but produces zero atoms

**Symptom:** `mk extract <log>` exits 0 with no error but creates no draft atoms.

**Cause:** the Claude CLI session has expired; the underlying call returns an auth error that extract treats as empty output rather than a hard failure.

**Fix:**
```bash
claude login    # re-authenticate, then re-run mk extract
```

**Verify:** `mk extract <log> --dry-run` reports candidate atoms (> 0); a real run then creates drafts (`mk status` atom count rises).

---

## 4. `recall_status: fts_unavailable` (often punctuation in the query)

**Symptom:** `mk recall --task "…" --json` returns no atoms with `recall_status: "fts_unavailable"` — common with apostrophes (`it's`) or other punctuation.

**Cause:** SQLite FTS5 treats some characters as syntax. mk sanitizes `.` `,` `;` `?` `!` and hardened apostrophe handling (v1.27.0, #214/#283), but a query that still can't tokenize falls back to file-scan and reports `fts_unavailable`.

**Fix / workaround:** simplify the task string (drop unusual punctuation); the file-scan fallback still returns results. See [contracts.md → FTS sanitization rules](contracts.md#3-fts-sanitization-rules) for the full ruleset.

**Verify:** the same query with plain words returns `recall_status: "match"` (or `"no_match"` — which means it ran and genuinely found nothing, *not* an error).

---

## 5. Embedding key set, but `vectors == 0` (the `EMBEDDING_API_KEY` trap)

**Symptom:** `EMBEDDING_PROVIDER` + `OPENAI_API_KEY` are set, `mk doctor` shows no key error, yet recall stays FTS-only and the index has 0 vectors. (Cost two days of fleet debugging — highest-value entry here.)

**Cause:** mk reads **`EMBEDDING_API_KEY`** first. The provider-specific `OPENAI_API_KEY` / `VOYAGE_API_KEY` is only a *fallback* and must match the provider. `OPENAI_API_KEY` alone with `EMBEDDING_PROVIDER=voyage` resolves **nothing**.

**Fix:**
```bash
export EMBEDDING_API_KEY="$OPENAI_API_KEY"   # set the generic var explicitly
mk reindex -d <dir> --embed                   # build vectors
```

**Verify:** `mk doctor -d <dir>` — the `embedding-key-source` check names exactly which var resolved, and `embeddings-vectors-fresh` shows vectors > 0.

---

## 6. `mk extract` crashes on a large transcript (`input_too_large`)

**Symptom:** `mk extract <log>` on a big conversation log fails. Pre-v1.35.0 this looked like a generic `claude -p exited with code 1` (or an Ollama error) and silently stopped session-end atom creation — a multi-MB transcript stalled fleet extraction for ~2 days with no distinguishable signal. From v1.35.0 the failure is explicit: a non-zero exit **code 2** and, under `--json`, `{"error":<human message>,"reason":"input_too_large","exit_code":2,"input_chars":…,"limit":…}`.

**Cause:** the assembled prompt (extraction system prompt + the full log) exceeds the model's usable context. extract now pre-flights the assembled size against `--max-input-chars` (default 500 000) **before** spawning the LLM, so an over-budget input fails fast and recognizably instead of as an opaque downstream crash.

**Fix — pick one:**
```bash
# Skip already-extracted preamble (e.g. the CLAUDE.md prefix injected at session start):
mk extract <log> -d <dir> --skip-lines 200

# Keep the newest content and drop the oldest to fit the budget instead of failing (a marker is prepended):
mk extract <log> -d <dir> --truncate

# Raise the budget if your model genuinely has the context for it:
mk extract <log> -d <dir> --max-input-chars 1000000
```
A cron/host wrapper should branch on **exit code 2** (or the `--json` `reason: "input_too_large"` token) and retry with `--truncate`/`--skip-lines`, rather than treating it as a generic failure.

**Verify:** the retry exits 0; with `--truncate`, the plain output prints `⚠ input truncated: sent … of … chars (… omitted from the beginning)` and `--json` carries a `truncation: { original_chars, sent_chars, omitted_chars }` field. See [contracts.md](contracts.md) for the `--json` shapes.

---

## 7. Recall returned a surprising ranking — why did atom X outrank atom Y?

**Symptom:** `mk recall`/`mk render` surfaced (or omitted) an atom and you can't tell why from the output alone.

**Fix:** set **`RECALL_DEBUG=1`** to emit a per-atom score breakdown to **stderr** (the scoring stage, before MMR/budget trimming), sorted by final score:
```bash
RECALL_DEBUG=1 mk recall --task "<your task>" -d <dir>
```
The task path prints each atom's `fts`/`specificity`/`length`/`coverage`/`semantic`/`recency`/`type_weight`/`conf_factor`/`graph_boost`/`final`; the no-task constitution path prints `status`/`status_priority`/`recency`/`updated_at`. It's a diagnostic only — **off by default with zero overhead**, stderr-only (not part of the `--json` payload), so it never affects piped output.
