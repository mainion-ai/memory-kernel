# PRD: memory-kernel v1 — Delivered Features

## 1. Overview

memory-kernel (mk) is a personal memory system for AI agents. It stores structured knowledge as markdown atoms — typed, timestamped, relationally linked files — and provides recall via SQLite FTS5 search with a multi-signal scoring stack. Agents ingest conversation logs, extract facts/beliefs/decisions/preferences, and recall relevant context at query time.

**Architecture:** File-first design. Each atom is a markdown file with YAML frontmatter (type, confidence, tags, relations, timestamps). A SQLite FTS5 index provides fast full-text search. An append-only event log tracks all mutations. The system runs as a CLI and integrates with NanoClaw for container-based agent sessions.

**Key properties:**
- Per-agent isolation with shared namespace support
- Token-budgeted recall to fit LLM context windows
- Privacy filtering (SECRET/PERSONAL atoms excluded from renders)
- Obsidian-compatible for visual graph exploration

---

## 2. Recall & Scoring

### FTS5 Search (#29, #33)

Full-text search uses SQLite FTS5 with OR semantics (PR #19). Queries match atoms containing any query term, with partial-match credit via coverage boost.

- **Multi-word query support** (#29): Rewrote `searchFts()` to pass terms correctly to FTS5. Fixed double-quoting bug that broke all multi-word queries. Impact: +5.4pp on LongMemEval (53.2% to 58.6%), temporal-reasoning +24.1pp.
- **OR semantics with coverage boost** (#33): Switched from AND to OR semantics. Coverage boost formula: `(matched_terms / total_terms)^0.5`. Configurable via `RECALL_COVERAGE_BOOST` env var (default 0.5).

### Scoring Stack (#31, #32, #33)

Multi-signal scoring pipeline applied to FTS results:

| Signal | Issue | Description | Config |
|--------|-------|-------------|--------|
| IDF damping | #31 | Penalizes atoms with promiscuous vocabulary (appear in many contexts) | `RECALL_IDF_DAMPING` (default 1.0) |
| Length normalization | #32 | Normalizes scores by atom body length to prevent long atoms from dominating | `RECALL_LENGTH_NORM_K` (default 0.5) |
| Coverage boost | #33 | Rewards atoms matching more query terms under OR semantics | `RECALL_COVERAGE_BOOST` (default 0.5) |
| Decay weight | — | Time-based decay biasing toward recent atoms | `RECALL_DECAY` (default 0.2) |

### MMR Diversity (#34)

Maximal Marginal Relevance reranking prevents redundant atoms from filling the token budget. Uses trigram-based similarity with lambda=0.7. Applied to both task and no-task recall paths.

LongMemEval impact: negligible on benchmark accuracy (+/- 1.4pp), but improves result diversity in dense stores where type-weight dominance was observed.

### Episode Scoring (#30)

Session episodes scored through the FTS pipeline with relevance and decay, replacing earlier bulk-include approach. Episodes participate in the same token budget as atoms.

### Per-Agent Isolation (#40)

Multi-agent memory isolation with per-agent recall. Agents have separate memory stores within a shared namespace. Implemented across PRs #9-#13 with isolation config, per-agent recall, shared atom support, and bootstrap caching.

---

## 3. CLI Tools

| Command | Issue | Description |
|---------|-------|-------------|
| `mk lint` | #35 | Semantic health checker: orphan atoms, contradictions, stale atoms, TTL warnings. Supports `--json` output. Tested on Taj store (77 atoms, 15 findings) and Mai store (165 atoms, 28 findings, 11 warnings). |
| `mk extract` | #36 | Automatic atom extraction from conversation logs using LLM. Supports `--dry-run`, `--json`, `--model` flags. FTS duplicate detection. Type classification: FACT, DECI, BELI, OPEN. |
| `mk consolidate` | #37 | Draft atom lifecycle management: review and promote draft atoms to active status. BM25 duplicate detection with `--duplicate-threshold`. `--all` flag for batch processing. |
| `mk obsidian-init` | #39 | Obsidian-native compatibility: wikilinks, tag promotion, `graph.json` color groups. `--sync` flag for ongoing updates. Tested on 87 atoms with clean round-trip. |
| `mk render` | #43 | CLAUDE.md rendering with configurable token budget (`MK_RENDER_BUDGET`) and automatic SECRET/PERSONAL atom filtering. |
| `mk wander` | — | Belief exploration via random collision of atoms. Generates wander sessions that produce new beliefs from unexpected juxtapositions. |
| `mk reflect` | — | Structured reflection on memory store contents. Generates synthesis atoms from existing knowledge. |

### Supporting Changes

- **Stale relation type canonicalization** (#38): Automatic migration of deprecated relation types (seeded, complements, synthesizes, qualifies, evidenced_by, grounds, refines) during atom promotion.
- **Juggl removal** (#54, #55): Removed Juggl typed-link frontmatter, kept Obsidian-native graph with wikilinks only.

---

## 4. Quality Baselines

Evaluation via LongMemEval_S benchmark (500 instances, 6 question types). Testbench at mainion-ai/mk-testbench (#42).

### R8d Baseline (Current Best)

**Configuration:** Sonnet synthesis, scoring stack (IDF + length norm + coverage boost), OR FTS semantics, decay=0.2, MMR enabled.

| Question Type | Accuracy | Count |
|---------------|----------|-------|
| knowledge-update | 79.5% | 73 |
| multi-session | 76.7% | 120 |
| single-session-user | 74.3% | 105 |
| temporal-reasoning | 71.4% | 63 |
| single-session-assistant | 41.1% | 90 |
| single-session-preference | 0.0% | 49 |
| **Overall** | **66.8%** | **500** |

### Key Findings from Evaluation Runs

| Run | Config Change | Result | Finding |
|-----|--------------|--------|---------|
| R1 | Baseline (broken FTS) | 53.2% | FTS was broken for multi-word queries |
| R2 | Fixed FTS | 58.6% | +5.4pp from FTS fix alone |
| R3 | decay=0 | 60.0% | Helps single-session-user (+10pp), hurts single-session-assistant (-12.5pp) |
| R5 | Scoring stack | 59.8% | IDF + length norm + coverage boost |
| R6 | Scoring stack + decay=0 | 36.2% | OR semantics requires decay signal (-22.4pp) |
| R7 | R5 + episode bulk-include | 31.2% | Bulk inclusion overwhelms synthesis (-28.6pp) |
| R8d | Scoring stack + decay=0.2 + Sonnet | 66.8% | Best result; model choice matters (Opus vs Sonnet) |

---

## 5. Architecture Decisions

### File-First (Markdown Atoms)

Atoms are markdown files with YAML frontmatter. This ensures portability, human readability, version control compatibility, and Obsidian integration. The SQLite FTS5 index is a derived artifact that can be rebuilt from files.

### SQLite FTS5 Index

Full-text search via SQLite FTS5 provides fast, dependency-free search without external services. The index is rebuilt from atom files on demand. OR semantics with coverage boost balance recall breadth against precision.

### Event Log

Append-only event log tracks all mutations (create, update, delete, promote, deprecate). Enables audit trails, debugging, and potential replay.

### Typed Relations

Atoms link to each other via typed relations: extends, supports, contradicts, supersedes, relates. Relations are stored in atom frontmatter and indexed for graph traversal. Relation types are schema-validated; deprecated types are auto-canonicalized (#38).

### Token Budgets

Recall results are bounded by configurable token budgets to fit LLM context windows. Budget allocation is split between atoms and episodes. The render pipeline (`mk render`) uses a separate budget (`MK_RENDER_BUDGET`).

### Privacy Filtering

Atoms tagged SECRET or PERSONAL are excluded from rendered CLAUDE.md output (#43). They remain in the store for direct queries but do not appear in constitution renders.
