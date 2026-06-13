# SDK Reference

Full TypeScript API for memory-kernel. For a quick overview, see the [README](../README.md).

## Installation

```bash
npm install memory-kernel
```

## Imports

```typescript
import {
  initMemoryDir,
  createAtom,
  updateAtom,
  archiveAtom,
  resolveConflict,
  recall,
  reflect,
  checkpoint,
  replay,
  replayFromFile,
  bootstrapEvents,
  hashEvidence,
  writeEvidence,
  readEvidence,
  readEvents,
  compactLog,
  reindex,
  searchFts,
  indexExists,
  writeEpisode,
  readEpisode,
  listEpisodes,
  linkEpisodeToAtom,
  mergeEventLogs,
  importFromFile,
  previewImport,
  renderClaudeMd,
  wander,
  wanderFromFiles,
  // Semantic search (opt-in — requires EMBEDDING_PROVIDER + EMBEDDING_API_KEY)
  recallWithEmbeddings,
  embedAtom,
  embedAllAtoms,
  semanticSearch,
  semanticSearchSync,
  getEmbeddingConfig,
  embedText,
  embedBatch,
  cosineSimilarity,
  dotProduct,       // v1.20.0+ — unit-norm KNN inner loop
  normalizeVector,  // v1.20.0+ — L2-normalize to unit length
  serializeVector,
  deserializeVector,
  atomToEmbeddingText,
  isEmbeddingStale,
  embeddingStats,
  // Relations (v1.4.0+)
  getRelationsForAtom,
  addRelation,
  getAllRelations,
  getAllAtomIds,
  // Relink — body-text relation extraction (v1.5.0+)
  relinkAll,
  relinkAtom,
  extractBodyReferences,
  inferRelationType,
  // Citations — concept-name citation extraction (v1.6.0+)
  extractCitations,
  indexCitations,
  deriveConceptNames,
  // Extract — automatic atom extraction from conversation logs (v1.15.0+)
  extractFromLog,
  // Consolidate — promote auto-extracted drafts (v1.15.0+)
  consolidateAtoms,
} from 'memory-kernel';
```

---

## Core Operations

### Initialize a memory directory

```typescript
initMemoryDir('./memory');
```

Creates `ENTITIES/`, `ARCHIVE/`, `EVIDENCE/`, `CONFLICTS/`, `EPISODES/`, and `events.ndjson`.

### Create an atom (retain)

```typescript
const atom = createAtom({
  memoryDir: './memory',
  agent_id: 'my-agent',
  session_id: 'session-1',
  type: 'decision',
  slug: 'use-cursor-pagination',
  body: '## Decision\nUse cursor-based pagination.\n\n## Why\nOffset degrades beyond 1M rows.',
  confidence: 0.95,
  scope: {
    tags: ['api', 'performance'],
    paths: ['/services/api'],
  },
});
```

### Create a belief

```typescript
createAtom({
  memoryDir: './memory',
  agent_id: 'my-agent',
  session_id: 'session-1',
  type: 'belief',
  slug: 'redis-faster-than-memcached',
  body: '## Belief\nRedis is faster than Memcached for our use case.\n\n## Evidence\nBenchmarks show 2x throughput.',
  confidence: 0.6,
  scope: { tags: ['infrastructure', 'caching'] },
});
```

### Update an atom

```typescript
updateAtom({
  memoryDir: './memory',
  filePath: atom.filePath!,
  agent_id: 'my-agent',
  session_id: 'session-2',
  updates: { confidence: 1.0 },  // confirmed by production data
});
```

### Recall context

```typescript
const context = recall('./memory', {
  types: ['decision', 'constraint'],
  paths: ['/services/api'],
  max_tokens: 4000,  // fit into context window
});
```

### Reflect (consolidate)

```typescript
const result = reflect({
  memoryDir: './memory',
  agent_id: 'my-agent',
  session_id: 'session-2',
});
console.log(`Promoted: ${result.promoted}, Archived: ${result.archived}`);
```

### Generate a checkpoint

```typescript
const ckpt = checkpoint({
  memoryDir: './memory',
  agent_id: 'my-agent',
  session_id: 'session-2',
  task: 'Implement authentication',
  max_tokens: 4000,
});
console.log(ckpt.markdown); // Full handoff document
```

### Rebuild SQLite index

```typescript
reindex('./memory');
```

### Compact event log

```typescript
const compact = compactLog('./memory');
console.log(`Removed ${compact.removed} intermediate events`);
```

---

## Event Sourcing (v0.4.0+)

### Replay from events

```typescript
const events = readEvents('./memory');
const replayed = replay(events, { timestamp: '2026-03-10T00:00:00Z' });
console.log(`Atoms: ${replayed.atoms.size}, Errors: ${replayed.errors.length}`);
// replayed.views.index, .decisions, .constraints, .open_questions, .handoff
```

### Replay from file to disk

```typescript
const fromFile = replayFromFile('./memory/events.ndjson', {
  outputDir: './replay-output',  // writes atoms + views to disk
});
```

### Bootstrap (migrate to event-sourced)

```typescript
const boot = bootstrapEvents({
  memoryDir: './memory',
  agent_id: 'my-agent',
  session_id: 'bootstrap',
});
console.log(`Imported ${boot.imported} atoms, backup: ${boot.backup_path}`);
```

### Evidence store

```typescript
const hash = writeEvidence('./memory', Buffer.from('artifact data'));
const data = readEvidence('./memory', hash);
```

---

## Task-Aware Recall (v0.6.0+)

```typescript
// Rebuild FTS5 index (required after bulk creates or first use)
reindex('./memory');

// Recall with task — FTS BM25 re-ranks atoms; best matches surface first
const taskContext = recall('./memory', {
  task: 'cursor-based pagination API v2',
  max_tokens: 4000,
});
// taskContext.atoms[0] will be the most relevant atom for that task

// Search FTS directly (returns null if index absent, [] if no matches)
if (indexExists('./memory')) {
  const hits = searchFts('./memory', 'pagination', 10);
  // hits: [{ atom_id: 'DECI-...', rank: -0.87 }, ...]  (lower rank = better)
}
```

### Auto-extracted draft visibility (v1.30.0+)

Session-end `mk extract` lands `status: draft` atoms tagged `auto-extracted`. These are unvetted, so recall (and fill-mode render) **excludes them by default** — gated on the `auto-extracted` tag, not bare `status: draft`, so hand-authored draft beliefs still surface. Opt in with `RecallQuery.include_drafts`:

```typescript
const withDrafts = recall('./memory', { task: 'pagination', include_drafts: true });
```

The same flag exists on the CLI (`mk recall --include-drafts`) and the `mk_recall` MCP tool (`include_drafts`). An explicit `statuses: ['draft']` filter also surfaces them.

---

## Semantic Search — Hybrid FTS + Embeddings (v1.3.0+)

Opt-in vector-based search. When configured, `recallWithEmbeddings()` combines FTS keyword matching with cosine similarity for more intent-aware recall. Without configuration, everything falls back to FTS-only — zero behavior change.

### Setup

Set environment variables:

```bash
# Voyage AI (free tier, 512-dim vectors)
EMBEDDING_PROVIDER=voyage
EMBEDDING_API_KEY=pa-...

# OR OpenAI (paid, 1536-dim vectors)
EMBEDDING_PROVIDER=openai
EMBEDDING_API_KEY=sk-...

# Optional tuning
SEMANTIC_WEIGHT=0.6       # 0-1, semantic vs FTS balance (default: 0.6)
MIN_SIMILARITY=0.3        # 0-1, filter noise below this threshold (default: 0.3)
EMBEDDING_DIMENSIONS=256  # OpenAI only — reduce dimensions for smaller vectors
```

### Embed existing atoms

```bash
# CLI: embed all atoms in one pass
mk reindex -d ./memory --embed
```

```typescript
// SDK: embed all atoms programmatically
const result = await embedAllAtoms('./memory', {
  onProgress: (done, total) => console.log(`${done}/${total}`),
});
// result: { embedded: 45, skipped: 3, errors: 0, timeMs: 2100 }
```

### Recall with semantic re-ranking

```typescript
// Async — auto-embeds the task query, combines FTS + cosine similarity
const context = await recallWithEmbeddings('./memory', {
  task: 'how should we handle pagination at scale?',
  max_tokens: 4000,
});
// Atoms are ranked by: FTS_WEIGHT * bm25_score + SEMANTIC_WEIGHT * cosine_similarity
```

### Embed individual atoms

```typescript
// After createAtom, embed the new atom (no-op if embeddings not configured)
const atom = createAtom({ memoryDir: './memory', type: 'fact', slug: 'test', body: '...' });
const embedded = await embedAtom('./memory', atom);
// embedded: true if vector was stored, false if skipped/failed
```

### Direct semantic search

```typescript
// Async: embed a query and find similar atoms
const results = await semanticSearch('./memory', 'database performance optimization', 10);
// results: [{ atom_id: 'DECI-...', similarity: 0.87 }, ...]

// Sync: search with a pre-computed vector (no API call)
const syncResults = semanticSearchSync('./memory', queryVector, 10);
```

### Low-level utilities

```typescript
// Check if embeddings are configured
const config = getEmbeddingConfig(); // null if provider=none or no API key

// Embed text directly
const { vector, model, tokens_used } = await embedText('some text', config);

// Cosine similarity between two vectors
const sim = cosineSimilarity(vectorA, vectorB); // -1 to 1

// L2-normalize a vector to unit length (v1.20.0+)
const unit = normalizeVector([3, 4]); // → [0.6, 0.8]

// Dot product (v1.20.0+) — equivalent to cosineSimilarity for unit-norm
// inputs, but skips the per-call sqrt. Internal KNN uses this on pre-
// normalized stored vectors after PR-11; cosineSimilarity stays exported
// for direct use on un-normalized vectors.
const sim2 = dotProduct(unit, normalizeVector([1, 1])); // ≈ 0.99

// Serialize/deserialize vectors for storage
const buf = serializeVector(vector);     // Float32Array → Buffer
const vec = deserializeVector(buf);      // Buffer → number[]

// Check embedding staleness
const stale = isEmbeddingStale('./memory', atomId, contentHash); // true if needs re-embed

// Embedding stats
const stats = embeddingStats('./memory');
// stats: { count: 48, model: 'voyage-3-lite', dimensions: 512 }
```

---

## Scoring & Retrieval Improvements (v1.4.0+)

### Temporal decay, type weights, and graph-walk boost

```typescript
// Temporal decay — blend relevance with freshness
const context = recall('./memory', {
  task: 'database migration',
  decay_half_life: 14,   // atoms 14 days old score 50% of fresh atoms
  decay_weight: 0.3,     // 30% recency, 70% relevance
});

// Type-aware weighting — critical types surface even with lower relevance
const context2 = recall('./memory', {
  task: 'deploy checklist',
  type_weights: { constraint: 2.0, decision: 1.5 }, // override defaults
  type_reservations: { constraint: 600 },           // guarantee 600 tokens of constraints
});

// Disable graph-walk boost for a single call (overrides RECALL_GRAPH_BOOST env var)
const context3 = recall('./memory', { task: 'auth', graph_boost: false });
```

### IDF hub damping, coverage boost, and MMR diversity (v1.15.0+)

Large "hub" atoms (entity summaries, session logs, meta-atoms) contain ubiquitous terms and can crowd out smaller, genuinely relevant atoms. Three scoring adjustments address this:

**IDF hub damping** penalises atoms whose FTS match came primarily from common terms.

**Coverage boost** penalises atoms that match only a subset of query terms (OR semantics cast a wide net; this narrows it back).

**MMR (Maximal Marginal Relevance)** re-ranks the final result set to remove near-duplicate atoms.

All three are on by default. Adjust per-call or globally via env vars:

```typescript
const context = recall('./memory', {
  task: 'postgresql migration plan',

  // IDF hub damping — 0 = off, 1 = full damping (default: 1.0)
  idf_damping: 1.0,

  // Coverage boost exponent — 0 = off, higher = stricter (default: 0.5)
  // score *= coverage^exponent, where coverage = matched_terms / total_terms
  coverage_boost: 0.5,

  // MMR lambda — 0 = maximum diversity, 1 = pure relevance (default: 0.7)
  mmr_lambda: 0.7,
});
```

Environment variable overrides:

```bash
RECALL_IDF_DAMPING=0.5    # halve the IDF penalty
RECALL_COVERAGE_BOOST=1.0 # strict: atoms must match most terms
RECALL_MMR_LAMBDA=0.5     # more diversity in results
RECALL_DECAY_WEIGHT=0.2   # validated production value (benchmarked)
RECALL_CONFIDENCE_FLOOR=0.7  # minimum confidence to include (default: 0.7)
RECALL_NEIGHBOR_BOOST=0.15   # graph-walk neighbor boost factor (default: 0.15)
RECALL_GRAPH_BOOST=true      # enable/disable graph-walk boost (default: true)
```

> **Validated defaults**: A 2×2 factorial benchmark (±scoring stack × ±temporal decay) found `decay_weight=0.2` is load-bearing when OR semantics are active — without it, multi-session and temporal recall degrades severely. The defaults ship with `decay_weight=0.2`.

### Relation edges

```typescript
import { createAtom, addRelation, getRelationsForAtom, getAllRelations, RELATION_TYPES } from 'memory-kernel';

// Create atoms with inline relations
const a = createAtom({ memoryDir: './memory', type: 'decision', slug: 'use-postgres',
  body: 'Use PostgreSQL as primary datastore.',
  relations: [{ target: 'CONS-2026-04-01-NO-NOSQL-abc1', type: 'contradicts' }],
});

// Add a relation imperatively (writes to frontmatter + index)
addRelation('./memory', a.frontmatter.id, 'FACT-2026-04-01-POSTGRES-DEF-xyz9', 'supports');

// Query relations for a specific atom
const { outbound, inbound } = getRelationsForAtom('./memory', a.frontmatter.id);
// outbound: [{ source_id, target_id, relation_type, created_at }]
// inbound:  [{ source_id, target_id, relation_type, created_at }]

// Get all edges (for custom graph analysis)
const allEdges = getAllRelations('./memory');

// Valid relation types
console.log(RELATION_TYPES); // ['extends','contradicts','supports','caused_by','supersedes','related']
```

### Backfill existing relations

```bash
# Preview migrations without writing
mk migrate-relations -d ./memory --dry-run

# Apply: migrate links.related → relations[] + mine body text for atom ID references
mk migrate-relations -d ./memory --apply

# Add a relation edge manually
mk relate DECI-2026-04-01-USE-POSTGRES-abc1 supports FACT-2026-04-01-PERF-BENCH-xyz9 -d ./memory

# Show all edges for an atom
mk relations DECI-2026-04-01-USE-POSTGRES-abc1 -d ./memory
```

---

## Semantic Health Check — mk lint (v1.15.0+)

`mk lint` checks the semantic health of a memory store: contradictions between active atoms, stale facts and decisions with no recent events, orphaned atoms with no relations, near-duplicate content, low-confidence beliefs that haven't been reviewed, and atoms approaching TTL expiry.

### CLI

```bash
# Pretty-printed report
mk lint -d ./memory

# Machine-readable JSON
mk lint -d ./memory --json

# Adjust stale threshold (default 90 days)
mk lint -d ./memory --stale-days 60

# Exit code: 0 = clean, 1 = warnings found
```

### Programmatic API

```typescript
import { lintMemoryStore } from 'memory-kernel';
import type { LintResult, LintFinding } from 'memory-kernel';

const result: LintResult = lintMemoryStore('./memory', {
  staleDays: 60,  // default: 90
});

// result.findings — array of LintFinding
// result.summary  — { total, warnings, info }

for (const finding of result.findings) {
  console.log(finding.category);  // 'contradiction' | 'stale' | 'orphan' | 'duplicate' | 'confidence_drift' | 'ttl_warning'
  console.log(finding.severity);  // 'warning' | 'info'
  console.log(finding.atom_ids);  // affected atom IDs
  console.log(finding.message);   // human-readable description
}
```

**Finding categories:**

| Category | Severity | Triggered when |
|---|---|---|
| `contradiction` | warning | Two active atoms have a `contradicts` relation |
| `stale` | warning | A `fact` or `decision` has had no events in N days |
| `orphan` | info | An active atom has zero relations (excludes `entity_summary`, `procedure`) |
| `duplicate` | warning | Two active atoms have high FTS similarity AND >50% tag overlap |
| `confidence_drift` | info | A `belief` with confidence < 0.5 hasn't been updated in 30+ days |
| `ttl_warning` | warning | An active/draft atom expires within 7 days |

Run weekly as part of the memory maintenance cycle. Add to cron alongside `mk reflect` and `mk render`.

---

## Episode Store (v0.6.0+)

```typescript
// Write a session summary
const epId = writeEpisode(
  './memory',
  'session-2026-03-11',
  '## Session Summary\n\nFixed cursor pagination bug. Updated 3 atoms.',
  { agent_id: 'my-agent', tags: ['api', 'bugfix'] },
);
// epId: 'EP-session-2026-03-11'

// Link the episode to atoms it affected
linkEpisodeToAtom('./memory', atom.filePath!, epId);

// Read a specific episode
const ep = readEpisode('./memory', epId);
console.log(ep?.summary);

// List recent episodes (newest first)
const recent = listEpisodes('./memory', { limit: 5, tags: ['bugfix'] });

// Recall with episodes included
const contextWithHistory = recall('./memory', {
  task: 'pagination',
  include_episodes: true,  // adds recent session summaries to bundle
});
// contextWithHistory.episodes: ['## Episode: EP-session-...', ...]
```

---

## Multi-Agent Merge (v0.7.0+)

```typescript
// Merge a remote agent's event log into the local memory directory.
// Events are deduplicated by event_id, sorted by (timestamp, event_id),
// replayed, and atoms+views are written. Conflict atoms are created for
// any atom mutated by both agents concurrently.
const mergeResult = await mergeEventLogs({
  localDir: './memory',
  remoteDir: './remote-memory',
  agent_id: 'my-agent',
  session_id: 'session-merge-1',
  dryRun: false,       // true to preview without writing
});
// mergeResult.atoms_written   — number of atom files written
// mergeResult.conflicts_created — number of conflict atoms created
// mergeResult.events_merged   — total events after deduplication
```

---

## Conflict Resolution (v0.8.0+)

```typescript
import { resolveConflict, atomFilePath } from 'memory-kernel';

// Resolve a conflict atom: sets status to 'resolved', archives it,
// emits a conflict_resolved event. Idempotent.
const { atom: resolved, event_id } = resolveConflict({
  memoryDir: './memory',
  agent_id: 'my-agent',
  session_id: 'session-resolve-1',
  filePath: atomFilePath('./memory', 'CONF-2026-03-12-TIMEOUT-a1b2', 'conflict'),
  resolutionNote: 'Chose 30-second timeout as confirmed by ops team.',
});
// resolved.frontmatter.status === 'resolved'
// File moved to ARCHIVE/
```

---

## Render to CLAUDE.md (v1.1.0+)

```typescript
import fs from 'fs';

// Generate a CLAUDE.md-compatible markdown string from active atoms.
// Caller is responsible for writing the result to disk.
const md = renderClaudeMd('./memory', { maxTokens: 8000 });
fs.writeFileSync('./CLAUDE.md', md);
// md includes conflicts, facts, decisions, constraints, preferences, beliefs.
```

Or use the CLI: `mk render ./memory ./CLAUDE.md`

---

## Encryption (v0.9.0+)

```typescript
// Set MEMORY_ENCRYPTION_KEY env var before creating SECRET atoms.
// 64-char hex (32 bytes) or any passphrase (PBKDF2-derived).
// process.env.MEMORY_ENCRYPTION_KEY = 'my-passphrase';

// SECRET atoms are automatically encrypted at rest — no API change needed.
createAtom({
  memoryDir: './memory',
  agent_id: 'my-agent',
  session_id: 'session-1',
  type: 'fact',
  slug: 'api-key-rotation',
  body: 'API key rotation schedule: first Monday of every month.',
  classification: 'SECRET',   // stored as MKENC:v1:... on disk
});

// recall() and readAtom() decrypt transparently when key is set.
// listAtoms() skips SECRET atoms with a stderr warning when key is absent.
```

---

## Read Audit Logging (v0.9.0+)

```typescript
// Pass agent_id + session_id to recall() to emit an 'atom_read' event.
const auditedContext = recall('./memory', {
  task: 'cursor pagination API',
  agent_id: 'my-agent',   // if both provided,
  session_id: 'session-3', // an atom_read event is appended to events.ndjson
});
// Omit agent_id/session_id to skip audit (fully backward-compatible).
```

---

## Import (v0.9.0+)

```typescript
// Preview chunks that would be extracted from a markdown file
const chunks = previewImport('./NOTES.md');
// chunks: [{ heading: 'Architecture Decision', body: '...' }, ...]

// Import the file as atoms — one per heading section (bullet fallback if no headings)
const imported = importFromFile({
  filePath: './NOTES.md',
  memoryDir: './memory',
  agent_id: 'my-agent',
  session_id: 'session-import-1',
  // defaultType: 'fact',         // override type inference
  // defaultClassification: 'TEAM', // default
});
console.log(`Created: ${imported.atoms_created}, Skipped: ${imported.atoms_skipped}`);
```

---

## Wander — Spreading Activation (v1.2.0+)

Find unexpected connections between atoms by walking the tag co-occurrence graph and explicit relation edges. Pure computation — no LLM calls, runs in milliseconds.

```typescript
import { wander, wanderFromFiles, closeIndex } from 'memory-kernel';

// Index-backed (fast, requires mk reindex)
const result = wander({
  memoryDir: './memory',
  seedTags: ['philosophy', 'accounting'],  // or seeds: ['BELI-2026-...']
  steps: 5,          // spreading depth (default: 3)
  topK: 20,          // lateral inhibition limit (default: 20)
  threshold: 0.05,   // minimum activation to survive (default: 0.05)
  decay: 0.5,        // spread decay factor (default: 0.5)
  maxCollisions: 5,  // max collision candidates (default: 5)
  relationWeight: 0.5, // activation weight for explicit relation edges (default: 0.5)
});

// result.collisions — atom pairs with high tag dissimilarity (Jaccard > 0.7)
for (const c of result.collisions) {
  console.log(`${c.atom_a} <-> ${c.atom_b} (score: ${c.score}, dissimilarity: ${c.dissimilarity}, shared: ${c.shared_tags})`);
}

// result.activated — all activated atoms sorted by activation score
// result.steps_taken, result.duration_ms, result.seeds_used

// File-scan fallback (no index needed, slower)
const fileResult = wanderFromFiles({
  memoryDir: './memory',
  seedTags: ['philosophy'],
});

// In long-running processes, close the SQLite connection when done:
closeIndex('./memory');
```

Or use the CLI: `mk wander -d ./memory --tags philosophy accounting --steps 5 --json`

**Auto-seed selection.** When neither `seeds` nor `seedTags` is given, wander
auto-selects its starting atoms **citation-primary** (#280): atoms are ranked by
raw citation count first, with recency (base-level activation) only breaking ties
among equally-cited atoms. A heavily-cited foundational atom therefore always
outranks a freshly-written uncited one — seeds are the graph's well-connected
anchors, not "whatever was touched last." Run `mk citations` first so citation
counts exist; with no citation data the ranking degrades gracefully to pure
recency.

Auto-seeds are also drawn **round-robin across atom types** by default
(`diverseSeeds: true`, #281): the best-ranked belief, then the best fact, then
the best decision, and so on. In a type-monoculture store (e.g. ~90% beliefs)
the plain top-N would be three beliefs from one tight cluster and the walk would
never escape it; type-diverse seeds let activation bridge to other clusters. Set
`diverseSeeds: false` (CLI `--no-diverse-seeds`) for the plain top-N behavior.

---

## Per-Agent Isolation

For the full guide, see **[docs/isolation.md](isolation.md)**.

### Configuration

```typescript
import {
  loadConfig,
  writeConfig,
  isIsolated,
  assertValidAgentId,
  resolveAgentDir,
  getSharedDir,
  listAgents,
  DEFAULT_ISOLATION_CONFIG,
  DEFAULT_RENDER_CONFIG,
} from 'memory-kernel';
import type { IsolationConfig, RenderConfig, RenderMode } from 'memory-kernel';

// Load config (config.yaml > MK_ISOLATION env > default shared)
const config: IsolationConfig = loadConfig('./memory');
// config.isolation: 'shared' | 'per-agent'

// Write config
writeConfig('./memory', { isolation: 'per-agent' });

// Check mode
isIsolated('./memory'); // boolean

// Validate agent ID (throws on invalid — blocks path traversal)
assertValidAgentId('my-agent');    // ok
assertValidAgentId('../../hack');  // throws

// Resolve directory for an agent
// Isolated mode:  './memory/agents/alice'
// Shared mode:    './memory' (identity — backward compatible)
const agentDir = resolveAgentDir('./memory', 'alice');

// Shared namespace path
getSharedDir('./memory'); // './memory/shared'

// List all agent IDs with stores
listAgents('./memory');   // ['alice', 'bob']
```

### Initialization

```typescript
import { initAgentStore, initSharedStore, initIsolatedBase } from 'memory-kernel';

// Full bootstrap: config.yaml + shared namespace + optional first agent
initIsolatedBase('./memory', 'alice');

// Initialize a single agent store (creates dirs + default render.yaml)
const agentDir = initAgentStore('./memory', 'alice');

// Initialize shared namespace only
const sharedDir = initSharedStore('./memory');
```

### Union Recall

```typescript
import { recallIsolated } from 'memory-kernel';
import type { ContextBundle, RecallQuery } from 'memory-kernel';

// Merges agent store + shared namespace atoms
// Agent atoms win on ID collision; token budget applied once on merged set
const bundle: ContextBundle = recallIsolated(
  './memory/agents/alice',  // Resolved agent directory
  './memory',               // Base directory (to locate shared/)
  { task: 'API design', max_tokens: 4000 },
);
// bundle.atoms — merged atoms (alice's + shared, alice wins on collision)
// bundle.episodes — merged episodes with dedup
// bundle.token_estimate — estimated tokens of merged result
```

### Share / Unshare

```typescript
import { shareAtom, unshareAtom, listSharedAtoms } from 'memory-kernel';
import type { ShareResult, ShareOptions } from 'memory-kernel';

// Copy an atom snapshot from agent store to shared namespace
const result: ShareResult = shareAtom(
  './memory',         // Base directory
  'FACT-2026-xxx',    // Atom ID
  'alice',            // Agent that owns the atom
  { agent_id: 'alice', session_id: 'session-1' },
);
// result: { atom_id, shared_path, source_agent }

// Remove from shared namespace
unshareAtom('./memory', 'FACT-2026-xxx', {
  agent_id: 'alice',
  session_id: 'session-1',
});

// List all atoms in shared namespace
const shared = listSharedAtoms('./memory');
```

### Per-Agent Render Config

```typescript
import { loadRenderConfig, writeRenderConfig } from 'memory-kernel';
import type { RenderConfig } from 'memory-kernel';

// Load (falls back to defaults for missing fields)
const config: RenderConfig = loadRenderConfig('./memory/agents/alice');
// { mode: 'balanced', max_tokens: 8000, include_shared: true, type_weights: {} }

// Write custom config
writeRenderConfig('./memory/agents/alice', {
  mode: 'operational',     // 'operational' | 'constitutive' | 'balanced'
  max_tokens: 12000,
  include_shared: true,
  type_weights: { belief: 1.5, fact: 1.0 },
});
```

### Render Agent CLAUDE.md

```typescript
import { renderAgentClaudeMd } from 'memory-kernel';

// Renders CLAUDE.md for a specific agent using their render.yaml config
// Uses recallIsolated() internally when include_shared is true
const markdown = renderAgentClaudeMd('./memory', 'alice');
```

### Extract atoms from conversation logs

```typescript
import { extractFromLog } from 'memory-kernel';
import type { ExtractOptions, ExtractResult, ExtractedAtomResult } from 'memory-kernel';

const result: ExtractResult = await extractFromLog({
  logPath: './conversation.log',
  memoryDir: './memory',
  agentId: 'my-agent',        // optional — tags extracted atoms
  sessionId: 'session-1',      // optional — tags extracted atoms
  dryRun: false,                // true = preview only, no files written
  model: undefined,             // omit for claude -p (default), or 'qwen2.5:14b' for Ollama
  maxAtoms: 20,                 // max atoms to extract (default: 20)
  skipLines: 0,                 // skip preamble lines (e.g. CLAUDE.md prefix)
});
// result.extracted — count of new atoms written
// result.skipped — count of invalid/collision atoms
// result.possible_duplicates — count flagged as possible duplicates
// result.atoms — per-atom details: { atom_id, slug, type, status, reason?, possible_duplicate_of? }
```

**LLM providers:**
- Default: `claude -p` subprocess (Claude Code CLI). Requires `claude` or `CLAUDE_PATH` on PATH.
- Ollama: pass `model: 'qwen2.5:14b'` (any name containing `:` or known Ollama model). Connects to `http://localhost:11434`.

Extracted atoms are created with `status: 'draft'` and `source: 'auto-extracted'` in metadata. Use `consolidateAtoms()` to review and promote them.

### Consolidate auto-extracted drafts

```typescript
import { consolidateAtoms } from 'memory-kernel';
import type { ConsolidateOptions, ConsolidateResult, ConsolidateAtomResult } from 'memory-kernel';

const result: ConsolidateResult = await consolidateAtoms({
  memoryDir: './memory',
  agentId: 'my-agent',          // optional — for event attribution
  sessionId: 'consolidation-1', // optional — for event attribution
  dryRun: true,                 // true = preview, no writes
  all: false,                   // true = process ALL drafts, not just auto-extracted
  type: 'belief',               // optional — filter by atom type
  limit: 50,                    // max atoms to process (default: 50)
  duplicateThreshold: -2.0,     // BM25 rank threshold for duplicate detection
});
// result.processed — total atoms reviewed
// result.promoted — count promoted from draft to active
// result.skipped — count skipped (duplicates, errors)
// result.errors — count of processing errors
// result.dry_run — whether this was a dry run
// result.atoms — per-atom details: { atom_id, slug, type, status, title, reason?, possible_duplicate_of? }
```

**Statuses:** `promoted` (draft → active), `skipped` (possible duplicate or error), `would_promote`/`would_skip` (dry-run equivalents).

### Migration

```typescript
import { migrate } from 'memory-kernel';
import type { MigrateStrategy, MigrateOptions, MigrateResult } from 'memory-kernel';

const result: MigrateResult = migrate({
  baseDir: './memory',
  strategy: 'partition',        // 'fresh' | 'partition' | 'clone-to-shared'
  assignUntagged: 'main',      // Fallback agent for partition (default: 'main')
  agent_id: 'cli',
  session_id: 'migration-1',
});
// result.strategy — strategy used
// result.agents_created — agent IDs whose stores were created
// result.atoms_moved — atoms moved to agent stores (partition)
// result.atoms_shared — atoms copied to shared namespace (clone-to-shared)
// result.config_written — true
// result.backup_path — path to timestamped backup (empty for fresh strategy)
```
