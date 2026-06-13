---
name: memory-kernel
description: Structured typed memory with event-log replay, confidence scoring, temporal decay, type-aware ranking, typed relation edges, and conflict detection. Use for facts, decisions, constraints, beliefs, and open questions — when structure matters more than fuzzy recall.
---

# memory-kernel

memory-kernel stores memories as **typed atoms** — not flat notes. Each atom has a type, confidence score, optional TTL, and classification.

## Atom types — always pick the most specific one

| Type | When to use |
|---|---|
| `fact` | Objective information you observed or were told |
| `decision` | A choice that was made — always include rationale in the body |
| `constraint` | A rule or requirement that must not be violated |
| `belief` | Something probably true but uncertain — pair with `confidence: 0.5–0.7` |
| `open_question` | An unresolved question worth tracking across sessions |

## mk_recall vs memory_search — when to use which

Use **`mk_recall`** when you need:
- Active constraints and decisions (use `types: ["decision", "constraint"]`)
- FTS5 keyword precision over semantic fuzzy matching
- Typed, structured context for a specific task (`task` param enables re-ranking)

Use the built-in **`memory_search`** for:
- Fuzzy semantic recall over unstructured notes or past conversations
- "Find anything related to X" when you don't know the type

## Tool guide

**`mk_remember`**
Call when the user makes a decision, states a rule, shares a fact worth preserving, or explicitly asks to remember something. Always pick the most specific type. Set `confidence` below `1.0` for uncertain information. For decisions, include the rationale in the body.

**`mk_recall`**
Call at session start or when you need structured context. Pass `task` to get results ranked by relevance to what you're doing. Use `types: ["decision", "constraint"]` to load active rules without noise from facts.

**`mk_reflect`**
Call at end of session. Expires TTL'd atoms, deduplicates redundant atoms, auto-promotes vetted draft atoms to active (status-only, tiered by type — open_questions immediately; facts/preferences/decisions after 48h at confidence ≥ 0.7 with no active contradiction; beliefs/procedures held for review), surfaces conflicts, and regenerates all view files. Also call after merging a remote memory directory.

**`mk_context_bundle`**
Call when you want a single pre-assembled Markdown document with current context. Runs reflect + recall in one call. Best for session start when you need a full picture before beginning work.

**`mk_status`**
Call to check memory health: atom counts by type, index status, embedding count. Use when diagnosing recall issues or verifying memory state.

## Automatic lifecycle behavior

The plugin handles these automatically — you don't need to call them:

- **Bootstrap**: On agent startup, relevant memories are recalled and injected into context. In isolated mode, both agent-private and shared atoms are included. Runtime agent identity is extracted from OpenClaw event context when available.
- **Pre-compaction**: Before context compaction, a checkpoint is saved so nothing is lost. In isolated mode, the checkpoint includes both agent and shared atoms.
- **Session end**: When `/new` or `/reset` is used, reflect runs automatically and an episode is written.
