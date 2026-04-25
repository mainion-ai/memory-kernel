# Session End

Run before closing every session.

## Write an episode summary

```bash
mk episode -d {dir} \
  --session-id "$(date +%Y-%m-%d)-session-1" \
  --summary "[TOPIC] What this session was about
[DECISIONS] Key decisions made
[NEXT] What remains open or needs follow-up"
```

**Why episodes, not FACT atoms:** episodes capture the arc of a session — context, decisions, open threads — in a format that `--include-episodes` can pull efficiently at session start. FACT atoms are for durable individual facts. Writing session state as FACT atoms pollutes the atom store with ephemeral content and inflates recall noise.

## Extract atoms from conversation log (optional)

If your orchestrator saves conversation logs, run extraction after each session to capture facts and decisions you may have missed:

```bash
mk extract ./conversation.log -d {dir} --skip-lines 200 --json
```

`--skip-lines` skips the CLAUDE.md preamble injected at session start (otherwise the extractor "discovers" atoms you already have). Extracted atoms are created as drafts with `source: auto-extracted` — they do not enter the active store or CLAUDE.md until consolidated.

**LLM choice:** omit `--model` for Claude CLI (default, highest quality), or pass `--model qwen2.5:14b` for local Ollama (free, faster, slightly lower quality).

## Consolidate extracted drafts (periodic)

Review and promote auto-extracted drafts. Run after extraction, or batch weekly:

```bash
mk consolidate -d {dir} --dry-run --json    # preview first
mk consolidate -d {dir} --json              # promote to active
```

Consolidation detects duplicates against the active store via BM25 ranking and skips them. Use `--all` to include manually-created drafts too.
