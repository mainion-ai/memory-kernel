---
name: mk-doctor
description: Diagnose and fix memory-kernel setup issues. Use when memory isn't working, CLAUDE.md is empty, atoms aren't being retained, or you want to verify your memory setup is healthy. Triggers on "check memory", "memory broken", "mk doctor", "memory not working", "diagnose memory", "fix memory".
---

# Memory-Kernel Doctor

Self-diagnostic for memory-kernel. Run this to verify your setup is healthy or to find and fix problems.

**Works in both container and native mode.** The skill auto-detects your environment.

## Step 1: Detect Environment

```bash
# Am I in a container or on the host?
if [ -d /workspace/group ]; then
  echo "CONTAINER MODE"
  MEMORY_DIR="/workspace/extra/memory"
  CLAUDE_MD="/workspace/group/CLAUDE.md"
  MK_CMD="npx mk"
else
  echo "NATIVE MODE"
  # Try common locations
  for p in ~/mk-memory ~/repos/memory/kernel; do
    [ -d "$p/ENTITIES" ] && MEMORY_DIR="$p" && break
  done
  echo "Memory dir: ${MEMORY_DIR:-NOT FOUND}"
  MK_CMD="mk"
fi
```

If `MEMORY_DIR` is not found, ask the user: "Where is your memory-kernel data directory?"

## Step 2: Check Memory Directory

```bash
# Does the directory exist?
ls -la $MEMORY_DIR/

# Expected structure:
# ENTITIES/   — atom files (source of truth)
# ARCHIVE/    — archived atoms
# EVIDENCE/   — content-addressed blobs
# CONFLICTS/  — conflict atoms
# EPISODES/   — session summaries
# events.ndjson — event log
```

**If missing directories:** Run `$MK_CMD init $MEMORY_DIR` to create them.

**If ENTITIES/ is empty:** Memory was initialized but no atoms were created yet. This is normal for a fresh setup — see Step 7 (Bootstrap).

## Step 3: Run mk doctor

```bash
$MK_CMD doctor -d $MEMORY_DIR
```

This checks:
- **Schema validation** — all atom frontmatter is valid YAML with required fields
- **Broken links** — atoms reference IDs that don't exist
- **Active conflicts** — contradicting atoms that need resolution

**If `mk doctor` fails with "command not found":**

Container:
```bash
cd /tmp && npm install memory-kernel 2>/dev/null
node /tmp/node_modules/.bin/mk doctor -d $MEMORY_DIR
```

Native:
```bash
npm install -g memory-kernel
mk doctor -d $MEMORY_DIR
```

## Step 4: Check Index

```bash
$MK_CMD status -d $MEMORY_DIR
```

Look for the index status line. If it says "no index" or recall is slow:

```bash
$MK_CMD reindex -d $MEMORY_DIR
```

## Step 5: Check CLAUDE.md

```bash
# Does it exist and have content?
head -5 $CLAUDE_MD
```

**If missing or empty:**
```bash
$MK_CMD render $MEMORY_DIR $CLAUDE_MD
head -5 $CLAUDE_MD
```

**If render says "No atoms found"** but ENTITIES/ has files:
```bash
# Check if atoms have valid frontmatter
ls $MEMORY_DIR/ENTITIES/
$MK_CMD status -d $MEMORY_DIR
```

## Step 6: Check Event Log

```bash
wc -l $MEMORY_DIR/events.ndjson
```

If empty (0 lines) but atoms exist in ENTITIES/:
```bash
# Bootstrap events from existing atoms
$MK_CMD bootstrap-events -d $MEMORY_DIR
```

## Step 7: Bootstrap (First-Time Setup)

If this is a fresh installation with no atoms:

```bash
# Create a seed identity atom so CLAUDE.md isn't blank
$MK_CMD remember "Memory-kernel initialized. This agent uses persistent typed memory across sessions." \
  -d $MEMORY_DIR -t fact --tags setup,identity

# Render initial CLAUDE.md
$MK_CMD render $MEMORY_DIR $CLAUDE_MD
```

The agent should add more atoms during its first real session:
- Identity facts (who am I, what system am I on)
- User preferences (communication style, autonomy level)
- Infrastructure facts (paths, services, credentials location)

## Step 8: Container-Specific Checks

**Only if in container mode:**

```bash
# Is the memory mount working?
ls /workspace/extra/memory/ENTITIES/ 2>/dev/null || echo "MOUNT MISSING"

# Can I write to it?
touch /workspace/extra/memory/.write-test && rm /workspace/extra/memory/.write-test && echo "WRITABLE" || echo "READ-ONLY"
```

**If mount is missing:** Tell the user:
> "The memory directory isn't mounted in this container. Check that `~/.config/nanoclaw/mount-allowlist.json` exists on the host and includes the memory directory path. Then check the `container_config` in the NanoClaw database has the mount configured. Restart NanoClaw after fixing."

**If read-only:** Tell the user:
> "The memory mount is read-only. Update the mount config to set `readonly: false` and restart NanoClaw."

## Step 9: Nightly Cron Check (Native Only)

```bash
crontab -l 2>/dev/null | grep -i memory
```

**If no cron entry:**
```bash
echo "⚠ No nightly memory sync cron found."
echo "  Without it, atoms won't be consolidated and CLAUDE.md won't auto-update."
echo "  Set up with: crontab -e"
echo "  Add: 0 23 * * * mk reflect -d $MEMORY_DIR --agent-id MY_AGENT --session-id nightly-\$(date +\\%Y\\%m\\%d) && mk render $MEMORY_DIR $CLAUDE_MD"
```

## Summary Report

Print a summary at the end:

```
Memory-Kernel Health Check
──────────────────────────
Environment:    container | native
Memory dir:     {path}
CLAUDE.md:      {path}
Atoms:          {count} ({by_type})
Events:         {count}
Index:          ✓ built | ✗ missing
Doctor:         ✓ healthy | ✗ {N} issues
CLAUDE.md:      ✓ {lines} lines | ✗ empty
Cron:           ✓ configured | ✗ not set (native only)
Mount:          ✓ writable | ✗ missing (container only)
```
