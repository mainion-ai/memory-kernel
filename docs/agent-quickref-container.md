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

# Check what you know
npx mk status -d /workspace/extra/memory

# Find connections between atoms (spreading activation)
npx mk wander -d /workspace/extra/memory --tags api,performance --json

# Validate your memory setup
npx mk doctor -d /workspace/extra/memory
```

## When to Use Each Command

| Situation | Command |
|-----------|---------|
| You learned something new | `mk remember ... -t fact` |
| You or the user made a choice | `mk remember ... -t decision` |
| You have a hypothesis | `mk remember ... -t belief` |
| User told you a preference | `mk remember ... -t preference` |
| Something is unresolved | `mk remember ... -t open_question` |
| You wrote a how-to | `mk remember ... -t procedure` |
| After any `mk remember` | `mk render` (updates CLAUDE.md for next session) |
| Start of session (optional) | `mk recall -d ... --task "current task"` |
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
