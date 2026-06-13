# /mk-memory-setup

A skill that sets up [memory-kernel](https://github.com/mainion-ai/memory-kernel) — persistent, file-based memory for AI agents — for any host that consumes it.

## What It Does

Gives your agent persistent memory across sessions. Instead of starting each conversation from scratch, the agent reads its accumulated knowledge (facts, decisions, beliefs, preferences, open questions, procedures, constraints) from memory-kernel via whichever channel the host supports.

The skill is **host-aware**. It auto-detects which host you're targeting (or asks) and routes to the right setup path:

| Host | How memory reaches the agent | Reference |
|------|------------------------------|-----------|
| **NanoClaw** | Rendered `CLAUDE.md` loaded at session start | [`references/nanoclaw.md`](references/nanoclaw.md) |
| **OpenClaw** | Native `openclaw-memory-kernel` plugin + AGENTS.md / MEMORY.md doctrine | [`references/openclaw.md`](references/openclaw.md) |
| **MCP client** *(Claude Desktop, Cursor, Continue, …)* | `mk-mcp` server launched over stdio | [`references/mcp-client.md`](references/mcp-client.md) |
| **Other / generic** | Operator wires it up themselves via SDK / CLI | — |

The universal core is the same for every host:

1. Detect / select the host *(NEW — auto-detects when possible)*
2. Ask configuration (memory dir, agent name, identity, backup, host-specific bits)
3. Install the memory-kernel CLI (`npm install -g memory-kernel`)
4. Initialise the memory directory structure
5. Optionally create a private GitHub backup repo
6. Run the host-specific plumbing from the appropriate reference file
7. Seed initial atoms (identity + preference + 11 lifecycle atoms via `seed-atoms/seed-lifecycle.sh`)
8. Render or expose memory (host-aware: render for NanoClaw, plugin for OpenClaw, server for MCP)
9. Schedule periodic reflect + render (cron line tuned to the host)
10. Verify universally with `mk status`, `mk doctor`, `mk lint`

## Important: Host-Side Skill

This skill runs on the **host machine** via Claude Code, not inside a container. It needs direct access to:

- The host filesystem (memory directory, optional config files like `claude_desktop_config.json`, cron)
- `sqlite3` (NanoClaw only — to configure container mounts)
- `systemctl` / `launchctl` (NanoClaw only — to restart the container runtime)
- `gh` CLI (only if GitHub backup is chosen)

## Prerequisites

Universal:
- Node.js 20+, Git
- GitHub CLI (`gh`) — only if you want GitHub backup of the memory directory

NanoClaw-specific:
- [NanoClaw](https://github.com/qwibitai/nanoclaw) installed and running
- A registered chat group (Telegram, WhatsApp, Slack, or Discord)
- SQLite3

OpenClaw-specific:
- An OpenClaw distribution that supports plugin loading
- (Optional) Ollama if you want local-LLM-driven `mk enrich-relations` weekly

MCP-client-specific:
- The client (Claude Desktop, Cursor, …) installed
- Knowledge of where the client stores its MCP config (the skill helps locate it)

## Installation

Merge the skill branch into your NanoClaw fork and copy it to Calude Code
```bash
# From the NanoClaw directory
cd /path/to/nanoclaw

# Get the skill from memory-kernel
git fetch https://github.com/mainion-ai/memory-kernel.git main
git checkout FETCH_HEAD -- skills/mk-memory-setup/

# Run skill from your messaging app:
/mk-memmory-setup

# or
 
# Install for Claude Code (host-side)
mkdir -p .claude/skills
cp -r skills/mk-memory-setup .claude/skills/

# Run Claude Code and invoke the skill
claude
# then: /mk-memory-setup
```

This adds `skills/mk-memory-setup/` to your NanoClaw and `.claude/skills/mk-memory-setup/`. The skill is automatically synced to agent containers at session start.

## Usage

In your chat with the agent or Claude, say:

```
/mk-memory-setup
```

The skill asks for:
- **Memory directory** (default: `~/mk-memory`)
- **Agent name** (used in commits, cron IDs)
- **Version control** — whether to back up to GitHub
- **GitHub username** (only if GitHub backup chosen)
- **Identity description** (becomes the agent's first memory)

Then it runs all steps automatically.

## Post-Setup

After setup, the agent's full operating loop ([docs/agent-session-loop.md](../../../docs/agent-session-loop.md)) is **already inside memory** as 11 typed atoms — 10 procedures (Session Start, During Session, Session End, Every 5 Sessions, Maintenance Cadence, A2A Handoff, Diagnostics, Verify Memory Claims, Supersede On Infra Change, Repeated-Sequence→Procedure) and 1 constraint (Session-Loop Pitfalls — the hard "what not to do" rules). The agent recalls its own lifecycle via `mk recall` like any other knowledge:

```bash
mk recall -d {memory-dir} --task "session loop lifecycle" --json
```

The seeds live in [`seed-atoms/lifecycle/`](seed-atoms/lifecycle/) — one markdown file per atom. Edit a file there and re-seed (Step 8b in `SKILL.md` shows how) to update what the agent knows.

**The four-step quick mnemonic** still holds:
1. **Session starts** → CLAUDE.md loaded automatically
2. **During session** → `mk remember` when learning something worth keeping; `mk relate` when you see a connection
3. **Session ends** → `mk episode`, then `mk render` to update CLAUDE.md
4. **Between sessions** → `mk wander` finds unexpected connections (used by NanoClaw drift)

The seeded atoms add the rest: when to run wander, the order of `citations` → `relink`, the weekly cron pipeline, A2A handoff protocol, and the hard rules.

See also:
- [Container quickref](../../../docs/agent-quickref-container.md) — paths and commands for container agents
- [Native quickref](../../../docs/agent-quickref-native.md) — paths and commands for host-side agents
- `/mk-doctor` — self-diagnostic to verify setup health

**Nightly sync** runs automatically at 23:00. The exact line depends on the host:

- **NanoClaw / generic:** `mk reflect → mk render → git push` (rendered file is what the agent loads).
- **OpenClaw / MCP-client:** `mk reflect → mk gc → git push` (no render — atoms reach the agent live via the plugin or `mk-mcp` server).

## Architecture

```
Host filesystem:
  ~/mk-memory/              ← Memory data (optionally a git repo, host-agnostic)
    ENTITIES/                ← Atoms: beliefs, facts, decisions, preferences, …
    EPISODES/                ← Session summaries
    CONFLICTS/               ← Merge conflict atoms
    ARCHIVE/                 ← Soft-deleted / expired atoms
    EVIDENCE/                ← Content-addressed blobs
    events.ndjson            ← Event log (source of truth)
    .memory-index.db         ← SQLite cache (derived; gitignored)

NanoClaw extras:
  Container (ephemeral, per-session):
    /workspace/extra/memory              ← mounted read-write
    /workspace/group/CLAUDE.md           ← rendered output, loaded at boot
  ~/mk-memory/conversations → symlink to NanoClaw session logs
  ~/mk-memory/impulses.ndjson → symlink to NanoClaw impulse queue
  ~/.config/nanoclaw/mount-allowlist.json ← Required or mounts silently fail

OpenClaw extras:
  Plugin loaded into the host runtime (no separate process)
  AGENTS.md / MEMORY.md / compaction prompt — the doctrine
  config.yaml in the memory dir (per-agent isolation knobs)

MCP-client extras:
  claude_desktop_config.json (or equivalent) launches `mk-mcp` over stdio
  No mounts, no plugin, no doctrine — just the server entry
```

Files are truth. SQLite is cache. Everything is human-readable, git-friendly, and rebuildable.

## Updating

Pull the latest skill branch:

```bash
cd /path/to/your/nanoclaw
git fetch https://github.com/mainion-ai/memory-kernel.git skill/mk-memory-setup
git merge FETCH_HEAD -m "Update mk-memory-setup skill"
```

## Uninstalling

Universal:

1. Remove the cron job: `crontab -e` and delete the `memory-sync` line.
2. Delete memory data: `rm -rf ~/mk-memory` *(this is destructive — back up first if you might want it later).*
3. Remove the skill: `rm -rf .claude/skills/mk-memory-setup/`

Host-specific:

- **NanoClaw:** also remove mounts from the DB (`sqlite3 store/messages.db "UPDATE registered_groups SET container_config = '{}' WHERE is_main = 1;"`), remove `~/.config/nanoclaw/mount-allowlist.json`, restart NanoClaw.
- **OpenClaw:** remove `openclaw-memory-kernel` from the host's plugin config, remove the AGENTS.md / MEMORY.md / compaction-prompt doctrine entries you copied in.
- **MCP client:** remove the `memory-kernel` entry from `claude_desktop_config.json` (or equivalent) and restart the client.

## Migrating from Old Setup

If your agent was set up before `mk render` existed (pre-v1.1.0) and uses the old `render-claude-md.ts` script:

1. Update memory-kernel: `npm install -g memory-kernel`
2. Remove the `memory-kernel-code` mount from your NanoClaw DB (NanoClaw only).
3. Update your cron job to use `npx mk render` instead of `npx tsx render-claude-md.ts`
4. Optionally remove the cloned `~/memory-kernel-code` directory.

If your agent is missing the lifecycle atoms (was set up before Step 6b existed): re-run `bash <skill-dir>/seed-atoms/seed-lifecycle.sh ~/mk-memory`. The `/mk-doctor` skill will flag this for you automatically.

## Troubleshooting

Universal items (host-agnostic):

| Problem | Solution |
|---------|----------|
| `npm install -g` fails with EACCES | Fix npm prefix: `mkdir -p ~/.npm-global && npm config set prefix '~/.npm-global'` then add to PATH. |
| `npx mk init -d .` fails | Use `npx mk init .` (positional arg, not flag) |
| `npx mk retain` unknown | CLI command is `remember`, not `retain` |
| Nightly cron not firing | Check `crontab -l`. Ensure PATH includes node. Use full paths. |
| Git push fails from cron | Ensure SSH key works non-interactively: `ssh -T git@github.com` |
| Lifecycle atoms missing on a previously set-up agent | Run `bash <skill-dir>/seed-atoms/seed-lifecycle.sh ~/mk-memory` |

Host-specific troubleshooting lives in each reference file:

- NanoClaw: [`references/nanoclaw.md`](references/nanoclaw.md#nanoclaw-specific-troubleshooting)
- OpenClaw: [`references/openclaw.md`](references/openclaw.md#openclaw-specific-troubleshooting)
- MCP client: [`references/mcp-client.md`](references/mcp-client.md#mcp-specific-troubleshooting)

## License

MIT — same as [memory-kernel](https://github.com/mainion-ai/memory-kernel).
