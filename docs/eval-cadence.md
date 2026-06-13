# Eval cadence — delta-only post-sync alert + weekly digest (#266)

> **NOT deployed to the live agents.** This is the staged design + tooling. An operator wires it into a host (post-sync hook + weekly cron) — deployment is human-gated.

`mk eval` (#300) scores recall against a golden-query fixture and returns a pass rate. Watching the *absolute* rate is noisy — you'd either alert on every dip or never. The **cadence** turns a stream of `mk eval` runs into a signal: it compares the latest run's per-category pass rate against a **rolling baseline** and only fires when a category moves materially.

## What fires

Per category, comparing the latest run to the mean of the prior runs inside the rolling window (default **7 days**, latest excluded):

| Condition | Meaning | Action |
|---|---|---|
| drop **> 10 pp** | a regression (sync broke recall, an atom went missing, index drift) | **alert** + non-zero exit |
| improve **> 15 pp** | recall got materially better — worth noticing / re-baselining | **alert** (informational) |
| within −10pp … +15pp | noise | silent |
| category has no baseline yet | first observation | silent (nothing to compare) |

Thresholds are **percentage-points of pass-rate**, asymmetric on purpose (regressions are cheaper to over-report than improvements). All three are configurable (`--drop` / `--improve` / `--days`).

A **weekly digest** is emitted on every run regardless of alerts — a stable checkpoint (`category: baseline → latest ±pp`, overall rate).

## Wiring (operator)

The decision logic is the tested engine `src/eval-cadence.ts`; `scripts/eval-cadence.mjs` is the I/O wrapper.

**Post-sync hook** — after the nightly reindex/sync, score recall and feed the cadence:

```bash
# In the agent's sync wrapper, after `mk reindex` / sync:
mk eval -d "$KERNEL_DIR" --json > /tmp/mk-eval-latest.json
node /path/to/memory-kernel/scripts/eval-cadence.mjs \
  --history "$STATE_DIR/eval-baseline.jsonl" \
  --latest /tmp/mk-eval-latest.json
# exit 1 + ALERT lines on a material per-category move → route to your notifier.
```

**Weekly digest** — a stable checkpoint regardless of alerts:

```bash
node /path/to/memory-kernel/scripts/eval-cadence.mjs \
  --history "$STATE_DIR/eval-baseline.jsonl" --digest
```

The history is a JSONL of `{timestamp, overall, categories}` snapshots — each post-sync run appends one line; the rolling window keeps the comparison local in time so a long-ago run can't anchor the baseline.

> **Embeddings:** run `mk eval` with `EMBEDDING_PROVIDER=openai` + `EMBEDDING_API_KEY` (or the Voyage equivalent) so recall is scored on the hybrid FTS+semantic path the agents actually use. Keyless runs silently degrade to FTS-only — a lower floor; watch `embed_used` in the eval JSON.

## Authoring per-agent fixtures

Each agent needs its own golden set — topics differ per store. Convert an existing `golden-queries.json` to the `mk eval` YAML format with the bundled migrator:

```bash
node scripts/golden-json-to-yaml.mjs <store>/golden-queries.json > <store>/eval/recall.yaml
```

A fixture is `queries: [{ task|q, expect: [atom-ids], cat }]` (+ optional `threshold` / `top_k`). For **KNOWLEDGE-category** queries, use `expect_content: <substring>` instead of `expect` — `mk eval` greps `KNOWLEDGE/**` for those (the docs aren't atoms, so atom-recall always misses them). Per-agent fixtures live **inside each store** (private; never committed).

## Acceptance gate

A green cadence (no regression alert, expected categories above their baselines) doubles as the post-upgrade / post-sync acceptance signal — pairs with `mk doctor`'s seed-set-freshness gate (#330) and `mk upgrade` (#331).
