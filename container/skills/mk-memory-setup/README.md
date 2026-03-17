# /mk-memory-setup

A NanoClaw skill that sets up [memory-kernel](https://github.com/mainion-ai/memory-kernel) — persistent, file-based memory for AI agents.

## What It Does

Gives your NanoClaw agent persistent memory across sessions. Instead of starting each conversation from scratch, the agent reads its accumulated knowledge (beliefs, facts, decisions, preferences, open questions) from a rendered CLAUDE.md file.

The skill walks through the full setup interactively:

1. Asks where to store memory (default: `~/mk-memory`)
2. Asks the agent's name and identity description
3. Asks whether to back up memory to GitHub (optional)
4. Installs the memory-kernel CLI (`npm install -g memory-kernel`)
5. Initializes the memory directory structure
6. Creates a private GitHub repo for backup (if chosen)
7. Creates the mount allowlist (so NanoClaw allows container access)
8. Configures container mounts in the NanoClaw database
9. Creates symlinks for conversation logs and impulse queue
10. Adds initial identity and preference atoms
11. Renders the first CLAUDE.md
12. Sets up nightly cron (reflect → render → optionally git push)
13. Restarts NanoClaw so the agent picks up its new memory

Each step is explained as it runs — you see what's happening and why.

## Important: Host-Side Skill

This skill runs on the **host machine** via Claude Code, not inside a container. It needs direct access to:

- The host filesystem (memory directory, NanoClaw DB, cron)
- `sqlite3` (to configure NanoClaw container mounts)
- `systemctl` / `launchctl` (to restart NanoClaw)
- `gh` CLI (only if GitHub backup is chosen)

## Prerequisites

- [NanoClaw](https://github.com/qwibitai/nanoclaw) installed and running
- A registered chat group (Telegram, WhatsApp, Slack, or Discord)
- Node.js 20+, Git, SQLite3
- GitHub CLI (`gh`) — only if you want GitHub backup

## Installation

Merge the skill branch into your NanoClaw fork:

```bash
cd /path/to/your/nanoclaw
git fetch https://github.com/mainion-ai/memory-kernel.git skill/mk-memory-setup
git merge FETCH_HEAD --allow-unrelated-histories -m "Add mk-memory-setup skill"
npm run build
```

This adds `container/skills/mk-memory-setup/` to your NanoClaw. The skill is automatically synced to agent containers at session start.

## Usage

In your chat with the agent, say:

```
Set up memory-kernel
```

or

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

After setup, the agent can:

**Remember things** (inside the container):
```bash
npx mk remember "important fact" -d /workspace/extra/memory -t fact
```

**Re-render CLAUDE.md** (so next session loads the new memory):
```bash
npx mk render /workspace/extra/memory /workspace/group/CLAUDE.md
```

**Nightly sync** runs automatically at 23:00:
- `mk reflect` — processes events into atoms
- `mk render` — renders atoms into CLAUDE.md
- `git push` — backs up to GitHub (if configured)

## Architecture

```
Host filesystem:
  ~/mk-memory/              ← Memory data (optionally a git repo)
    ENTITIES/                ← Atoms: beliefs, facts, decisions, preferences
    EPISODES/                ← Long-form notes
    CONFLICTS/               ← Merge conflict atoms
    events.ndjson            ← Event log (source of truth)
    conversations → symlink  ← NanoClaw session logs
    impulses.ndjson → symlink ← Curiosity queue

Container (ephemeral, per-session):
  /workspace/extra/memory              ← mounted read-write
  /workspace/group/CLAUDE.md           ← rendered output, loaded at boot

~/.config/nanoclaw/mount-allowlist.json ← Required or mounts silently fail
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

1. Remove the cron job: `crontab -e` and delete the memory-sync line
2. Remove mounts from NanoClaw DB:
   ```bash
   sqlite3 store/messages.db "UPDATE registered_groups SET container_config = '{}' WHERE is_main = 1;"
   ```
3. Remove mount allowlist: `rm ~/.config/nanoclaw/mount-allowlist.json`
4. Delete memory data: `rm -rf ~/mk-memory`
5. Remove the skill: `rm -rf container/skills/mk-memory-setup/`
6. Restart NanoClaw

## Migrating from Old Setup

If your agent was set up before `mk render` existed (pre-v1.1.0) and uses the old `render-claude-md.ts` script:

1. Update memory-kernel: `npm install -g memory-kernel`
2. Remove the memory-kernel-code mount from your NanoClaw DB
3. Update your cron job to use `npx mk render` instead of `npx tsx render-claude-md.ts`
4. Optionally remove the cloned `~/memory-kernel-code` directory

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Agent can't see `/workspace/extra/memory` | Mount allowlist missing. Create `~/.config/nanoclaw/mount-allowlist.json`. Restart NanoClaw. |
| CLAUDE.md is empty | Check `ENTITIES/` has `.md` files. Re-run `npx mk render`. |
| `npm install -g` fails with EACCES | Fix npm prefix: `mkdir -p ~/.npm-global && npm config set prefix '~/.npm-global'` then add to PATH. |
| `npx mk init -d .` fails | Use `npx mk init .` (positional arg, not flag) |
| `npx mk retain` unknown | CLI command is `remember`, not `retain` |
| Nightly cron not firing | Check `crontab -l`. Ensure PATH includes node. Use full paths. |
| Git push fails from cron | Ensure SSH key works non-interactively: `ssh -T git@github.com` |

## License

MIT — same as [memory-kernel](https://github.com/mainion-ai/memory-kernel).
