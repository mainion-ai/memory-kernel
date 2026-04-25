#!/usr/bin/env bash
#
# seed-lifecycle.sh — Seed the 8 lifecycle atoms (7 procedures + 1 constraint)
#                     into a memory-kernel store.
#
# Bodies are sourced from the lifecycle/ directory next to this script.
# Each atom carries a stable --slug so re-seeding (after archiving the stale
# version from ENTITIES/) overwrites the same logical atom.
#
# Usage:   bash seed-lifecycle.sh <memory-dir>
# Example: bash ~/.claude/skills/mk-memory-setup/seed-atoms/seed-lifecycle.sh ~/mk-memory
#
# Universal across hosts: the lifecycle is a property of memory-kernel itself,
# not of NanoClaw, OpenClaw, or any MCP client. Run this regardless of host.

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <memory-dir>" >&2
  exit 1
fi

MEMORY_DIR="$1"

if [ ! -d "$MEMORY_DIR/ENTITIES" ]; then
  echo "Memory directory missing or uninitialised (no ENTITIES/): $MEMORY_DIR" >&2
  echo "Run 'mk init $MEMORY_DIR' first." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEED_DIR="$SCRIPT_DIR/lifecycle"

if [ ! -d "$SEED_DIR" ]; then
  echo "Lifecycle seed directory not found: $SEED_DIR" >&2
  echo "This script must live alongside the lifecycle/ directory." >&2
  exit 1
fi

# Each entry: <filename>|<atom-type>|<stable-slug>|<space-separated-tags>
SEEDS=(
  "01-session-start.md|procedure|session-start-procedure|session-loop lifecycle agent-setup"
  "02-during-session.md|procedure|during-session-procedure|session-loop lifecycle agent-setup"
  "03-session-end.md|procedure|session-end-procedure|session-loop lifecycle agent-setup"
  "04-every-5-sessions.md|procedure|every-5-sessions-procedure|session-loop lifecycle agent-setup"
  "05-maintenance-cadence.md|procedure|maintenance-cadence-procedure|session-loop lifecycle agent-setup"
  "06-a2a-handoff.md|procedure|a2a-handoff-procedure|session-loop lifecycle agent-setup"
  "07-diagnostics.md|procedure|diagnostics-procedure|session-loop lifecycle agent-setup"
  "08-what-not-to-do.md|constraint|session-loop-pitfalls|session-loop constraints agent-setup"
)

echo "Seeding ${#SEEDS[@]} lifecycle atoms into $MEMORY_DIR ..."

for entry in "${SEEDS[@]}"; do
  IFS='|' read -r file type slug tags <<< "$entry"
  body_path="$SEED_DIR/$file"

  if [ ! -f "$body_path" ]; then
    echo "  ⚠ Missing seed file: $file (skipping)" >&2
    continue
  fi

  # Word-split tags intentionally — mk remember --tags accepts variadic args.
  # shellcheck disable=SC2086
  npx mk remember "$(cat "$body_path")" \
    -d "$MEMORY_DIR" -t "$type" --slug "$slug" \
    --tags $tags

  echo "  ✓ $type/$slug ← $file"
done

echo
echo "✓ Lifecycle seed complete. Verify with:"
echo "    npx mk recall -d \"$MEMORY_DIR\" --types procedure,constraint --json | jq '[.atoms[] | select(.tags[]? == \"session-loop\")] | length'"
echo "  Expected: 8 (7 procedures + 1 constraint)"
