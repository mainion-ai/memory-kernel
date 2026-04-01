# Agent Quick Reference — Container Mode

> **Audience:** You are an AI agent running inside a NanoClaw container. This doc tells you how to use memory-kernel from inside `/workspace/`.

## Paths

| What | Path |
|------|------|
| Memory data | `/workspace/extra/memory` |
| Your CLAUDE.md | `/workspace/group/CLAUDE.md` |
| Conversation logs | `/workspace/group/logs/` |
| Impulse queue | `/workspace/group/impulses.ndjson` |

## Quick Commands

> **Note:** If `npx mk` fails with "could not determine executable," see the [/tmp install workaround](#tmp-install-workaround) below.

```bash
# Remember something (creates an atom)
npx mk remember "The API rate limit is 1000 req/min" \
  -d /workspace/extra/memory -t fact --tags api,infrastructure

# Remember a decision
npx mk remember "Use cursor pagination instead of offset" \
  -d /workspace/extra/memory -t decision --tags api,performance

# Remember a belief (unverified — will expire in 30 days unless promoted)
npx mk remember "The new cache layer reduces p99 by ~40%" \
  -d /workspace/extra/memory -t belief --tags performance,cache

# Re-render CLAUDE.md so next session picks up new atoms
npx mk render /workspace/extra/memory /workspace/group/CLAUDE.md

# Embed all atoms for semantic search (requires EMBEDDING_PROVIDER + EMBEDDING_API_KEY)
npx mk reindex -d /workspace/extra/memory --embed

# Check what you know
npx mk status -d /workspace/extra/memory

# Find connections between atoms (spreading activation)
npx mk wander -d /workspace/extra/memory --tags api,performance --json

# Validate your memory setup
npx mk doctor -d /workspace/extra/memory

# Create a typed relation edge between two atoms (v1.4.0+)
npx mk relate DECI-2026-04-01-USE-POSTGRES-abc1 supports FACT-2026-04-01-BENCH-xyz9 \
  -d /workspace/extra/memory

# Show all edges for an atom (v1.4.0+)
npx mk relations DECI-2026-04-01-USE-POSTGRES-abc1 -d /workspace/extra/memory
```

## Semantic Search (Optional)

Embeddings add intent-aware recall on top of keyword matching. **Fully optional** — everything works without it.

### Provider options

```bash
EMBEDDING_PROVIDER=voyage    # voyage-3-lite, 512-dim, free tier
EMBEDDING_PROVIDER=openai    # text-embedding-3-small, 1536-dim, $0.02/MTok
```

### Setup in NanoClaw containers

Env vars must be available in the container shell (not just NanoClaw's `data/env/env`). Export them before calling `mk`:

```bash
# Option 1: Export in your session (temporary — lost on container restart)
export EMBEDDING_PROVIDER=voyage
export EMBEDDING_API_KEY=pa-...

# Option 2: Ask the user to add to the host's NanoClaw env config
# (data/env/env or docker-compose.yml environment section)
# so the vars are injected automatically on every container start.

# Then embed all existing atoms:
npx mk reindex -d /workspace/extra/memory --embed

# Verify:
npx mk status -d /workspace/extra/memory
# Should show: Embeddings: ✓ (N vectors, model: voyage-3-lite)
```

Once configured, `mk remember` **auto-embeds new atoms** — no extra step needed. If embedding fails (network, rate limit), it prints a warning and the atom is still created.

### Upgrading from v1.1.x

The first `mk reindex` after upgrading silently migrates the index schema (v3 → v4). This is safe — the index is a derived cache rebuilt from files. To add embeddings after upgrade:

```bash
npx mk reindex -d /workspace/extra/memory           # rebuild index (schema v4)
npx mk reindex -d /workspace/extra/memory --embed    # optional: add semantic search
```

## When to Use Each Command

| Situation | Command |
|-----------|---------|
| You learned something new | `mk remember ... -t fact` (auto-embeds if configured) |
| You or the user made a choice | `mk remember ... -t decision` |
| You have a hypothesis | `mk remember ... -t belief` |
| User told you a preference | `mk remember ... -t preference` |
| Something is unresolved | `mk remember ... -t open_question` |
| You wrote a how-to | `mk remember ... -t procedure` |
| After any `mk remember` | `mk render` (updates CLAUDE.md for next session) |
| Start of session (optional) | `mk recall -d ... --task "current task"` (uses semantic re-ranking if embeddings configured) |
| Looking for unexpected connections | `mk wander -d ... --tags tag1,tag2` |

## Session Loop

The recommended pattern for using memory during a session:

```
Session starts → CLAUDE.md already loaded (automatic)
                 ↓
During session → mk remember (when you learn something worth keeping)
                 ↓
Session ends   → mk render (so next session has the new knowledge)
```

You don't need to `mk recall` at session start — CLAUDE.md already contains your rendered memory. Use `mk recall --task "..."` only when you need task-specific context that might not be in the rendered view.

## /tmp Install Workaround

If `npx mk` fails with "could not determine executable to run" (memory-kernel not in the container's npm cache):

```bash
# Install to /tmp (writable in containers)
cd /tmp && npm install memory-kernel

# Verify it works
/tmp/node_modules/.bin/mk --version

# Then use the full path for all commands:
/tmp/node_modules/.bin/mk remember "text" -d /workspace/extra/memory -t fact
/tmp/node_modules/.bin/mk render /workspace/extra/memory /workspace/group/CLAUDE.md
/tmp/node_modules/.bin/mk reindex -d /workspace/extra/memory --embed
```

**Important:** The install must be done from `/tmp` (`cd /tmp && npm install`) so the binary lands at `/tmp/node_modules/.bin/mk`.

Or if the host has memory-kernel source mounted:
```bash
node /workspace/extra/memory-kernel-code/dist/cli/mk.js --version
```

## Atom Types Reference

| Type | What it stores | Default TTL |
|------|---------------|-------------|
| `fact` | Verified truths | ∞ (never expires) |
| `decision` | Architecture/design choices | ∞ |
| `constraint` | Rules and boundaries | ∞ |
| `belief` | Hypotheses, not yet verified | 30 days |
| `preference` | User or agent preferences | 180 days |
| `open_question` | Unresolved questions | 90 days |
| `procedure` | How-to instructions | ∞ |
| `entity_summary` | Descriptions of key things | 180 days |
| `conflict` | Contradicting information | 30 days |

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `npx mk` not found | Use `/tmp` install workaround above |
| `/workspace/extra/memory` doesn't exist | Mount not configured. Tell the user to check `mount-allowlist.json` |
| `mk render` says "No atoms found" | Check `ls /workspace/extra/memory/ENTITIES/` — should have `.md` files |
| CLAUDE.md not updating between sessions | Run `mk render` after `mk remember` |
| `mk doctor` shows issues | Follow its suggestions — usually missing index (`mk reindex`) |
| Embeddings not working | `export EMBEDDING_PROVIDER=voyage EMBEDDING_API_KEY=pa-...` then `mk reindex --embed`. Vars must be in shell env, not just NanoClaw's env file |
| `mk remember` says "⚠ Embedding failed" | Env vars not reaching the container shell. See [Semantic Search](#semantic-search-optional) setup |
| `mk status` shows "Embeddings: ✗" | Run `mk reindex --embed` with env vars exported |
