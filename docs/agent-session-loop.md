# Agent Session Loop

> **Audience:** AI agents using memory-kernel. This describes the standard lifecycle for maintaining memory across sessions.

## The Loop

```
┌─────────────────────────────────────────────────────────┐
│                    SESSION START                         │
│                                                         │
│  CLAUDE.md loaded automatically (NanoClaw)              │
│  — OR —                                                 │
│  mk recall -d {dir} --task "current task"               │
│                                                         │
│  You now have: facts, decisions, beliefs, preferences,  │
│  open questions, constraints from previous sessions.    │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│                   DURING SESSION                        │
│                                                         │
│  As you work, retain what matters:                      │
│                                                         │
│  mk remember "..." -d {dir} -t fact    ← verified      │
│  mk remember "..." -d {dir} -t decision ← choices      │
│  mk remember "..." -d {dir} -t belief   ← hypotheses   │
│  mk remember "..." -d {dir} -t preference ← user prefs │
│                                                         │
│  Optional — explore connections:                        │
│  mk wander -d {dir} --tags tag1,tag2 --json             │
│  → Collisions? Worth investigating.                     │
│  → No collisions? Move on.                              │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│                    SESSION END                           │
│                                                         │
│  mk render {dir} {path/to/CLAUDE.md}                    │
│  → Updates CLAUDE.md so next session has new knowledge  │
│                                                         │
│  Optional (usually handled by nightly cron):            │
│  mk reflect -d {dir} --agent-id X --session-id Y       │
│  → Deduplicates, expires old atoms, promotes beliefs    │
│    with confidence ≥ 0.9 to facts                       │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│              POST-CONVERSATION (NanoClaw)                │
│                                                         │
│  2-minute silence → mk wander --json (automatic)        │
│  → No collisions? Skip drift. (zero cost)               │
│  → Collisions? Spawn directed drift session.            │
│    Agent explores the specific connections found.        │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│                   NIGHTLY CRON                           │
│                                                         │
│  23:00 → mk reflect (consolidate, expire, promote)      │
│        → mk render (fresh CLAUDE.md)                    │
│        → git push (backup, optional)                    │
│                                                         │
│  Next session starts with clean, consolidated memory.   │
└─────────────────────────────────────────────────────────┘
```

## What to Remember

### Good atoms (high signal)

- **Facts**: Infrastructure details, API endpoints, rate limits, system architecture
- **Decisions**: Why you chose X over Y, with rationale
- **Constraints**: Rules that must not be violated (security policies, compliance)
- **Preferences**: How the user likes things done (communication style, tool choices)
- **Procedures**: Multi-step processes you've worked out (deploy steps, debug workflows)
- **Beliefs**: Hypotheses worth tracking — they get promoted to facts when confidence hits 0.9

### Bad atoms (noise)

- Ephemeral task status ("currently debugging X" — stale by next session)
- Easily re-discoverable info (file contents, git history, API docs)
- Duplicate of something already in CLAUDE.md
- Overly specific conversation details ("user said hi at 3pm")

### Confidence guide

| Confidence | Meaning | Example |
|-----------|---------|---------|
| 1.0 | Verified fact | "The API rate limit is 1000 req/min" (tested) |
| 0.9 | High confidence, near-fact | "PostgreSQL handles our workload well" (observed) |
| 0.7 | Strong belief | "Cursor pagination will scale better" (reasoned) |
| 0.5 | Hypothesis | "The cache layer might reduce p99 latency" (untested) |
| 0.3 | Speculation | "We might need to shard eventually" (uncertain) |

Beliefs with confidence ≥ 0.9 get promoted to facts during `mk reflect`.

## Wander — Finding Connections

`mk wander` is a spreading activation engine. It walks the tag co-occurrence graph to find atoms from different domains that activate together — unexpected structural connections.

```bash
# From tags (most common)
mk wander -d {dir} --tags philosophy,architecture --steps 5 --json

# From specific atoms
mk wander -d {dir} --seed BELI-2026-03-14-NOTATION-AS-ERASURE --steps 3 --json
```

**When to wander:**
- Between tasks, during quiet moments
- When exploring a new topic (what do I already know that connects?)
- When you feel stuck (wander often surfaces unexpected angles)

**Reading the output:**
```json
{
  "collisions": [
    {
      "atom_a": "BELI-notation-as-erasure",
      "atom_b": "DECI-accounting-trust-hierarchy",
      "shared_tags": ["notation", "architecture"],
      "score": 0.42,
      "type_a": "belief",
      "type_b": "decision"
    }
  ],
  "activated": [...],
  "duration_ms": 12
}
```

- **Collisions** are the interesting part — pairs of atoms from different types/domains that lit up together
- High `score` = stronger structural connection
- `duration_ms` should be <30ms — this is pure computation, no LLM

## Container vs Native Differences

| Aspect | Container | Native |
|--------|-----------|--------|
| Memory path | `/workspace/extra/memory` | `~/mk-memory` (or custom) |
| CLAUDE.md path | `/workspace/group/CLAUDE.md` | `~/path/to/nanoclaw/groups/{name}/CLAUDE.md` |
| `mk` invocation | `npx mk` (or `/tmp` workaround) | `mk` (global install) or `npx mk` |
| `mk reflect` | Usually not needed (nightly cron) | Same — nightly cron handles it |
| `mk wander` | Available, same usage | Available, same usage |
| File access | Limited to mounts | Full filesystem |

See [container quickref](agent-quickref-container.md) or [native quickref](agent-quickref-native.md) for environment-specific details.
