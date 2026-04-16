# Per-Agent Memory Isolation

> **Audience:** Anyone running multiple agents with memory-kernel, or planning to.

Memory Kernel supports two isolation modes:

| Mode | Directory layout | When to use |
|------|-----------------|-------------|
| **Shared** (default) | All atoms in one directory | Single agent, or agents that intentionally share everything |
| **Per-agent** | `agents/{id}/` per agent + `shared/` namespace | Multiple agents that need private memory with controlled sharing |

Shared mode is fully backward compatible — existing installs work unchanged.

---

## Quick Start

```bash
# 1. Initialize in per-agent mode with an initial agent
mk init ./memory -a alice

# 2. Alice remembers something
mk remember "Redis is the caching layer" -d ./memory -a alice -t fact

# 3. Create a second agent store
mk init ./memory -a bob    # Bob's store is added to the existing isolated base

# 4. Bob remembers something different
mk remember "We use PostgreSQL for persistence" -d ./memory -a bob -t fact

# 5. Alice shares a fact with everyone
mk share FACT-2026-04-16-REDIS-IS-THE-CACHING-LAYER --from alice -d ./memory

# 6. Bob recalls — sees his own atoms AND shared ones
mk recall -d ./memory -a bob --json
```

After these steps, Bob's recall returns his PostgreSQL fact plus Alice's shared Redis fact. Alice's private atoms remain invisible to Bob.

---

## Concepts

### Two Modes

The isolation mode is stored in `config.yaml` at the root of the memory directory:

```yaml
isolation: per-agent
```

You can also set it via the `MK_ISOLATION` environment variable. Precedence: config.yaml > env var > default (shared).

### Agent IDs

Agent IDs must match `^[a-zA-Z0-9_-]+$` — alphanumeric characters, dashes, and underscores only. This restriction is a security measure: it prevents path traversal attacks (e.g., `../../etc/passwd` as an agent ID). Every directory operation additionally checks that the resolved path stays within the memory directory.

### Directory Structure

```
my-memory/
├── config.yaml                # isolation: per-agent
├── agents/
│   ├── alice/                 # Alice's private memory
│   │   ├── ENTITIES/          # Her atoms
│   │   ├── EPISODES/          # Her session summaries
│   │   ├── CONFLICTS/         # Her conflict atoms
│   │   ├── ARCHIVE/           # Her archived atoms
│   │   ├── EVIDENCE/          # Her evidence blobs
│   │   ├── events.ndjson      # Her event log
│   │   ├── render.yaml        # Her render preferences
│   │   ├── .memory-index.db   # Her SQLite index
│   │   ├── INDEX.md
│   │   ├── HANDOFF.md
│   │   ├── DECISIONS.md
│   │   ├── CONSTRAINTS.md
│   │   └── OPEN_QUESTIONS.md
│   └── bob/                   # Bob's private memory (same layout)
│       └── ...
└── shared/                    # Explicitly shared atoms
    ├── ENTITIES/
    ├── CONFLICTS/
    ├── ARCHIVE/
    ├── events.ndjson
    └── .memory-index.db
```

Each agent store is a full memory directory with its own atoms, index, events, and views. The shared namespace has a simpler layout — primarily ENTITIES and an index.

---

## Sharing Atoms

Sharing is **copy-based** — when you share an atom, a snapshot is written to `shared/ENTITIES/`. The shared copy is independent of the original. If the original changes, the shared copy does not update. To update it, share the atom again (re-sharing overwrites the previous copy).

### CLI

```bash
# Share an atom from alice to the shared namespace
mk share FACT-2026-04-16-REDIS --from alice -d ./memory

# Remove an atom from the shared namespace
mk unshare FACT-2026-04-16-REDIS -d ./memory
```

### SDK

```typescript
import { shareAtom, unshareAtom, listSharedAtoms } from 'memory-kernel';

// Share
const result = shareAtom('./memory', 'FACT-2026-04-16-REDIS', 'alice', {
  agent_id: 'alice',
  session_id: 'session-1',
});
// result: { atom_id, shared_path, source_agent }

// Unshare
unshareAtom('./memory', 'FACT-2026-04-16-REDIS', {
  agent_id: 'alice',
  session_id: 'session-1',
});

// List all shared atoms
const shared = listSharedAtoms('./memory');
```

### Events

Share operations emit events in the agent's event log:
- `atom_shared` — with `meta.shared_to: 'shared'` and `meta.source_agent`
- `atom_unshared` — with `meta.unshared_from: 'shared'`

---

## Union Recall

In isolated mode, `recallIsolated()` merges atoms from the agent's store and the shared namespace:

1. Queries the agent store (unbounded — no token limit yet)
2. Queries the shared namespace (unbounded)
3. Merges: agent atoms first, then shared atoms. If the same atom ID exists in both, the agent's version wins.
4. Applies the token budget once on the merged set

This ensures shared atoms aren't starved when the agent's own atoms would fill the budget alone.

Episodes are also merged with dedup — agent episodes first, then shared episodes that aren't already present.

### SDK

```typescript
import { recallIsolated } from 'memory-kernel';

const bundle = recallIsolated(
  './memory/agents/bob',  // Agent's resolved directory
  './memory',             // Base directory (to find shared/)
  { task: 'caching strategy', max_tokens: 4000 },
);
// bundle.atoms includes Bob's atoms + shared atoms (Bob wins on collision)
```

The CLI handles this automatically — `mk recall -d ./memory -a bob` uses union recall when in isolated mode.

---

## Per-Agent Render Config

Each agent can have a `render.yaml` in their store directory that controls how `renderAgentClaudeMd()` generates their CLAUDE.md context:

```yaml
mode: balanced           # operational | constitutive | balanced
max_tokens: 8000         # Token budget for rendering
include_shared: true     # Include shared atoms in rendered output
type_weights:            # Per-atom-type weight overrides for recall scoring
  belief: 1.5
  fact: 1.0
  decision: 1.2
```

| Field | Default | Description |
|-------|---------|-------------|
| `mode` | `balanced` | `operational` favors facts/procedures, `constitutive` favors beliefs/preferences, `balanced` is neutral |
| `max_tokens` | `8000` | Token budget for the rendered output |
| `include_shared` | `true` | Whether to include shared namespace atoms |
| `type_weights` | `{}` | Per-type multipliers for recall scoring (valid types: decision, constraint, open_question, belief, fact, procedure, entity_summary, preference, conflict) |

### SDK

```typescript
import { loadRenderConfig, writeRenderConfig, renderAgentClaudeMd } from 'memory-kernel';

// Read/write config
const config = loadRenderConfig('./memory/agents/alice');
writeRenderConfig('./memory/agents/alice', { ...config, mode: 'operational' });

// Render CLAUDE.md for an agent
const md = renderAgentClaudeMd('./memory', 'alice');
```

---

## Wander Scoping

In isolated mode, `mk wander` is scoped to the agent's own store plus the shared namespace. An agent cannot walk into another agent's private store through the graph. Shared atoms participate in graph walks and are accessible from all agents.

```bash
# Alice's wander only sees her atoms + shared atoms
mk wander -d ./memory -a alice --tags caching --json

# Bob's wander is independent — same shared atoms, different private ones
mk wander -d ./memory -a bob --tags caching --json
```

---

## Migration

If you've been running in shared mode and want to switch to per-agent isolation, use `mk migrate`. Three strategies are available:

### Strategy: `fresh`

Just writes `config.yaml` and creates the shared directory. Existing atoms stay where they are (at the root). You create agent stores manually afterward.

```bash
mk migrate -d ./memory --strategy fresh
```

**When to use:** You want to start fresh with isolation. Existing atoms don't need to be moved — new agents will create their own stores.

### Strategy: `partition`

Routes existing atoms into agent subdirectories based on the `agent_id` recorded in the event log (the first event per atom determines the creating agent). Atoms with unknown agent IDs go to a fallback agent (default: `main`).

```bash
mk migrate -d ./memory --strategy partition
mk migrate -d ./memory --strategy partition --assign-untagged default-agent
```

**When to use:** You have existing atoms created by identifiable agents and want to split them into per-agent stores.

### Strategy: `clone-to-shared`

Copies all existing atoms into the shared namespace. Every agent will see them via union recall.

```bash
mk migrate -d ./memory --strategy clone-to-shared
```

**When to use:** You want all existing knowledge to be shared. New agent-specific atoms will be private by default.

### Safety

- A timestamped backup (`.mk-backup-YYYY-MM-DDTHH-MM-SS`) is created before any destructive operation (partition and clone-to-shared move files).
- Config is written first, so a crash leaves the store in "already isolated" state — the migrate command will refuse to run again (idempotent guard).
- The store must not already be in isolated mode. If it is, `migrate()` throws.

---

## CLI Reference

All existing commands accept the global `-a, --agent <id>` option. In isolated mode, this routes operations to the agent's store.

| Command | Description |
|---------|-------------|
| `mk init <dir> -a <agent>` | Initialize in isolated mode with an agent store |
| `mk status -d <dir> --all-agents` | Show per-agent summary (atom counts, event counts) |
| `mk share <atom-id> --from <agent> -d <dir>` | Copy atom snapshot to shared namespace |
| `mk unshare <atom-id> -d <dir>` | Remove atom from shared namespace |
| `mk migrate -d <dir> --strategy <s>` | Convert shared store to isolated mode |
| `mk recall -d <dir> -a <agent>` | Recall with union (agent + shared) |
| `mk remember "..." -d <dir> -a <agent>` | Create atom in agent's store |
| `mk reflect -d <dir> -a <agent>` | Consolidate agent's store |
| `mk wander -d <dir> -a <agent>` | Wander scoped to agent + shared |

The `-a` flag is optional in shared mode (ignored) and routes to `agents/{id}/` in isolated mode.

---

## SDK Reference

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

// Load config (config.yaml > MK_ISOLATION env > default)
const config = loadConfig('./memory');          // { isolation: 'shared' | 'per-agent' }

// Write config
writeConfig('./memory', { isolation: 'per-agent' });

// Check mode
isIsolated('./memory');                         // boolean

// Validate agent ID (throws on invalid)
assertValidAgentId('my-agent');                 // ok
assertValidAgentId('../hack');                  // throws Error

// Resolve directory for an agent
resolveAgentDir('./memory', 'alice');            // './memory/agents/alice' (isolated)
resolveAgentDir('./memory', 'alice');            // './memory' (shared mode — identity)

// Shared namespace path
getSharedDir('./memory');                        // './memory/shared'

// List all agent IDs
listAgents('./memory');                          // ['alice', 'bob']
```

### Initialization

```typescript
import { initAgentStore, initSharedStore, initIsolatedBase } from 'memory-kernel';

// Initialize a single agent store (creates dirs + default render.yaml)
initAgentStore('./memory', 'alice');             // returns agent dir path

// Initialize shared namespace
initSharedStore('./memory');                     // returns shared dir path

// Full bootstrap: config.yaml + shared + optional first agent
initIsolatedBase('./memory', 'alice');
```

### Recall, Share, Migrate

```typescript
import { recallIsolated, shareAtom, unshareAtom, listSharedAtoms, migrate } from 'memory-kernel';

// Union recall
const bundle = recallIsolated('./memory/agents/alice', './memory', { task: 'api design' });

// Share/unshare
shareAtom('./memory', 'FACT-xxx', 'alice', { agent_id: 'alice', session_id: 's1' });
unshareAtom('./memory', 'FACT-xxx', { agent_id: 'alice', session_id: 's1' });
const shared = listSharedAtoms('./memory');

// Migration
const result = migrate({
  baseDir: './memory',
  strategy: 'partition',           // 'fresh' | 'partition' | 'clone-to-shared'
  assignUntagged: 'main',         // fallback agent for partition strategy
  agent_id: 'cli',
  session_id: 'migration',
});
// result: { strategy, agents_created, atoms_moved, atoms_shared, config_written, backup_path }
```

### Types

```typescript
import type {
  IsolationConfig,    // { isolation: 'shared' | 'per-agent' }
  RenderConfig,       // { mode, max_tokens, include_shared, type_weights }
  RenderMode,         // 'operational' | 'constitutive' | 'balanced'
} from 'memory-kernel';

import type { MigrateStrategy, MigrateOptions, MigrateResult } from 'memory-kernel';
import type { ShareResult, ShareOptions } from 'memory-kernel';
```

---

## MCP Integration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_AGENT_ID` | `mcp-server` | Agent ID for the MCP server — determines which agent store tools route to |
| `MEMORY_DIR` | (required) | Root memory directory |

### New Tools

| Tool | Description | Isolated mode only |
|------|-------------|-------------------|
| `mk_share_atom` | Share atom from an agent store to shared namespace | Yes |
| `mk_unshare_atom` | Remove atom from shared namespace | Yes |

In isolated mode, all existing tools (`mk_remember`, `mk_recall`, `mk_reflect`, etc.) automatically route to the agent store determined by `MCP_AGENT_ID`.

### Claude Desktop Config (Isolated Mode)

```json
{
  "mcpServers": {
    "memory-kernel": {
      "command": "node",
      "args": ["/path/to/memory-kernel/dist/mcp/server.js"],
      "env": {
        "MEMORY_DIR": "/path/to/your/memory",
        "MCP_AGENT_ID": "claude-desktop"
      }
    }
  }
}
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Invalid agent ID "..."` | Agent IDs must be alphanumeric, dashes, or underscores only. No spaces, dots, or slashes. |
| `shareAtom requires per-agent isolation mode` | Set `isolation: per-agent` in config.yaml or run `mk migrate` |
| `Store is already in isolated (per-agent) mode` | Migration already completed. This is the idempotency guard. |
| `Atom not found in agent "..." store` | The atom doesn't exist in the specified agent's ENTITIES/. Check the agent ID and atom ID. |
| `Shared namespace does not exist` | Run `mk init -a <agent>` to create the full isolated layout, or `initSharedStore()` programmatically. |
| `--all-agents requires per-agent isolation mode` | The `--all-agents` flag only works in isolated mode. Check your config.yaml. |
| Agent recall misses shared atoms | Verify `include_shared: true` in the agent's `render.yaml`. Check that atoms were actually shared (not just created in the agent store). |
