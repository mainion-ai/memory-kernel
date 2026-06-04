# Agent Session Loop

> **Audience:** AI agents using memory-kernel. This describes what to do, when, and why — covering every session, maintenance cadence, A2A handoff, and diagnostics.

## Overview

Memory-kernel is only useful if the loop is followed consistently. Skipping steps causes accumulation of stale atoms, an unbuilt relation graph, and missed connections. Each section below states the command, the frequency, and the reason it matters.

---

## Session Start

**Every session, before doing anything else:**

```bash
mk recall -d {dir} --task "description of what you're working on today" \
  --include-episodes \
  --decay-weight 0.3 \
  --decay-half-life 60 \
  --json
```

**Why each flag:**
- `--task` — enables FTS + semantic re-ranking; without it you get type-grouped atoms, not task-relevant ones
- `--include-episodes` — pulls in session episode summaries from EPISODES/; gives continuity across sessions without bloating atom count
- `--decay-weight 0.3` — weights recency at 30% of the score (default is 0.2); slightly favors recent atoms for most work
- `--decay-half-life 60` — atoms 60 days old score ~50% of fresh atoms; prevents old atoms from dominating recent work

If you are operating from a CLAUDE.md rendered nightly (NanoClaw default), the recall is already loaded for atoms written before the last render. **Still run `mk recall` manually if you did significant work after the last nightly render** — atoms written in the same day won't be in CLAUDE.md until the next cron run.

---

## During Session

### Write atoms as you learn things

```bash
# A verified fact
mk remember "The deploy pipeline takes ~4 minutes end-to-end" \
  -d {dir} -t fact --tags infrastructure,deploy

# A decision with rationale
mk remember "Use cursor pagination — offset pagination breaks under concurrent writes" \
  -d {dir} -t decision --tags api,performance

# An unverified hypothesis (will be promoted to fact at confidence ≥ 0.9 during reflect)
mk remember "The cache layer may reduce p99 by ~40% — untested" \
  -d {dir} -t belief --confidence 0.5 --tags performance,cache

# A stable user preference
mk remember "The repo owner approves infrastructure changes with a single word, no spec required" \
  -d {dir} -t preference --tags workflow,communication
```

**Do not write:** ephemeral task status, file contents, easily re-discovered info, or conversation small talk. Atoms persist — write only what is worth carrying forward.

### Create relation edges when you see connections

This step is the most commonly skipped. Skipping it starves the relation graph and degrades `mk wander` and `mk recall --graph` quality.

```bash
# When atom B extends or builds on atom A
mk relate BELI-2026-04-01-CACHE-HYPOTHESIS supports DECI-2026-03-15-USE-REDIS -d {dir}

# When new information supersedes old
mk relate FACT-2026-04-10-NEW-RATE-LIMIT supersedes FACT-2026-03-01-OLD-RATE-LIMIT -d {dir}

# When a belief contradicts another
mk relate BELI-2026-04-12-COUNTER-ARGUMENT contradicts BELI-2026-04-01-ORIGINAL-CLAIM -d {dir}
```

Relation types: `extends`, `contradicts`, `supports`, `caused_by`, `supersedes`, `applied_to`, `related`

Check an atom's connections anytime:
```bash
mk relations BELI-2026-04-01-CACHE-HYPOTHESIS -d {dir}
```

### Explore connections with wander

```bash
mk wander -d {dir} --tags philosophy,architecture --steps 5 --json
```

Run wander when exploring a new topic, when stuck, or during free time. Collisions in the output are atoms from different domains that activated together — these are worth investigating. No collisions means no unexpected connections found; move on.

**Which tags to wander on:** Use the tags of the domain you're entering, or seed from a specific atom you just wrote. If you want to audit an atom's neighborhood rather than a domain, use `--seed` instead of `--tags`:

```bash
# Domain entry
mk wander -d {dir} --tags infrastructure,performance --steps 5 --json

# Specific atom neighborhood
mk wander -d {dir} --seed BELI-2026-04-01-CACHE-HYPOTHESIS --steps 3 --json
```

**Session counting for every-5-sessions rule:** One episode = one session. Check your episode count with `mk episodes -d {dir} --limit 1 --json` and track the cadence yourself, or keep a `preference` atom like `"Last reflect: 2026-04-19, next at session 5"` and update it after each reflect run.

---

## Session End

**Every session, before closing:**

### Write an episode summary

```bash
mk episode -d {dir} \
  --session-id "$(date +%Y-%m-%d)-session-1" \
  --summary "[TOPIC] What this session was about
[DECISIONS] Key decisions made
[NEXT] What remains open or needs follow-up"
```

**Why episodes, not FACT atoms:** Episodes capture the arc of a session — context, decisions, open threads — in a format that `--include-episodes` can pull efficiently at session start. FACT atoms are for durable individual facts. Writing session state as FACT atoms pollutes the atom store with ephemeral content and inflates recall noise.

### Extract atoms from conversation log (optional)

If your orchestrator saves conversation logs, run extraction after each session to capture facts and decisions you may have missed:

```bash
mk extract ./conversation.log -d {dir} --skip-lines 200 --json
```

`--skip-lines` skips the CLAUDE.md preamble that was injected at session start (otherwise the extractor "discovers" atoms you already have). Extracted atoms are created as drafts with `source: auto-extracted` — they do not enter the active store or CLAUDE.md until consolidated.

**LLM choice:** Omit `--model` for Claude CLI (default, highest quality), or pass `--model qwen2.5:14b` for local Ollama (free, faster, slightly lower quality).

### Consolidate extracted drafts (periodic)

Review and promote auto-extracted drafts. Run after extraction, or batch weekly:

```bash
mk consolidate -d {dir} --dry-run --json    # preview first
mk consolidate -d {dir} --json              # promote to active
```

Consolidation detects duplicates against the active store via BM25 ranking and skips them. Use `--all` to include manually-created drafts too.

---

## Every 5 Sessions

```bash
mk reflect -d {dir}
mk gc -d {dir}
```

**Why reflect:** Deduplicates near-identical atoms, expires atoms past their TTL, promotes beliefs with confidence ≥ 0.9 to facts, and detects conflicts between atoms. Without regular reflect runs, stale and duplicate atoms accumulate and degrade recall quality.

**Why gc after reflect:** Reflect marks atoms as expired; gc archives them. Running gc without reflect first is safe but leaves atoms that reflect would have expired. The pair together keeps the store clean.

---

## Maintenance Cadence (Cron)

### Nightly — 02:00

```bash
mk render {memory-dir} {path/to/CLAUDE.md}
```

Refreshes CLAUDE.md so the next session starts with current memory. This is the minimum viable cron job — without it, CLAUDE.md goes stale after the first session.

### Weekly — Sunday 03:00

Run in this order:

```bash
# 1. Validate store integrity and semantic health
mk doctor -d {dir} --json
mk lint -d {dir} --json

# 2. Check for constitutive drift and entanglement
mk closure -d {dir} --trajectory --json

# 3. Build concept-name citation index (feeds wander activation)
mk citations -d {dir}

# 4. Surface implicit atom-to-atom connections from body text
mk relink -d {dir} --apply

# 5. Promote auto-extracted drafts
mk consolidate -d {dir} --json

# 6. Consolidate and expire
mk reflect -d {dir}
mk gc -d {dir}

# 7. Re-render with fresh index
mk render {memory-dir} {path/to/CLAUDE.md}
```

**Why each step:**

| Command | Why |
|---|---|
| `mk doctor` | Catches schema errors, broken links, and conflicts before they compound |
| `mk lint` | Semantic health: contradictions, stale atoms, orphans, near-duplicates, confidence drift, TTL warnings |
| `mk closure --trajectory` | Measures entanglement% and belief%; entanglement > 5% = constitutive drift risk; belief% > 80% = diversify atom types. **What drift looks like from the outside:** the agent starts reasoning in circles, over-references its own prior conclusions, and resists updating on new evidence. The closure metric catches this structurally before it becomes behaviorally obvious. |
| `mk citations` | Indexes concept-name references across atoms; feeds wander's activation scoring. Run this **before** `mk relink` — citations builds the concept index (used by wander), relink creates explicit graph edges (used by recall). They are separate commands because you may want to update the wander scoring without modifying the relation graph, or vice versa. |
| `mk relink --apply` | Finds atom ID references in body text and creates explicit relation edges; builds the graph that `mk recall --graph` traverses |
| `mk consolidate` | Promotes auto-extracted draft atoms to active after duplicate detection; completes the extract→consolidate lifecycle |
| `mk reflect` | Dedup, expire, promote — weekly catch for anything the every-5-session run missed |
| `mk gc` | Archive the atoms reflect marked expired |
| `mk render` | Publish the clean, consolidated state to CLAUDE.md |

### Weekly — Sunday 04:00 (only if Ollama is available)

```bash
mk enrich-relations -d {dir} --apply
```

Reclassifies generic `related` edges into specific typed relations using LLM inference. Ollama-only because this runs weekly and making API calls for every edge would have ongoing cost; a local model makes it free to run on cadence. The task suits smaller models well — edge classification is constrained-vocabulary, not open-ended generation. This is an optional quality improvement, not required for correct operation.

### Monthly — 1st of month, 04:00

```bash
mk compact -d {dir}
```

Compacts the event log — keeps only the latest mutation per atom, removes intermediate events. Without monthly compact, the event log grows unbounded and `mk replay` and `mk merge` slow down. Does not affect atoms or the SQLite index.

---

## A2A Handoff

When transferring memory context to another agent:

**Sender:**
```bash
mk checkpoint -d {dir} --json > handoff-bundle.json
# Send handoff-bundle.json to the receiving agent
```

**Receiver:**
```bash
# Always dry-run first — preview what will be imported
mk import --from handoff-bundle.json -d {dir} --dry-run

# If the preview looks correct, merge the event log
mk merge -d {dir} --from handoff-bundle.json

# Reindex after merge
mk reindex -d {dir}
```

**Why --dry-run first:** Import is additive — atoms already present will be skipped, but conflicts can arise. The dry-run shows exactly what will be added before any state changes.

---

## Diagnostics — When to Use What

| Situation | Command |
|---|---|
| Something seems wrong — atoms missing, recall feels off | `mk doctor -d {dir}` |
| Check for semantic issues: contradictions, stale atoms, orphans, duplicates | `mk lint -d {dir}` |
| Quick health check — counts, index status | `mk status -d {dir}` |
| Agent feels like it's reasoning in circles or over-referencing itself | `mk closure -d {dir} --trajectory` |
| Recall returns irrelevant atoms | `mk reindex -d {dir}` (rebuild index) |
| CLAUDE.md looks stale | `mk render {dir} {output}` |
| Want to see what two atoms have in common | `mk wander -d {dir} --seed ATOM-ID-A --seed ATOM-ID-B` |
| Need to see all edges on a specific atom | `mk relations {atom-id} -d {dir}` |

---

## What Not To Do

- **Don't skip `mk episode`** — writing session state as FACT atoms pollutes the store
- **Don't skip `mk relate`** — a graph with no edges degrades recall and wander quality
- **Don't run `mk gc` without `mk reflect` first** — you'll miss atoms that reflect would have expired
- **Don't skip `mk compact`** — the event log grows unbounded without it
- **Don't run `mk import` without `--dry-run` first** — preview before committing a merge
- **Don't write ephemeral task status as atoms** — "currently debugging X" is stale by next session
