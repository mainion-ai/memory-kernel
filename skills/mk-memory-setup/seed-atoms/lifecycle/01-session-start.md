# Session Start

Run this every session, before doing anything else.

**First, confirm the binary you're running** (a stale `mk` on PATH silently breaks everything downstream — embeddings, new flags, recall semantics):

```bash
mk --version    # compare against the expected-version atom; if it differs, fix PATH before proceeding
```

Then recall context:

```bash
mk recall -d {dir} --task "description of what you're working on today" \
  --embed \
  --include-episodes \
  --decay-weight 0.3 \
  --decay-half-life 60 \
  --json
```

**Why each flag:**
- `--task` — enables FTS + semantic re-ranking; without it you get type-grouped atoms, not task-relevant ones.
- `--embed` — use the embedding (semantic) recall path, not FTS-only. Conceptual queries that miss on exact keywords (e.g. "how does the user prefer to communicate") only surface the right atom with `--embed`. This is the flag you want; **omit it** to fall back to FTS-only (offline, or no embedding key). If `mk doctor`'s `embedding-key-source` check reports unconfigured, set `EMBEDDING_API_KEY` first — otherwise `--embed` silently degrades to FTS.
- `--include-episodes` — pulls in session episode summaries from EPISODES/; gives continuity across sessions without bloating atom count.
- `--decay-weight 0.3` — weights recency at 30% of the score (default is 0.2); slightly favours recent atoms for most work.
- `--decay-half-life 60` — atoms 60 days old score ~50% of fresh atoms; prevents old atoms from dominating recent work.

If you operate from a CLAUDE.md rendered nightly (NanoClaw default), the recall is already loaded for atoms written before the last render. **Still run `mk recall` manually if you did significant work after the last nightly render** — atoms written in the same day won't be in CLAUDE.md until the next cron run.
