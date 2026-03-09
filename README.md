# Memory Kernel

A model-agnostic, file-first memory kernel for AI agents. Prevents context degradation, compaction loss, and cross-session amnesia through typed memory atoms with explicit lifecycle controls.

## Core idea

Memory is not "more context." Memory is a **typed system** with explicit invariants and lifecycle controls.

### Three stores

1. **Evidence Store** (immutable) — artifacts, diffs, tool outputs
2. **Event Log** (append-only) — structured record of what happened
3. **State Views** (materialized) — curated markdown views derived from events

### Three operations

- **Retain** — capture an event, create/update atoms
- **Recall** — progressive disclosure context loading
- **Reflect** — consolidate, dedup, TTL/GC, promote, detect conflicts

## Quick start

```bash
# Install
npm install memory-kernel

# Initialize a memory directory
npx mk init ./my-memory

# Check status
npx mk status -d ./my-memory

# Validate
npx mk doctor -d ./my-memory
```

## SDK usage

```typescript
import { initMemoryDir, createAtom, recall, reflect } from 'memory-kernel';

// Initialize
initMemoryDir('./memory');

// Remember something
const atom = createAtom({
  memoryDir: './memory',
  agent_id: 'my-agent',
  session_id: 'session-1',
  type: 'decision',
  slug: 'use-cursor-pagination',
  body: '## Decision\nUse cursor-based pagination for /v2/items.\n\n## Why\nOffset pagination degrades beyond 1M rows.',
});

// Recall context for a task
const context = recall('./memory', {
  types: ['decision', 'constraint'],
  paths: ['services/api'],
});

// Consolidate: dedup, expire, promote, regenerate views
const result = reflect({
  memoryDir: './memory',
  agent_id: 'my-agent',
  session_id: 'session-1',
});
```

## Memory atom types

| Type | Purpose | Default TTL |
|------|---------|-------------|
| `decision` | Accepted design/architecture decisions | ∞ |
| `constraint` | Rules and boundaries | ∞ (review flag) |
| `open_question` | Unresolved questions | 90 days |
| `belief` | Hypotheses (promotable to fact) | 30 days |
| `fact` | Verified truths | ∞ |
| `procedure` | How-to steps | ∞ |
| `entity_summary` | Key entity descriptions | 180 days |
| `preference` | User/agent preferences | 180 days |
| `conflict` | Contradicting information | 30 days |

## CLI commands

| Command | Description |
|---------|-------------|
| `mk init [dir]` | Initialize memory directory |
| `mk status -d <dir>` | Show memory statistics |
| `mk recall -d <dir>` | Load relevant context |
| `mk reflect -d <dir>` | Consolidate memory |
| `mk gc -d <dir>` | Archive expired atoms |
| `mk doctor -d <dir>` | Validate schema and links |

## On-disk layout

```
memory/
  INDEX.md              ← Routing map (≤200 lines)
  HANDOFF.md            ← Current working state
  DECISIONS.md          ← Decision log view
  CONSTRAINTS.md        ← Active constraints view
  OPEN_QUESTIONS.md     ← Unresolved questions view
  events.ndjson         ← Append-only event log
  ENTITIES/             ← Individual atom files
  EPISODES/             ← Session logs
  EVIDENCE/             ← Immutable artifacts
  CONFLICTS/            ← Active conflicts
  ARCHIVE/              ← Expired/archived atoms
```

## License

MIT
