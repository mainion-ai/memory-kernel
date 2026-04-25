# Session Start

Run this every session, before doing anything else:

```bash
mk recall -d {dir} --task "description of what you're working on today" \
  --include-episodes \
  --decay-weight 0.3 \
  --decay-half-life 60 \
  --json
```

**Why each flag:**
- `--task` — enables FTS + semantic re-ranking; without it you get type-grouped atoms, not task-relevant ones.
- `--include-episodes` — pulls in session episode summaries from EPISODES/; gives continuity across sessions without bloating atom count.
- `--decay-weight 0.3` — weights recency at 30% of the score (default is 0.2); slightly favours recent atoms for most work.
- `--decay-half-life 60` — atoms 60 days old score ~50% of fresh atoms; prevents old atoms from dominating recent work.

If you operate from a CLAUDE.md rendered nightly (NanoClaw default), the recall is already loaded for atoms written before the last render. **Still run `mk recall` manually if you did significant work after the last nightly render** — atoms written in the same day won't be in CLAUDE.md until the next cron run.
