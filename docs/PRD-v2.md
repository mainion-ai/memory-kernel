# PRD: memory-kernel v2 — Planned Features

## 1. Quality Gates

All v2 changes must meet the following gates before merge:

| Gate | Threshold | Source |
|------|-----------|--------|
| LongMemEval overall | >= 66.8% (R8d baseline) | #42 |
| All tests pass | 1091+ tests green | CI |
| knowledge-update | >= 79.5% | R8d |
| multi-session | >= 76.7% | R8d |
| single-session-user | >= 74.3% | R8d |
| temporal-reasoning | >= 71.4% | R8d |
| single-session-assistant | >= 41.1% | R8d |

No per-type regression beyond 2pp is acceptable. Any change that improves one type at the expense of another must demonstrate net-positive overall accuracy.

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

**Problem:** single-session-preference is 0% across ALL runs (R1-R8d). This is a structural write-end failure — preferences are ingested but not stored in a format that supports preference-type queries.

**Solution:** Store preference atoms with structured format (key-value or tagged) that enables preference-specific recall.

**Acceptance criteria:**
- Preference atoms stored with structured format (key-value or tagged)
- single-session-preference > 0% on LongMemEval
- mk recall returns relevant preference atoms for preference queries

**Dependencies:** #46 (write-selection bias fix may surface additional preference ingestion issues)

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

### 5.1 Answer Health Check (#48)

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
4. Quality gates checked: overall >= 66.8%, no per-type regression > 2pp, all tests pass
5. PR merged to main

### Priority Order

1. **Ingestion fixes** (#46, #47) — highest impact. single-session-assistant and single-session-preference are the weakest types. Fixing write-end gaps should yield the largest accuracy gains.
2. **Recall improvements** (#44, #45) — medium impact. Episode scoring and content-type decay improve result quality without changing what gets stored.
3. **Testing infrastructure** (#48, #53) — enables confident iteration. Answer health check prevents misattribution. Additional framework covers write-end blind spots.
4. **CLI & automation** (#51, #52) — quality of life. Consolidation automation reduces manual overhead.
5. **Infrastructure** (#49, #50) — cost optimization and constitution quality.
