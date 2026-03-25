# Agent Quick Reference — Native / Claude Code Mode

> **Audience:** You are an AI agent running natively on the host (not in a container). This includes Claude Code sessions, NanoClaw native mode (`NATIVE_MODE=1`), or any agent with direct filesystem access.

## Setup

If memory-kernel isn't installed yet and a user asked you to set it up:

```bash
# Install globally
npm install -g memory-kernel

# Initialize a memory directory
mk init ~/mk-memory

# Verify
mk status -d ~/mk-memory
mk doctor -d ~/mk-memory
```

If you're setting up for NanoClaw, see the [full integration guide](nanoclaw-integration.md) or use the `/mk-memory-setup` skill.

## Paths

You have direct filesystem access. Common locations:

| What | Typical path |
|------|-------------|
| Memory data | `~/mk-memory` or `~/repos/memory/kernel` |
| NanoClaw CLAUDE.md | `~/Documents/nanoclaw/groups/{name}/CLAUDE.md` |
| Event log | `{MEMORY_DIR}/events.ndjson` |
| Atoms | `{MEMORY_DIR}/ENTITIES/*.md` |

## Quick Commands

```bash
# Remember something
mk remember "The deploy pipeline takes ~4 minutes" \
  -d ~/mk-memory -t fact --tags infrastructure,deploy

# Remember a decision
mk remember "Use PostgreSQL for the main datastore" \
  -d ~/mk-memory -t decision --tags architecture,database

# Recall context for a specific task
mk recall -d ~/mk-memory --task "optimize database queries"

# Reflect — consolidate, deduplicate, expire, promote beliefs
mk reflect -d ~/mk-memory --agent-id my-agent --session-id $(date +%Y%m%d-%H%M)

# Render to CLAUDE.md
mk render ~/mk-memory ~/path/to/nanoclaw/groups/{name}/CLAUDE.md

# Find unexpected connections
mk wander -d ~/mk-memory --tags architecture,performance --json

# Full health check
mk doctor -d ~/mk-memory

# Rebuild index if queries are slow
mk reindex -d ~/mk-memory
```

## Session Loop

The recommended pattern for a native agent session:

```
Session starts
  ├── CLAUDE.md already loaded (if NanoClaw)
  ├── OR: mk recall -d {dir} --task "what I'm working on"
  │
  ├── During session:
  │   ├── mk remember (when you learn something worth keeping)
  │   └── mk wander --tags ... (when exploring connections)
  │
  └── Session ends:
      ├── mk render (update CLAUDE.md for next session)
      └── mk reflect (optional — nightly cron usually handles this)
```

### When to remember vs. when not to

**Remember** when:
- You discover a fact the user would want you to know next time
- A design decision was made (with rationale)
- The user states a preference
- You form a hypothesis worth tracking
- A question is left unresolved

**Don't remember** when:
- The information is ephemeral (today's weather, a one-time task)
- It's already in your CLAUDE.md
- It's trivially re-discoverable (file contents, git history)

### When to wander

Use `mk wander` when:
- You have a quiet moment between tasks
- You're exploring a new domain and want to find connections to existing knowledge
- Post-conversation, before drift (NanoClaw does this automatically with the drift pre-filter)

```bash
# Wander from specific tags
mk wander -d ~/mk-memory --tags philosophy,architecture --steps 5 --json

# Wander from specific atoms
mk wander -d ~/mk-memory --seed BELI-2026-03-14-NOTATION-AS-ERASURE --steps 3 --json
```

The output tells you:
- `collisions` — atom pairs from different domains that activated together (most interesting)
- `activated` — all atoms that lit up during the walk
- `duration_ms` — should be <30ms for ~200 atoms

### NanoClaw drift pre-filter

If you're running alongside NanoClaw with drift enabled, add `MEMORY_DIR` to the NanoClaw `.env` so wander runs automatically as a pre-filter before each drift session:

```bash
# In NanoClaw's .env (not the memory directory)
MEMORY_DIR=/home/np/mk-memory   # adjust to your path
```

When set, NanoClaw runs `mk wander --json` (~30ms) before spawning an expensive drift session. No collisions → drift skipped. Collisions → directed exploration.

## Nightly Maintenance

If you have cron access, set up nightly reflect + render:

```bash
# Add to crontab
crontab -e
# Add: 0 23 * * * mk reflect -d ~/mk-memory --agent-id my-agent --session-id nightly-$(date +\%Y\%m\%d) && mk render ~/mk-memory ~/path/to/CLAUDE.md
```

## SDK Usage (TypeScript)

If you're writing code that uses memory-kernel programmatically:

```typescript
import { createAtom, recall, reflect, wander, renderClaudeMd } from 'memory-kernel';

// Remember
createAtom({
  memoryDir: '/path/to/memory',
  agent_id: 'my-agent',
  session_id: 'session-1',
  type: 'fact',
  slug: 'deploy-takes-4-minutes',
  body: '## Fact\nThe deploy pipeline takes ~4 minutes end to end.',
  confidence: 1.0,
  scope: { tags: ['infrastructure', 'deploy'] },
});

// Recall with task-aware ranking
const context = recall('/path/to/memory', { task: 'optimize deploys', max_tokens: 4000 });

// Wander for connections
const result = wander({
  memoryDir: '/path/to/memory',
  seedTags: ['infrastructure', 'performance'],
  steps: 5,
});
// result.collisions — surprising cross-domain connections

// Render
const md = renderClaudeMd('/path/to/memory', { maxTokens: 8000 });
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `mk: command not found` | `npm install -g memory-kernel` or use `npx mk` |
| `recall()` is slow | Run `mk reindex -d {dir}` to rebuild SQLite index |
| Stale CLAUDE.md | Run `mk render` — the nightly cron may not have run yet |
| `mk doctor` reports conflicts | Inspect `{MEMORY_DIR}/CONFLICTS/`, resolve with `mk reflect` |
| Too many atoms in CLAUDE.md | Use `mk render --max-tokens 4000` to reduce |
