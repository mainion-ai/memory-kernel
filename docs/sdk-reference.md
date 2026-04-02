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
  serializeVector,
  deserializeVector,
  atomToEmbeddingText,
  storeEmbedding,
  getAllEmbeddings,
  isEmbeddingStale,
  embeddingStats,
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

Find unexpected connections between atoms by walking the tag co-occurrence graph. Pure computation — no LLM calls, runs in milliseconds.

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
