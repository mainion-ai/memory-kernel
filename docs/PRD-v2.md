# PRD: memory-kernel v2 — Planned Features

## 1. Quality Gates

> **IMPORTANT:** R1-R10 baselines were invalidated — the GPT-4o judge accepted "I don't know" as correct answers, inflating all numbers. R12 is the first honest baseline using the fixed judge. See [BELI-STABLE-BIAS-MASQUERADES-AS-SIGNAL](../docs/atoms/BELI-2026-05-01-STABLE-BIAS-MASQUERADES-AS-SIGNAL-IN-EVA-1rlao.md) for the full analysis.

### Two-Number Reporting

All evaluations MUST report both metrics:
- **Overall accuracy** — correct / total (includes abstentions as incorrect)
- **Real-answer accuracy** — correct / non-abstention answers (synthesis quality)
- **Abstention rate** — how often the system says "I don't have enough information" (retrieval gap)

### Baselines (R15b — observer pipeline, fixed GPT-4o judge)

| Type | Accuracy | N |
|------|----------|---|
| single-session-user | 94% | 70 |
| knowledge-update | 72% | 78 |
| single-session-assistant | 66% | 56 |
| multi-session | 52% | 133 |
| single-session-preference | 50% | 30 |
| temporal-reasoning | 46% | 133 |
| **Overall** | **60.8%** | **500** |

Abstention rate: **0%** (observer produces answers for all questions).

Previous baseline (R12, retrieval-only): 32.0% overall, 53.2% abstention. Observer approach nearly doubled accuracy and eliminated abstentions entirely.

### Quality Gates for Merge

| Gate | Threshold | Notes |
|------|-----------|-------|
| Overall accuracy | >= 60.8% (R15b) | No regression from baseline |
| All tests pass | 1105+ tests green | CI |
| Abstention rate | 0% (R15b) | Observer eliminates abstention |
| Per-type regression | <= 5pp for N<100, <= 2pp for N>=100 | Adjusted for sample size |

### Per-Layer Diagnostics (recommended)

When investigating regressions, check three layers separately:
1. **Ingestion** — is the gold answer in the stored atoms?
2. **Recall** — does mk recall retrieve atoms containing the answer?
3. **Synthesis** — does the model extract the answer from retrieved context?

R12 diagnostic found: 70% of failures were at Layer 2 (recall). R13 (hybrid FTS + semantic) reduced abstention by 3.4pp. R14-R15b (observer approach) eliminated abstention entirely by compressing conversations into dated observations at ingestion time, bypassing retrieval.

### Benchmark Coverage

| Benchmark | What it tests | Status |
|-----------|--------------|--------|
| LongMemEval (500 instances) | Read-end recall across 6 question types | Operational (R12 baseline) |
| MemoryAgentBench (FactConsolidation) | Conflict resolution — newer facts overriding older | Adapter built, not yet run |

---

## 2. Recall Improvements

### 2.1 Episode FTS Scoring (#44)

**Problem:** Bulk episode inclusion overwhelmed the synthesis step. R7 showed -28.6pp regression from R5 when episodes were bulk-included. R4 showed +4pp on 50 single-session-user instances, but the effect was catastrophically negative at full scale.

**Solution:** Score episodes through the FTS pipeline with relevance ranking. Token budget shared between atoms and episodes with configurable ratio.

**Acceptance criteria:**
- Episodes scored through FTS pipeline with relevance ranking
- Token budget shared between atoms and episodes (configurable ratio)
- LongMemEval with episodes >= 66.8% baseline (R8d)
- single-session-user improvement maintained

### 2.2 Content-Type-Aware Decay (#45)

**Problem:** A single global decay weight is suboptimal across question types. R3 showed decay=0 helps single-session-user (+10pp) but hurts single-session-assistant (-12.5pp). R6 confirmed decay=0 with OR semantics is catastrophic (-22.4pp overall).

**Solution:** Per-type decay weight configuration. Different content types benefit from different temporal biasing.

**Acceptance criteria:**
- Per-type decay weight configuration (e.g., user-facts: 0.0, assistant-responses: 0.3, temporal: 0.2)
- LongMemEval >= 66.8% overall
- single-session-user >= 74% AND single-session-assistant >= 41%

### 2.3 Constitution Pipeline: Graph-Walk Recall (#50)

**Problem:** CLAUDE.md render uses the same query-driven FTS recall as task queries. Constitution content (identity, core beliefs) should be selected by graph topology, not by FTS relevance to a specific query.

**Solution:** Graph-walk-based recall mode for constitution/render. Follow relation edges (extends, supports, contradicts) with spreading activation. Hub atoms (high in-degree) prioritized.

**Acceptance criteria:**
- Separate recall mode for constitution/render
- Graph-walk follows relation edges (extends, supports, contradicts)
- Hub atoms (high in-degree) prioritized
- Token budget respected

---

## 3. Ingestion Fixes

### 3.1 Write-Selection Bias for Assistant Utterances (#46)

**Problem:** single-session-assistant is the worst-performing type at 41.1% (R8d). The ingestion pipeline stores user facts but not assistant responses (recommendations, advice, facts shared), creating a systematic write-end gap.

**Solution:** Capture assistant-generated content as queryable atoms during session ingestion.

**Acceptance criteria:**
- Assistant utterances stored as atoms during session ingestion
- single-session-assistant >= 55% on LongMemEval
- No regression on other types

### 3.2 Preference Ingestion Format (#47)

**Problem:** single-session-preference is 0% across ALL runs (R1-R8d). This is a structural write-end failure — preferences are ingested but not stored in a format that supports preference-type queries. The observer pipeline (R15b) improved this to 50% by capturing preferences in observation summaries, but the atom-level ingestion remains broken.

**Solution:** Two-part fix:
1. **Observer prompt enhancement** — ensure the observer explicitly captures stated preferences with structured markers (e.g., "PREFERENCE: user prefers X over Y")
2. **Atom ingestion** — when `mk extract` processes conversations, preferences should be stored as `type: preference` atoms with structured key-value frontmatter (subject, preference, context)

**Acceptance criteria:**
- Preference atoms stored with `type: preference` and structured frontmatter (subject, preference, context)
- `mk extract` recognizes preference statements and creates preference-typed atoms
- Observer prompt includes explicit preference-capture instructions
- LongMemEval single-session-preference >= 60% (up from 50% R15b)
- No regression on other types

**Evidence:** R15b shows 50% on preferences via observer alone. The gap is that preferences captured as observations lack the structured format needed for precise preference-type queries. Structured atoms would enable both observer (broad capture) and recall (precise retrieval) to serve preference queries.

### 3.3 Semantic Conflict Detection for mk supersede (#54)

**Problem:** `mk supersede` infrastructure works (PR #69, #71) but is never triggered because the conflict detection heuristic is too naive. The MAB adapter uses first-5-words matching, which completely misses structural conflicts like knowledge-graph triples ("The capital of the country where X was born is Y"). MemoryAgentBench FactConsolidation score: ~1% (same as no-supersede baseline).

**Evidence:** Taj ran 800 MAB contexts (May 12, 2026). Zero supersedes fired. The mk supersede command itself works perfectly (smoke-tested: old atom → superseded status, new atom gets relation, PR #66 filters superseded from recall). The gap is entirely in DETECTING which atoms conflict.

**Solution:** Two candidate approaches (evaluate both, pick one):

1. **LLM-based pairwise comparison** — At ingestion time, for each new fact atom, retrieve top-N semantically similar existing atoms, then ask a cheap model (Haiku/GPT-4o-mini) "do these two facts conflict?" for each pair. Accurate but O(N) LLM calls per ingestion (where N = number of similar existing atoms, typically 3-10).

2. **Entity-triple extraction** — At ingestion time, extract subject-predicate-object triples from each atom. Store triples in SQLite index. On new atom ingestion, match on subject+predicate overlap. When a match is found with different object values, trigger `mk supersede`. Structured, no LLM cost at detection time, but requires NLP extraction at write time.

**Hybrid approach (recommended):** Entity-triple extraction as Tier 1 filter (cheap, deterministic), LLM confirmation as Tier 2 for ambiguous cases. This follows the two-tier pattern: deterministic check first, escalate to probabilistic only when needed.

**Acceptance criteria:**
- Conflict detection integrated into `mk extract` or `mk observe` pipeline
- Automatically invokes `mk supersede` when a newer fact contradicts an older one
- MemoryAgentBench FactConsolidation >= 30% (up from ~1%)
- LongMemEval knowledge-update >= 72% (no regression from R15b)
- False positive rate < 10% (non-conflicting atoms incorrectly superseded)

**Dependencies:** mk supersede (#69, #71) — ✅ delivered. mk extract (#36) — ✅ delivered.

---

## 4. CLI & Automation

### 4.1 Concept-Name Citation Extraction (#51)

**Problem:** mk citations command extracts concept references but does not detect when the same term is used differently across atoms (speciation).

**Solution:** Multi-word concept name detection and speciation flagging.

**Acceptance criteria:**
- Citation extraction handles multi-word concept names
- Speciation detection flags same-name-different-meaning cases
- Integration with mk lint for citation health warnings

### 4.2 Consolidation Automation (#52)

**Problem:** mk extract creates draft atoms. mk consolidate promotes them. The pipeline is currently manual. Should be automatable with configurable review cadence.

**Solution:** Scheduled consolidation with auto-promotion and manual review flagging.

**Acceptance criteria:**
- Scheduled consolidation with configurable frequency
- Auto-promote atoms below duplicate threshold after N days
- Report generated for manual review of flagged duplicates

**Dependencies:** #36 (mk extract), #37 (mk consolidate)

---

## 5. Testing

### 5.1 Answer Health Check (#48) — PARTIALLY DELIVERED

**Status:** Partially delivered — evaluate.py v4 has resume, rate-limit detection, health check, and parallel support. Fixed judge rejects abstentions. Remaining: per-layer diagnostic automation.

**Problem:** R8, R8b, and R8c all produced invalid results from CLI failures and rate limits that were not detected until manual inspection. R8 was misattributed to MMR (PR #20) when the actual cause was 95 empty answers from CLI failures.

**Solution:** Pre-accuracy health check in the evaluation pipeline.

**Acceptance criteria:**
- Health check runs before accuracy computation
- Flags runs with >5% empty answers
- Flags runs with rate-limit messages in answers
- Flags runs with >10% identical repeated answers
- Prints warning banner on flagged runs

**Repo:** mainion-ai/mk-testbench

### 5.2 Additional Test Framework (#53)

**Problem:** LongMemEval measures read-end recall accuracy but not write-end ingestion quality, preference handling, or temporal precision. single-session-preference is 0% across all runs, undetectable by LongMemEval alone.

**Solution:** Research and select a complementary evaluation framework covering failure modes LongMemEval does not.

**Acceptance criteria:**
- Research completed: survey of available memory benchmarks
- Framework selected or custom suite designed
- Covers at least: write-end validation, preference recall, temporal precision
- Integrated into CI or scheduled evaluation

---

## 6. Infrastructure

### 6.1 Configurable Model and Effort (#49)

**Problem:** All agents run on Opus 4.7 with adaptive reasoning for every task — wander sessions, health checks, simple replies. Burns ~1M tokens/day in background tasks. Sonnet with medium effort is sufficient for most.

**Solution:** Environment variables (CLAUDE_MODEL, CLAUDE_EFFORT, CLAUDE_THINKING) passed through to Claude Agent SDK query() options.

**Acceptance criteria:**
- CLAUDE_MODEL, CLAUDE_EFFORT, CLAUDE_THINKING env vars read by agent-runner
- Passed to SDK query() options
- Per-task override via task env config
- Log line confirms active config

**Repo:** NanoClaw (not mk). Implementation: 26 lines in agent-runner/src/index.ts. Branch: feat/configurable-model-effort.

---

## 7. Process

### Dev Workflow

| Role | Responsibilities |
|------|-----------------|
| Mai | Product direction, implementation, PRs |
| Taj | Testing, validation, LongMemEval runs, quality gate enforcement |

### GitHub Issues Lifecycle

1. Issue created with requirement, motivation, acceptance criteria, and evidence
2. Branch created, implementation, PR opened
3. Taj runs LongMemEval on PR branch
4. Quality gates checked: overall >= 60.8%, abstention = 0%, no per-type regression > 5pp (N<100) or 2pp (N>=100), all tests pass
5. PR merged to main

### Priority Labels

| Priority | Issues | Rationale |
|----------|--------|-----------|
| **P0** — Critical | #44 (episode FTS) ✅, #45 (content-type decay) — reverted, #46 (assistant utterances) ✅ | Direct LongMemEval/production impact. Addresses the three weakest recall areas. |
| **P1** — High | #47 (preference ingestion), #54 (conflict detection) | #47: preference recall structural gap. #54: MAB FactConsolidation at ~1%, supersede infrastructure unused without detection. |
| **P2** — Medium | #48 (answer health check), #49 (model/effort config), #50 (constitution pipeline), #51 (citations), #52 (consolidation automation) | Infrastructure and tooling. Enables confident iteration and cost optimization. |
| **P3** — Research | #53 (additional test framework) | Research task. Identify complementary evaluation coverage for write-end blind spots. |
