# PRD: Memory Kernel for AI Agents (Single + Multi-Agent)

**Status:** Draft v1.0  
**Date:** 2026-03-02  
**Owner:** (you)  
**Audience:** Product, Engineering, Research/Evals, Security/Privacy, QA/Infra, Integrations

---

## Table of contents

1. Executive summary  
2. Problem statement  
3. Goals and non-goals  
4. Personas and use cases  
5. Success metrics  
6. Product scope and milestones  
7. Functional requirements  
8. Non-functional requirements  
9. Architecture  
10. Existing systems to extend  
11. Implementation notes (practical engineering guidance)  
12. Testing strategy (unit, feature, system, eval)  
13. Rollout and migration  
14. Risks and mitigations  
15. Open questions  
16. Appendix: schemas, tool contracts, and checklists  

---

## 1) Executive summary

We will build a **Memory Kernel**: a model-agnostic, local-first memory substrate for single agents and multi-agent collaboration that prevents context degradation, compaction loss, and cross-session amnesia while enabling safe, testable, portable long-term memory.

**Core premise:** memory is not “more context.” Memory is a *typed system* with explicit invariants and lifecycle controls.

### Memory Kernel = 3 stores + 3 operations

**Stores**
1. **Evidence Store (immutable)**: artifacts, transcripts, diffs, tool outputs.  
2. **Event Log (append-only)**: “what happened,” as structured events.  
3. **State Views (materialized)**: curated semantic/procedural memory in structured markdown.

**Operations**
- **Retain:** capture event + minimal state update.
- **Recall:** task-scoped, hierarchical context loading (progressive disclosure).
- **Reflect:** consolidate, dedupe, validate, promote, decay, and surface conflicts.

For multi-agent systems, treat memory as a distributed systems problem: **event sourcing + CRDT-style merges**, with explicit conflict surfacing and resolution workflows.

---

## 2) Problem statement

### 2.1 Observed failures to eliminate

1. **Compaction loss:** summarization drops:
   - precise numbers and parameters  
   - conditional logic  
   - decision rationale  
   - cross-doc relationships  
   - open questions that must remain open  
2. **Signal dilution:** monolithic “stuff everything into one file” approaches reduce adherence and increase contradictions.  
3. **Multi-agent inconsistency:** parallel agents diverge; discoveries and updates do not converge safely.  
4. **No forgetting:** memory accumulates noise; retrieval quality and agent reliability degrade.  
5. **Security ambiguity:** persistent memory crosses scopes without explicit classification/consent.

### 2.2 Why common fixes fail

- Bigger context windows and “just keep chat logs” increase noise and degrade attention allocation.
- Vector-store-only “memory RAG” often lacks: (a) explicit invariants, (b) update semantics, (c) conflict semantics, (d) deterministic replay.

---

## 3) Goals and non-goals

### 3.1 Goals (must-haves)

**G1. Deterministic memory correctness**
- No silent loss of numbers, rules, rationale, relationships, or open questions in durable state.

**G2. Progressive disclosure**
- Load minimal routing context at session start; fetch only relevant memory on demand.
- Support hierarchical/domain-scoped memory.

**G3. Multi-agent concurrency**
- Multiple writers; safe merges; explicit conflict surfacing; eventual convergence.

**G4. Curation + forgetting**
- TTL/decay, promotion, dedupe, staleness review, and archival.

**G5. Security and privacy**
- Classified memory (public/team/personal/secret), encryption for secrets, auditable access.

**G6. Portability**
- Memory stored in model-agnostic “packets” (markdown + YAML frontmatter).

### 3.2 Non-goals (v1)

- Updating model weights (this is external memory, not training).
- Replacing orchestration frameworks (we integrate with them).
- Perfect semantic recall in all domains (v1 focuses on correctness, lifecycle, and system semantics).

---

## 4) Personas and primary use cases

### 4.1 Personas

1. **Solo builder:** one agent across many sessions, wants reliable persistence + handoffs.  
2. **Team / multi-agent org:** multiple agents/humans collaborating, needs shared state and conflict handling.  
3. **Security-sensitive org:** secrets and personal data must be contained and auditable.  
4. **Framework integrator:** wants an SDK/MCP server to plug into existing agents.

### 4.2 Primary use cases

- **U1: Session handoff** with minimal context load.
- **U2: Reliable decisions/constraints** surviving compaction and time.
- **U3: Multi-agent collaboration** with convergent shared state.
- **U4: Intentional forgetting** via TTL/decay and promotion.
- **U5: Cross-tool continuity** via MCP + portable memory packets.

---

## 5) Success metrics

### 5.1 Product metrics

- **Retention fidelity score**: % of required structured fields preserved after N sessions/compactions  
  - Target: ≥ 0.99 for durable state views  
- **Context efficiency**: median startup context tokens vs baseline  
  - Target: ≥ 5× reduction  
- **Conflict surfacing**: time to detect and record conflict  
  - Target: immediate (same merge cycle)  
- **Signal-to-noise**: human-rated recall usefulness  
  - Target: +25% vs baseline  

### 5.2 Benchmark metrics (evaluation suite)

- Long-horizon interactive memory: **LongMemEval**  
  - https://arxiv.org/abs/2410.10813  
- Long-term conversational memory: **LoCoMo**  
  - https://arxiv.org/abs/2402.17753  

---

## 6) Product scope and milestones

### 6.1 MVP (v0.1): single-agent file-first kernel

- Directory layout + templates
- Checkpoint/handoff generator
- Context loader (task/path scoped)
- TTL + promotion + garbage collection (archive)
- CLI + SDK (local filesystem backend)

### 6.2 v1.0: multi-agent + MCP integration

- Formal event log and replay
- Merge semantics (CRDT-backed shared views)
- Conflict surfacing + resolver workflow hooks
- MCP server exposing memory tools/resources

### 6.3 v2: pluggable backends + enterprise controls

- Optional backends: SQLite/Postgres/S3/vector stores/temporal KG
- AuthZ, KMS integration, policy packs
- Continuous eval dashboards (benchmarks + regression gates)

---

## 7) Functional requirements

### 7.1 Memory stores (data plane)

#### FR-1 Evidence Store (immutable)

- Stores or references artifacts:
  - file snapshots, diffs, tool outputs, URLs, datasets
- Append-only or content-addressed (hash-based)
- Supports provenance links from events and state views

#### FR-2 Event Log (append-only episodic)

- Each agent action emits a structured event:
  - timestamp, agent_id, session_id, touched_paths, action_type, evidence pointers
- Event log is system-of-record for “what happened”
- Supports replay to rebuild state views deterministically

#### FR-3 State Views (materialized semantic/procedural)

- Human-readable markdown, machine-parseable (YAML frontmatter + structured sections)
- Required views:
  - `INDEX.md` (routing/map of memory; kept intentionally small)
  - `HANDOFF.md` (current working state)
  - `DECISIONS.md`
  - `CONSTRAINTS.md`
  - `OPEN_QUESTIONS.md`
  - `ENTITIES/*.md`
- Views are derived from events via deterministic transforms + validated optional LLM assistance

---

### 7.2 Memory operations (control plane)

#### FR-4 Retain (capture)

- On meaningful events:
  - append to event log
  - update minimal views (e.g., add open question, add decision draft)
- Never silently overwrite conflicting assertions

#### FR-5 Recall (retrieve)

- Progressive disclosure:
  - always load: routing + current state (index/handoff/constraints)
  - conditionally load: domain/entity/decisions related to task + touched_paths
  - episodic logs are retrieved *on-demand* only
- Retrieval modes:
  - deterministic (path/tag/id)
  - semantic (optional embeddings)
  - graph-based (optional relationship traversal)

#### FR-6 Reflect (curate / consolidate)

- Triggered by:
  - manual checkpoint
  - end-of-session
  - context budget threshold
  - scheduled job
- Performs:
  - dedupe
  - TTL/expiry and archiving
  - promotion (belief → fact)
  - link validation
  - conflict detection + surfacing
- Output must be schema-valid and canonicalized

---

### 7.3 Templates that prevent compaction loss

#### FR-7 Typed templates for memory atoms

Every durable memory item must be representable as a **Memory Atom**:

- Stored as markdown file or section with YAML frontmatter.
- Required atom types:
  - `decision`, `constraint`, `open_question`, `belief`, `fact`, `procedure`, `entity_summary`, `preference`, `conflict`

**Required fields**
- `id`, `type`, `status`, `confidence`, `created_at`, `updated_at`, `ttl_days`
- `scope` (paths/domains)
- `provenance` (event ids and/or evidence pointers)
- `links` (relationships to other atoms)

**Required “compaction-resistant” sections**
- Numbers / parameters
- Conditional logic
- Rationale
- Cross-links
- Explicit open questions list (if any)

---

### 7.4 Curation and forgetting

#### FR-8 TTL + decay

- Default TTL by type (configurable):
  - debug/workarounds: 30d
  - hypotheses/beliefs: 14–30d unless promoted
  - preferences: 180d (reviewable)
  - constraints: no TTL but requires periodic review flag
- Expired atoms moved to `ARCHIVE/` (no hard delete by default)

#### FR-9 Promotion policy (“beliefs → facts”)

- Newly extracted items default to `belief` with confidence < 1
- Promotion triggers:
  - user confirmation
  - corroboration across ≥ N independent episodes
  - authoritative evidence (e.g., repo config)
- Conflicts remain multi-valued until resolved

---

### 7.5 Multi-agent memory semantics

#### FR-10 Concurrent writers

- Multiple agents can write events and propose updates concurrently (offline/online).

#### FR-11 Convergent merges

- Shared views must merge such that replicas converge.
- Recommended: CRDT library (Automerge or Yjs) to represent shared state, then render markdown views from CRDT state.

References:
- CRDT foundations: https://www.lip6.fr/Marc.Shapiro/papers/2011/CRDTs_SSS-2011.pdf  
- Automerge: https://github.com/automerge/automerge  
- Yjs: https://github.com/yjs/yjs  

Minimum merge types:
- OR-Set: open questions/tasks
- MV-Register: conflicting facts
- LWW-Register: low-stakes preferences (configurable)

#### FR-12 Conflict surfacing (never hide)

- If agents disagree:
  - store both values (MV-register)
  - attach provenance + confidence
  - create/update a `conflict` atom and link to impacted items
- Resolution requires explicit action (human or resolver agent)

---

### 7.6 Security and privacy

#### FR-13 Data classification

Each atom/evidence item classified:
- `PUBLIC`, `TEAM`, `PERSONAL`, `SECRET`

Enforced by:
- storage location rules
- recall gating rules
- export rules

#### FR-14 Encryption at rest (SECRET)

- Encrypt SECRET at rest (envelope encryption)
- Key mgmt pluggable:
  - OS keychain (local)
  - KMS (enterprise)

#### FR-15 Auditability

- Log reads/writes:
  - who/what/when/why
- Exportable audit trail

---

### 7.7 Portability

#### FR-16 Memory Packet format

- Canonical format: markdown + YAML frontmatter
- Export/import:
  - Letta core memory blocks
  - LangGraph stores/checkpointers
  - Mem0 stores
  - MCP tools/resources

---

### 7.8 Interfaces

#### FR-17 CLI (local-first)

- `mk init`
- `mk checkpoint`
- `mk recall --task "...“ --paths ...`
- `mk reflect`
- `mk gc`
- `mk merge --from <remote>`
- `mk doctor` (schema/link/conflict validation)

#### FR-18 SDK

- `retain(event)`, `recall(query)`, `reflect()`, `gc()`, `merge(remote)`

#### FR-19 MCP server

Expose memory operations as MCP tools/resources:
- Tools: `remember`, `recall`, `reflect`, `merge`, `gc`, `list_conflicts`, `resolve_conflict`, `get_context_bundle`
- Resources: “decision log,” “constraints,” “handoff,” “open questions”
- MCP spec: https://modelcontextprotocol.io/specification/2025-11-25

---

## 8) Non-functional requirements

- **Reliability:** atomic writes, crash safety, durable event appends  
- **Performance:** recall p95 < 50ms for common lookups (excluding embeddings); incremental reflect  
- **Observability:** metrics + tracing (“why is this in memory?”)  
- **Determinism:** same events + rules → identical views; LLM output must be validated and canonicalized  

---

## 9) Architecture

### 9.1 Components

1. Filesystem backend (default) + optional SQLite index
2. Event logger (append-only)
3. View materializer (reflect engine)
4. Context loader (recall router)
5. Merge engine (CRDT or deterministic merges)
6. Policy engine (classification, encryption, gating)
7. MCP server (optional)
8. Adapters (Claude Code, LangGraph, Letta, Mem0, Zep, etc.)

### 9.2 Canonical on-disk layout

```text
/memory/
  INDEX.md
  HANDOFF.md
  CONSTRAINTS.md
  DECISIONS.md
  OPEN_QUESTIONS.md
  ENTITIES/
    <entity>.md
  EPISODES/
    2026-03-01_session-17.md
  EVIDENCE/
    <hash>.<ext>
  CONFLICTS/
    <conflict-id>.md
  ARCHIVE/
    ...
```

### 9.3 Claude Code compatibility mode (important)

Claude Code supports:
- hierarchical `CLAUDE.md` loading across directory trees  
- modular `.claude/rules/` with optional path scoping via YAML frontmatter  
- auto memory directory with `MEMORY.md` index where only first ~200 lines are preloaded; topic files loaded on demand  

Reference: https://code.claude.com/docs/en/memory

**Adapter requirements**
- Maintain a **≤200-line** routing index compatible with Claude Code startup behavior.
- Put heavy content in topic files (e.g., `memory/topics/<topic>.md`).
- Optionally generate `.claude/rules/*.md` from constraints/decisions, using path scoping.

---

## 10) Existing systems to extend (buy vs build guidance)

We should integrate before reinventing.

### 10.1 Claude Code memory (strong baseline for file-first + hierarchy)
- Docs: https://code.claude.com/docs/en/memory
- Strengths: directory scoping, rules modularity, startup index discipline
- Gaps for full scope: typed invariants enforcement, event sourcing, TTL/promotion, multi-agent convergence across machines

### 10.2 MCP as integration bus
- Spec: https://modelcontextprotocol.io/specification/2025-11-25
- Strengths: standard tool/resource transport
- Gaps: none (we implement server)

### 10.3 Mem0 + Mem0 MCP server (fast “memory CRUD tools”)
- Repo: https://github.com/mem0ai/mem0-mcp
- Strengths: ready MCP memory CRUD; quick adoption
- Gaps: deterministic views + schema + conflict semantics + TTL/promotion (varies)

### 10.4 LangGraph persistence + LangMem (framework-native state)
- Persistence: https://docs.langchain.com/oss/python/langgraph/persistence  
- LangMem: https://blog.langchain.com/langmem-sdk-launch/
- Strengths: resumability and memory extraction integration in LangGraph
- Gaps: file-first portability contract, distributed merge semantics

### 10.5 Letta (MemGPT lineage) (memory-first runtime)
- Repo: https://github.com/letta-ai/letta
- Strengths: memory hierarchy runtime concepts
- Gaps: file-first auditable templates, CRDT shared state by default

### 10.6 Zep (temporal KG memory service)
- Paper: https://arxiv.org/abs/2501.13956
- Strengths: temporal KG + evaluation claims
- Gaps: file-first contract, local-first operation (depends on deployment)

### 10.7 CRDT libraries
- Automerge: https://github.com/automerge/automerge  
- Yjs: https://github.com/yjs/yjs  

---

## 11) Implementation notes (practical engineering guidance)

This section is intentionally specific: it converts the PRD into engineering constraints and design patterns that prevent the known failure modes.

### 11.1 Make the system replayable (event sourcing discipline)

**Rule:** treat the Event Log as source of truth.

- Write events in a structured, machine-friendly format:
  - NDJSON (`events.ndjson`) or per-session JSON/markdown with strict frontmatter.
- Each event includes:
  - `event_id` (ULID/UUID), `timestamp`, `agent_id`, `session_id`
  - `action_type` (`decision_proposed`, `constraint_added`, `question_opened`, etc.)
  - `touched_paths` (for context routing)
  - `evidence` pointers (hash ids / file refs)
  - optional `atom_refs` (which atoms were changed or proposed)

**Deterministic rebuild**
- `reflect()` must be able to rebuild views from:
  - event log + evidence + current policy config
- This is crucial for:
  - corruption recovery
  - deterministic tests
  - auditability

### 11.2 Views should be derived, not “hand-edited truth”

Allow hand-edits, but treat them as *events*:
- “human_edit_view” is an event with a diff in evidence.
- The materializer reconciles human edits by producing new atoms/events rather than silently drifting.

### 11.3 Canonicalization is not optional

If you want deterministic outputs and good diffs:
- Sort YAML keys consistently
- Normalize timestamps (UTC ISO8601)
- Normalize list ordering where meaningful
- Enforce stable section headings (“Decision”, “Why”, “Conditional Logic”, “Numbers”, etc.)
- Use a formatter on every write (`mk fmt` as part of pipeline)

### 11.4 Atomic writes + crash safety

For each file write:
1. write to temp file in same directory
2. `fsync()` temp
3. atomic rename over target
4. `fsync()` directory (where supported)

Event appends:
- open file with append + flush + fsync, or use a journaled store (SQLite WAL)

### 11.5 Fast recall: add an index (without abandoning file-first)

Files are truth; an index is a cache:
- SQLite index keyed by:
  - atom id
  - type/status
  - tags
  - touched_paths
  - relationships (edges)
  - classification
  - TTL/expiry
- Optional vector index for semantic recall (pluggable)

### 11.6 Progressive disclosure: keep startup cheap

Enforce budgets:
- `INDEX.md` target: ≤ 200 lines (Claude Code compatible)
- `HANDOFF.md` target: ≤ 1–2 pages
- everything else loaded on demand

Context router algorithm (simple baseline):
- Always include: INDEX, HANDOFF, CONSTRAINTS
- Include entities/decisions where:
  - scope overlaps touched_paths OR
  - referenced by open questions OR
  - tagged as “active”
- Include conflicts that overlap touched scope

### 11.7 Multi-agent sync: pick a single “truth shape”

Two viable patterns:

**Pattern A: CRDT-first**
- Shared state is a CRDT document (Automerge/Yjs)
- Markdown views are rendered snapshots
- Pros: strong convergence; offline-first friendly
- Cons: extra layer + rendering

**Pattern B: Event log + deterministic reducers**
- Each replica has events; merge = union of events
- State views = reducer(events)
- Pros: very auditable; simpler storage
- Cons: conflicts must be encoded at reducer level

Recommendation for v1:
- Start with **event log union + reducer** (simpler, auditable).
- Add CRDT document for shared “high-churn views” (tasks/OQs) where concurrency is common.

### 11.8 Conflict handling: never let “last write wins” hide reality

Default to MV-register semantics for facts that matter:
- store both values
- attach provenance
- create a conflict atom with:
  - conflicting values
  - impacted atoms
  - recommended resolver steps
  - resolution status

### 11.9 Security: enforce recall gating in code, not by convention

- Classification attached to every atom/evidence file.
- Default recall excludes PERSONAL and SECRET unless explicitly requested and policy allows.
- Add secret scanning in CI to prevent accidentally committing SECRET.

### 11.10 MCP server design notes

Tool surfaces should be small and composable:
- `remember(atom)` — validates schema, writes event, updates store
- `recall(query)` — returns a context bundle with citations/provenance
- `reflect()` — runs reducer/materializer + validations
- `merge(remote)` — merges events/state
- `gc()` — TTL/archival
- `list_conflicts()` / `resolve_conflict()`

Ensure all tool outputs include:
- `provenance` pointers so the agent can justify and trace memory

---

## 12) Testing strategy (automated)

We treat memory as infrastructure: correctness and regressions must be testable.

### 12.1 Unit tests (deterministic; run on every PR)

- **Schema parsing/validation**
- **Canonicalization golden tests**
- **TTL/GC idempotence** (`gc(gc(x)) == gc(x)`)
- **Promotion policy**
- **Conflict detection**
- **Merge properties** (commutative/associative/idempotent if using CRDT merges)
- **Policy gating** (SECRET never leaks into default recall)
- **Atomic write safety** (simulated interruption)

### 12.2 Feature/integration tests (filesystem + adapters; run on every PR)

- checkpoint → correct HANDOFF/INDEX
- recall → scoped bundle with minimal bloat
- reflect → deterministic output (run twice identical)
- link validation → broken links surface as errors
- import/export → round-trip equivalence
- MCP contract tests → tool schemas and basic calls
- Claude Code mode → generated `MEMORY.md` within startup constraints

### 12.3 System/E2E tests (multi-process; nightly)

- multi-agent concurrent updates converge
- partition + heal merge correctness
- fault injection (kill mid-write) + recovery via replay
- performance load tests (10k atoms, 100k events)
- security regressions (attempted leakage, audit logs present)

### 12.4 Benchmarks/evals (LLM-in-the-loop; nightly/weekly)

- LongMemEval regression suite: https://arxiv.org/abs/2410.10813  
- LoCoMo regression suite: https://arxiv.org/abs/2402.17753  
- Synthetic compaction-loss torture tests:
  - numbers + conditional logic + rationale + links + open questions
  - verify state views retain required fields after many steps

### 12.5 CI gating plan

- PR: unit + feature tests + lint + schema checks + secret scanning
- Nightly: system tests + performance
- Weekly: benchmarks (LongMemEval/LoCoMo) and trend reports

---

## 13) Rollout and migration

### 13.1 Phases

1. **Alpha:** local-only, file-first kernel + checkpoint/handoff
2. **Beta:** shared team repo mode + event merges + conflicts
3. **GA:** MCP server + encryption + audit + benchmark gating

### 13.2 Migration paths

- Ingest existing:
  - `CLAUDE.md`, `MEMORY.md`, `README.md`, `SKILL.md`
  - chat logs and tool logs → EPISODES + EVIDENCE
- Provide `mk import`:
  - parse known patterns → atoms (best-effort)
  - flag uncertain extractions as beliefs with low confidence

---

## 14) Risks and mitigations

- **Framework fatigue:** mitigate by keeping contract as plain files; automation optional.
- **LLM nondeterminism in reflect:** mitigate with schema validation + canonicalization + replay.
- **CRDT merges violate invariants:** mitigate with post-merge validation and conflict atoms.
- **Security leaks through recall:** mitigate with enforced gating + audits + encryption.

---

## 15) Open questions

1. Default backend besides filesystem (SQLite as index? SQLite as event log?)  
2. Evidence storage: embed vs reference (git objects, object store, hash store)  
3. Resolver workflow UX: human UI vs resolver agent vs both  
4. MCP version strategy (support latest only vs multiple)  
5. Choose CRDT library (Automerge vs Yjs) or pure event-log reducers in v1  

---

## 16) Appendix

### A) Memory Atom example

```yaml
---
id: DEC-2026-03-01-API-PAGINATION
type: decision
status: accepted
confidence: 0.9
created_at: 2026-03-01T10:22:00Z
updated_at: 2026-03-01T10:40:00Z
ttl_days: null
scope:
  paths: ["services/api"]
classification: TEAM
provenance:
  episodes: ["EP-2026-03-01_session-17"]
  evidence: ["EVIDENCE/ab12cd34.json"]
links:
  related: ["ENT-items-service"]
  supersedes: ["DEC-2026-02-10-OFFSET-PAGINATION"]
---
```

```markdown
## Decision
We will use cursor-based pagination (opaque cursor) for `/v2/items`.

## Why (rationale)
- Offset pagination regressed performance beyond ~1M rows.
- Cursor avoids COUNT(*) and deep offsets.

## Conditional logic
- IF client requests `limit > 100`, THEN clamp to 100.
- IF cursor is invalid, THEN return 400 `CURSOR_INVALID`.

## Numbers / parameters
- max_limit: 100
- default_limit: 25
- SLA: p95 < 200ms

## Open questions
- OQ-17: Cursor should encode sort key + tiebreaker or only PK?
```

### B) Reference links (engineering)

- Claude Code memory: https://code.claude.com/docs/en/memory  
- MCP spec (2025-11-25): https://modelcontextprotocol.io/specification/2025-11-25  
- CRDT foundations: https://www.lip6.fr/Marc.Shapiro/papers/2011/CRDTs_SSS-2011.pdf  
- Automerge: https://github.com/automerge/automerge  
- Yjs: https://github.com/yjs/yjs  
- Mem0 MCP server: https://github.com/mem0ai/mem0-mcp  
- LangGraph persistence: https://docs.langchain.com/oss/python/langgraph/persistence  
- LangMem launch: https://blog.langchain.com/langmem-sdk-launch/  
- Letta: https://github.com/letta-ai/letta  
- Zep temporal KG paper: https://arxiv.org/abs/2501.13956  
- LongMemEval: https://arxiv.org/abs/2410.10813  
- LoCoMo: https://arxiv.org/abs/2402.17753  

### C) QA checklist (quick)

- [ ] No silent loss of numbers/logic/rationale/links/open questions  
- [ ] Deterministic replay rebuilds views byte-identically  
- [ ] Default recall excludes SECRET and PERSONAL  
- [ ] Conflicts are visible and resolvable  
- [ ] Index/handoff remain within budget constraints  
- [ ] GC/TTL is idempotent and reversible via archive  
- [ ] Multi-agent merge converges under partitions/healing  
- [ ] MCP tools pass contract tests and return provenance  

---

**End of document**
