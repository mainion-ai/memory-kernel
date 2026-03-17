# /mk-memory-setup

A NanoClaw skill that sets up [memory-kernel](https://github.com/mainion-ai/memory-kernel) — persistent, file-based memory for AI agents.

## What It Does

Gives your NanoClaw agent persistent memory across sessions. Instead of starting each conversation from scratch, the agent reads its accumulated knowledge (beliefs, facts, decisions, preferences, open questions) from a rendered CLAUDE.md file.

The skill walks through the full setup interactively:

1. Asks where to store memory (default: `~/mk-memory`)
2. Installs the memory-kernel CLI
3. Initializes the memory directory structure
4. Creates a private GitHub repo for backup
5. Clones the memory-kernel code (for the render script)
6. Creates the mount allowlist (so NanoClaw allows container access)
7. Configures container mounts in the NanoClaw database
8. Creates symlinks for conversation logs and impulse queue
9. Adds initial identity and preference atoms
10. Renders the first CLAUDE.md
11. Sets up nightly cron (reflect → render → git push)
12. Restarts NanoClaw so the agent picks up its new memory

Each step is explained as it runs — you see what's happening and why.

## Prerequisites

- [NanoClaw](https://github.com/qwibitai/nanoclaw) installed and running
- A registered chat group (Telegram, WhatsApp, Slack, or Discord)
- Node.js 20+, Git, GitHub CLI (`gh`), SQLite3
- GitHub account with SSH access configured

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
- **GitHub username** (for the backup repo)
- **Identity description** (becomes the agent's first memory)

Then it runs all 12 steps automatically.

## Post-Setup

After setup, the agent can:

**Remember things** (inside the container):
```bash
npx mk remember "important fact" -d /workspace/extra/memory -t fact
```

**Re-render CLAUDE.md** (so next session loads the new memory):
```bash
npx tsx /workspace/extra/memory-kernel-code/scripts/render-claude-md.ts \
  /workspace/extra/memory /workspace/group/CLAUDE.md
```

**Nightly sync** runs automatically at 23:00:
- `mk reflect` — processes events into atoms
- `render-claude-md.ts` — renders atoms into CLAUDE.md
- `git push` — backs up to GitHub

## Architecture

```
Host filesystem:
  ~/mk-memory/              ← Memory data (git repo, pushed to GitHub)
    ENTITIES/                ← Atoms: beliefs, facts, decisions, preferences
    EPISODES/                ← Long-form notes
    CONFLICTS/               ← Merge conflict atoms
    events.ndjson            ← Event log (source of truth)
    conversations → symlink  ← NanoClaw session logs
    impulses.ndjson → symlink ← Curiosity queue

  ~/memory-kernel-code/     ← memory-kernel source (for render script)

Container (ephemeral, per-session):
  /workspace/extra/memory              ← mounted read-write
  /workspace/extra/memory-kernel-code  ← mounted read-only
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
5. Delete kernel code: `rm -rf ~/memory-kernel-code`
6. Remove the skill: `rm -rf container/skills/mk-memory-setup/`
7. Restart NanoClaw

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Agent can't see `/workspace/extra/memory` | Mount allowlist missing. Create `~/.config/nanoclaw/mount-allowlist.json`. Restart NanoClaw. |
| CLAUDE.md is empty | Check `ENTITIES/` has `.md` files. Re-run `render-claude-md.ts`. |
| `Cannot find package 'zod'` | `cd ~/memory-kernel-code && npm install` |
| `npx mk init -d .` fails | Use `npx mk init .` (positional arg, not flag) |
| `npx mk retain` unknown | CLI command is `remember`, not `retain` |
| Nightly cron not firing | Check `crontab -l`. Ensure PATH includes node. Use full paths. |
| Git push fails from cron | Ensure SSH key works non-interactively: `ssh -T git@github.com` |

## License

MIT — same as [memory-kernel](https://github.com/mainion-ai/memory-kernel).
