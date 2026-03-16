---
name: memory-kernel
description: Structured typed memory with event-log replay, confidence scoring, and conflict detection. Use for facts, decisions, constraints, beliefs, and open questions — when structure matters more than fuzzy recall.
---

# memory-kernel

memory-kernel stores memories as **typed atoms** — not flat notes. Each atom has a type, confidence score, optional TTL, and classification.

## Atom types — always pick the most specific one

| Type | When to use | Example |
|---|---|---|
| `fact` | Objective information you observed or were told | "Server is hosted on AWS us-east-1", "API rate limit is 1000 requests/hour" |
| `decision` | A choice that was made — always include rationale in the body | "We chose TypeScript for new modules because of better IDE support and type safety" |
| `constraint` | A rule or requirement that must not be violated | "Never deploy on Fridays after 2PM", "All PRs require 2 approvals" |
| `belief` | Something probably true but uncertain — pair with `confidence: 0.5–0.7` | "Performance issue is probably related to database indexing", "User drop-off likely due to onboarding complexity" |
| `open_question` | An unresolved question worth tracking across sessions | "Should we migrate from REST to GraphQL?", "What's the optimal cache TTL?" |

## Security Classification

Set classification based on sensitivity — affects encryption and audit trail:

| Level | When to use | Storage |
|---|---|---|
| `PUBLIC` | Safe for anyone (most facts, decisions) | Plain text |
| `TEAM` | Internal team info (constraints, beliefs) | Plain text |
| `PERSONAL` | Private preferences, notes, drafts | Plain text |
| `SECRET` | Sensitive info, credentials, private decisions | AES-256-GCM encrypted |

Example: `mk_remember type="decision" classification="SECRET" ...` for sensitive architectural decisions.

## Coexistence with LCM

memory-kernel **complements** (not replaces) OpenClaw's LCM system:

- **LCM**: Session transcripts, conversation history, semantic search over past interactions
- **memory-kernel**: Structured facts, decisions, constraints, beliefs with confidence scoring
- **Use both**: mk_recall for rules/decisions, memory_search for conversation context

**Integration workflow:**
1. Use `memory_search` to find relevant past conversations
2. Use `mk_recall` to load active constraints and recent decisions
3. Work with both contexts when making new decisions
4. Use `mk_remember` to capture new structured knowledge

## mk_recall vs memory_search — when to use which

Use **`mk_recall`** when you need:
- Active constraints and decisions (use `types: ["decision", "constraint"]`)
- FTS5 keyword precision over semantic fuzzy matching
- Typed, structured context for a specific task (`task` param enables re-ranking)
- Confidence-scored information with conflict detection

Use the built-in **`memory_search`** for:
- Fuzzy semantic recall over unstructured notes or past conversations
- "Find anything related to X" when you don't know the type
- Browsing historical context and session transcripts

## Tool Guide

### `mk_remember`
Call when the user makes a decision, states a rule, shares a fact worth preserving, or explicitly asks to remember something. Always pick the most specific type. Set `confidence` below `1.0` for uncertain information. For decisions, include the rationale in the body.

**Usage patterns:**
- User says "Let's use React for the frontend" → `mk_remember type="decision"`
- "API must return within 100ms" → `mk_remember type="constraint"`
- "Database seems slow during peak hours" → `mk_remember type="belief" confidence=0.7`

### `mk_recall`
Call at session start or when you need structured context. Pass `task` to get results ranked by relevance to what you're doing. Use `types: ["decision", "constraint"]` to load active rules without noise from facts.

**Usage patterns:**
- Session start: `mk_recall task="current project context"`
- Before making decisions: `mk_recall types=["constraint", "decision"]`
- Research mode: `mk_recall task="API design" types=["fact", "belief"]`

### `mk_reflect`
Call at end of session. Expires TTL'd atoms, deduplicates redundant atoms, auto-promotes high-confidence beliefs to facts, surfaces conflicts, and regenerates all view files. Also call after merging a remote memory directory.

**Handles automatically:**
- Expires atoms past their TTL
- Promotes `belief` atoms with confidence > 0.9 to `fact`
- Detects contradictory atoms and marks conflicts
- Rebuilds FTS5 search index

### `mk_context_bundle`
Call when you want a single pre-assembled Markdown document with current context. Runs reflect + recall in one call. Best for session start when you need a full picture before beginning work.

**Use cases:**
- Starting a complex task and need full context
- Handoff between sessions or agents
- Creating a summary of current state

## Conflict Resolution

When `mk_reflect` surfaces conflicts between atoms:

1. **Review conflicts:** Use `mk_recall` to examine conflicting atoms
2. **Investigate:** Check timestamps, confidence scores, and sources
3. **Decide:** Determine which information is authoritative
4. **Resolve:** 
   - Create new atom with correct information
   - Use `resolve_conflict` tool to mark conflict as handled
   - Or update existing atom if partial truth

**Example workflow:**
```
mk_recall types=["conflict"]  # See what's conflicted
mk_remember type="fact" text="Corrected information based on latest data"
# Tool automatically links resolution to original conflict
```

## Session Patterns

**Session start:**
1. `mk_context_bundle` or `mk_recall task="current work"`
2. `memory_search` for any relevant conversation history

**During work:**
- `mk_remember` for important decisions, facts, constraints
- `mk_recall` when you need to check existing rules/decisions

**Session end:**
- `mk_reflect` to clean up and surface any conflicts