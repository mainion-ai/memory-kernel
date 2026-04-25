# Every 5 Sessions

```bash
mk reflect -d {dir}
mk gc -d {dir}
```

**Why reflect:** deduplicates near-identical atoms, expires atoms past their TTL, promotes beliefs with confidence ≥ 0.9 to facts, and detects conflicts between atoms. Without regular reflect runs, stale and duplicate atoms accumulate and degrade recall quality.

**Why gc after reflect:** reflect marks atoms as expired; gc archives them. Running gc without reflect first is safe but leaves atoms that reflect would have expired. The pair together keeps the store clean.

**Counting sessions:** one `mk episode` write = one session. Either keep a running count via a preference atom (`"Last reflect: 2026-04-19, next at session 5"`, updated after each reflect) or check `mk episodes -d {dir} --limit 5 --json` and run reflect when 5 episodes have accrued since the last run.
