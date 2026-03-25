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

// result.collisions — atom pairs from different types with shared tags
for (const c of result.collisions) {
  console.log(`${c.atom_a} <-> ${c.atom_b} (score: ${c.score}, shared: ${c.shared_tags})`);
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
