#!/usr/bin/env bash
#
# seed-lifecycle.sh — Idempotently seed the canonical lifecycle atoms
#                     (10 procedures + 1 constraint) into a memory-kernel store.
#
# Thin wrapper over `mk seed --lifecycle` (#329): the command is the single
# source of truth for the canonical set (see lifecycle/manifest.json) and is
# idempotent — re-running reconciles in place (supersedes stale/duplicate
# atoms) rather than duplicating. The canonical seeds ship inside the npm
# package, so a fresh `npm i -g memory-kernel` can seed without cloning a repo.
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

# Delegate to the idempotent command. Pass an explicit --seed-dir so the
# lifecycle bodies that ship alongside THIS script are used even if a stale
# `mk` on PATH bundles a different canonical set.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEED_DIR="$SCRIPT_DIR/lifecycle"

npx mk seed --lifecycle -d "$MEMORY_DIR" --seed-dir "$SEED_DIR"

echo
echo "✓ Lifecycle seed reconciled. Confirm idempotency (a dry re-run should report all unchanged):"
echo "    npx mk seed --lifecycle -d \"$MEMORY_DIR\" --dry-run"
echo "  Once the doctor seed-set-freshness check (#330) ships, 'mk doctor' is the canonical verifier."
