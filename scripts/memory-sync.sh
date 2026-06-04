#!/usr/bin/env bash
# Memory sync — reflect, render to NanoClaw, commit & push to GitHub.
# Run after sessions or via cron.

set -euo pipefail

MEMORY_DIR="${MEMORY_DIR:-${HOME}/mk-memory}"
MEMORY_REPO="${MEMORY_REPO:-$(dirname "$MEMORY_DIR")}"
KERNEL_REPO="${KERNEL_REPO:-${HOME}/repos/memory-kernel}"
# NanoClaw renders per-group CLAUDE.md files at ~/nanoclaw/groups/<group>/CLAUDE.md.
# Set CLAUDE_MD to your group's path; the default below is a neutral fallback
# only useful for single-group setups that symlink to ~/.nanoclaw/CLAUDE.md.
CLAUDE_MD="${CLAUDE_MD:-${HOME}/.nanoclaw/CLAUDE.md}"

echo "[$(date -Iseconds)] Memory sync starting..."

# 1. Reflect — consolidate, TTL, dedup, promote
echo "→ Reflecting..."
cd "$KERNEL_REPO"
npx tsx src/cli/mk.ts reflect -d "$MEMORY_DIR" --agent-id "my-agent" --session-id "sync-$(date +%Y%m%d-%H%M)"

# 2. Render to NanoClaw CLAUDE.md
echo "→ Rendering CLAUDE.md..."
npx tsx scripts/render-claude-md.ts "$MEMORY_DIR" "$CLAUDE_MD"

# 3. Commit & push memory repo (if changed)
echo "→ Committing memory..."
cd "$MEMORY_REPO"
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -m "Memory sync $(date +%Y-%m-%d\ %H:%M)"
  git push
  echo "✓ Memory pushed to GitHub"
else
  echo "✓ No memory changes to commit"
fi

echo "[$(date -Iseconds)] Memory sync complete."
