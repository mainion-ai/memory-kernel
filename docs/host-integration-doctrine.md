# Host Integration Doctrine

How to make a host (OpenClaw, Claude Code hooks, a custom agent framework, etc.) actually use memory-kernel as its primary durable-memory layer — not just expose the tools and hope for the best.

Distilled from a real production transition on OpenClaw. The machinery was ready long before the system behaved kernel-first; what made the difference was aligning the host's doctrine (operating instructions + compaction routing) with the three-layer model below.

## Target architecture

Three layers, clear primacy, nothing removed:

| Layer | Role | Tools |
|---|---|---|
| **Primary** — memory-kernel | Durable structured knowledge: facts, decisions, constraints, beliefs, open_questions, procedures, preferences, entity_summaries | `mk_context_bundle`, `mk_recall`, `mk_remember`, `mk_reflect` |
| **Secondary** — transcript / legacy search | Exact prior-conversation wording, old transcript recall, unstructured legacy notes | host-provided search (e.g. `memory_search`) |
| **Support** — files | Daily logs, raw pasted material, imported docs, long-form human-readable references, archives | `memory/*.md` direct reads |

If any layer tries to be the primary for everything, the system drifts. Keep each layer's job small and well-defined.

## Doctrine (host operating instructions)

### AGENTS.md template

```markdown
## Every Session
1. Read identity + user context files
2. Call `mk_context_bundle` (optionally with `task=...`) — primary durable recall

## Memory System (MEMORY-KERNEL-FIRST, files as support layer)

### Primary: Memory-Kernel (`mk_*` tools)
- Facts, decisions, constraints, beliefs, open_questions, procedures, preferences, entity_summaries
- "remember this" → `mk_remember` with the most specific atom type
- Prior decisions/facts/rules → `mk_recall` (pass `task` when you know it)
- Session start / handoff → `mk_context_bundle`

### Secondary: transcript / legacy search
- Exact prior-conversation wording, old transcripts, unstructured legacy notes

### Support: Files (`memory/*.md`)
- Daily logs → `memory/YYYY-MM-DD.md`
- Raw pasted material, imported docs, long-form references
```

### MEMORY.md template

```markdown
Memory is structured in layers with clear primacy:
- **memory-kernel atoms** (`mk_*` tools) = source of truth for durable structured knowledge
- **transcript/legacy search** = recall of prior wording and unstructured legacy notes
- **`memory/*.md`** = support layer for daily logs, raw material, imports, archives
```

## Compaction prompt

If your host runs a compaction step that asks the agent to "save anything worth keeping", the prompt must route durable content to `mk_remember` **first**, not back into the file layer. Otherwise every compaction silently undoes the primacy shift.

Working prompt template:

```
Before compaction, save anything worth keeping. Route each item by type:

1. **Structured durable knowledge** → `mk_remember` (memory-kernel, PRIMARY)
   - fact, decision, constraint, belief, open_question, procedure, preference, entity_summary
   - Pick the most specific atom type. Decisions must include rationale. Beliefs carry confidence < 1.
   - Check with `mk_recall` first to avoid duplicate atoms.

2. **Daily scratch / transient / session-specific** → `memory/YYYY-MM-DD.md` (today's date)

3. **Large raw reference material** → topic `memory/*.md` file

4. **Already saved or trivial** → skip

Reply NO_REPLY after writing (or if nothing needs saving).
```

## Retrieval order

Default order at session start and during work:

1. `mk_context_bundle(task=...)` — startup / handoff
2. `mk_recall(task=...)` — focused durable lookup mid-session
3. `memory_search` — **only** for exact prior-conversation wording, transcript lookup, unstructured legacy
4. Direct file reads — daily logs, imported docs, large human-readable references

Agents that reach for secondary/support tools first will drift the system back to file-first.

## What belongs in memory-kernel

Promote **only durable structured knowledge**. Good candidates:
- safety / destructive-command constraints
- stable workflow rules and quality gates
- infra / tool facts (SSH hosts, service URLs, build recipes)
- durable user preferences (communication style, defaults)
- agent roster and role separation
- long-lived decisions with rationale
- open questions still awaiting resolution

## What stays in files

The file layer is not failure — it's the archive layer. Keep in `memory/*.md`:
- daily logs
- raw pasted notes
- imported docs
- archives
- long writeups and research dumps
- historical reference material

## Promotion workflow (files → atoms)

When promoting knowledge out of an existing markdown file:

1. Read the source file.
2. Extract only durable structured items (fact / decision / constraint / etc.).
3. Check existing atoms first with `mk_recall` to avoid duplicates.
4. Add only missing items via `mk_remember`, picking the most specific type.
5. Keep the source file as support/reference unless it's truly redundant.
6. Optionally add a top-of-file note that durable items were promoted and the file remains as human-readable support.

Do **not** bulk-copy whole files into atoms. Migration is opportunistic, done whenever the file is touched.

### Suggested migration order

If further migration is needed:
1. Rules and constraints
2. Identity and preferences
3. Infra / tool facts
4. Agent workflow rules
5. Domain-specific procedures (trading, support, code review, ...)
6. Selected durable decisions

Avoid migrating volatile history (backtest results, long logs, giant dumps) — those belong in files.

## Health checks

A healthy kernel-first integration shows:
- Plugin / tool wiring enabled with a valid manifest (where applicable); no loader errors.
- `mk status` (or `mk_status`) healthy — atoms indexed, embeddings populated if configured.
- Doctrine files aligned with the three-layer model above.
- Compaction prompt routes durable memory to `mk_remember` first.
- Agents demonstrably using `mk_*` tools at session start (not just when asked).
- Host observability signals (if the host exposes them, e.g. `mk: bootstrap injected N atoms`) visible in session output.

If any of those are off, the doctrine will drift regardless of how polished the tooling is.

## Related guides

- [Session loop](agent-session-loop.md) — when agents should remember / recall / reflect
- [Native quickref](agent-quickref-native.md) / [Container quickref](agent-quickref-container.md) — per-environment setup
- [CLI integration](cli-integration.md) — direct CLI with `--json` output
- [OpenClaw plugin INSTALL](../packages/openclaw-memory-kernel/INSTALL.md) — wiring for OpenClaw hosts
