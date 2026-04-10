# Autonomous Dev Pipeline — Design Document

How mainion-ai uses Claude Code CLI to develop features on memory-kernel-dev autonomously, with human review before public promotion.

**IMPORTANT**: All new feature development MUST happen on `memory-kernel-dev` (private), NOT directly on `memory-kernel` (public). Features are promoted to public only after review and approval.

## Architecture

```
mainion-ai (product owner)     Claude Code (engineer)     Nenad (final gate)
        │                            │                          │
        ├─ writes spec ──────────────┤                          │
        │                   implements feature                  │
        │                   creates PR on dev                   │
        ├─ reviews design ───────────┤                          │
        │                   runs /code-review                   │
        │                   fixes review issues                 │
        ├─ verifies tests ───────────┤                          │
        │                   merges to dev/main                  │
        ├─ promotes to public ───────┼──────────────────────────┤
        │                            │              approves release
```

## Key Findings from Official Docs

### 1. Skills are NOT invocable via `/` in `-p` mode

> "User-invoked skills like `/commit` and built-in commands are only available in interactive mode. In `-p` mode, describe the task you want to accomplish instead."

This means: we CANNOT run `claude -p "/feature-dev implement X"`. Instead, we describe the task directly and let Claude Code use its tools (including agents from plugins).

### 2. Plugins still load in `-p` mode (unless `--bare`)

When NOT using `--bare`, Claude Code loads plugins, CLAUDE.md, MCP servers, etc. The `feature-dev` and `code-review` plugins provide subagents (code-explorer, code-architect, code-reviewer) that Claude Code CAN use in `-p` mode — it just won't follow the interactive 7-phase workflow.

### 3. `--bare` skips everything — use sparingly

`--bare` skips hooks, skills, plugins, MCP, CLAUDE.md. Fast but loses all context. Only useful for simple one-shot commands. NOT suitable for feature development.

### 4. `--continue` / `--resume` enable multi-step workflows

```bash
# Step 1: implement
session_id=$(claude -p "..." --output-format json | jq -r '.session_id')
# Step 2: continue in same context
claude -p "Now fix the review issues" --resume "$session_id"
```

### 5. Permission modes

| Mode | Behavior | Use case |
|------|----------|----------|
| `acceptEdits` | Auto-approves file reads + edits + filesystem commands | Feature development |
| `dontAsk` | Denies anything not in allow rules | Locked-down CI |
| `bypassPermissions` | Skips all checks | Full autonomy (dangerous) |

### 6. Safety limits

- `--max-turns N` — limits agentic turns (exits with error when reached)
- `--max-budget-usd N` — caps API spend

### 7. `/feature-dev` is fundamentally interactive

The plugin's 7-phase workflow asks questions at phases 1, 3, 4, and 5 (waits for user input). This doesn't work in `-p` mode. The workaround: write a comprehensive spec that pre-answers all questions, so Claude Code can implement without asking.

## The Pipeline

### Step 1: I write a feature spec

A detailed spec that pre-answers what `/feature-dev` would ask interactively:

```markdown
## Feature: [name]
## Problem: [what it solves]
## Design: [chosen approach with rationale]
## Files to modify: [list]
## Files to create: [list]
## Test requirements: [specific test cases]
## Acceptance criteria: [how to verify]
```

### Step 2: Claude Code implements

```bash
cd /home/mainion/repos/memory-kernel

claude -p "$(cat /tmp/feature-spec.md)" \
  --permission-mode acceptEdits \
  --allowedTools "Bash(npm test *)" "Bash(npm run build *)" "Bash(git *)" \
  --max-turns 50 \
  --max-budget-usd 5.00 \
  --output-format json \
  --name "feature-impl"
```

Key choices:
- **No `--bare`**: plugins + CODING_INSTRUCTIONS.md should load for context
- **`acceptEdits`**: auto-approves reads and file edits (the main work)
- **`--allowedTools`**: pre-approves test, build, and git commands
- **`--max-turns 50`**: safety limit (feature-dev spawns many subagents)
- **`--max-budget-usd 5.00`**: cost cap per implementation run
- **`--name`**: for session resumption if needed

### Step 3: I review the implementation

I read the changed files, check:
- Design intent matches spec
- Codebase conventions followed (CODING_INSTRUCTIONS.md)
- Edge cases handled
- No security regressions

### Step 4: I run tests

```bash
cd /home/mainion/repos/memory-kernel
npm test          # full suite (790+ tests)
npm run build     # TypeScript compilation
# Manual tests on live store as specified in acceptance criteria
```

### Step 5: Create PR on memory-kernel-dev

```bash
cd /home/mainion/repos/memory-kernel
git checkout -b feature/[name]
git add [specific files]
git commit -m "feat: [description]"
git push dev feature/[name]
# Create PR via gh
gh pr create --repo mainion-ai/memory-kernel-dev \
  --title "feat: [name]" \
  --body "..."
```

### Step 6: Claude Code runs code review

```bash
cd /home/mainion/repos/memory-kernel

claude -p "Review PR #N on mainion-ai/memory-kernel-dev for bugs and CODING_INSTRUCTIONS.md compliance. Post your review as a comment on the PR." \
  --permission-mode acceptEdits \
  --allowedTools "Bash(gh *)" "Read" "Grep" "Glob" \
  --max-turns 30 \
  --max-budget-usd 3.00 \
  --output-format json \
  --name "code-review"
```

The code-review plugin's agents (5 parallel Sonnet reviewers + Haiku scorers) will be available. The prompt describes the task; Claude Code orchestrates using its available tools and agents.

### Step 7: Claude Code fixes issues

```bash
# Resume the implementation session with review findings
claude -p "Fix the issues found in the code review: [paste or summarize findings]" \
  --resume "$impl_session_id" \
  --permission-mode acceptEdits \
  --allowedTools "Bash(npm test *)" "Bash(npm run build *)" "Bash(git *)" \
  --max-turns 30 \
  --max-budget-usd 3.00
```

### Step 8: I verify and merge

- Confirm all review issues addressed
- Re-run tests
- Merge to dev/main

### Step 9: Public promotion (with Nenad)

- Cherry-pick or merge dev/main → origin/main
- Version bump, changelog, npm publish
- GitHub release

## CLAUDE.md for memory-kernel

Memory-kernel currently has `CODING_INSTRUCTIONS.md` but no `CLAUDE.md`. For Claude Code to have proper context in `-p` mode, we should create one that references the coding instructions. This is a prerequisite.

```markdown
# memory-kernel

TypeScript library for persistent agent memory with event sourcing.

## Before writing code, read CODING_INSTRUCTIONS.md

It contains test structure, API gotchas, security rules, and conventions.

## Commands
- `npm test` — run all tests (vitest)
- `npm run build` — compile TypeScript
- Tests live in `test/`, source in `src/`

## Key conventions
- All file paths must pass `assertWithinDir()` before I/O
- Always call `closeAllIndexes()` before directory cleanup in tests
- Events are NDJSON in `events.ndjson`
- Atom IDs: `TYPE-YYYY-MM-DD-SLUG-suffix`
```

## Practical Constraints

### I can't run interactive Claude Code

I'm a NanoClaw agent — I interact through Telegram messages routed to the Claude Agent SDK. I can run `claude -p` commands via Bash, but I can't have an interactive terminal session. Everything must go through `-p` mode.

### Hardware

Running on Beelink SER5 MAX (16 cores, 20GB RAM, Ubuntu 24.04). Resource constraints are minimal but still monitor with `--max-turns` and `--max-budget-usd`.

### Plugin agents are Sonnet-class

The code-reviewer agent specifies `model: sonnet`. Feature-dev uses code-explorer (Explore type), code-architect (Plan type), code-reviewer (Sonnet). These are the right models for the task — no need to override.

## First Dry Run: Relation-Type Enrichment

The first feature to test the pipeline:

**Feature**: Add `--json` output to core CLI commands (from the existing plan)
**Why this first**: Well-scoped, clear spec, testable, useful for the pipeline itself

OR

**Feature**: Relation-type enrichment batch command (`mk enrich-relations`)
**Why**: Was the planned next build, but more complex

Recommendation: Start with `--json` output on a single command (e.g., `mk status --json`) as a minimal dry run to validate the pipeline mechanics before attempting something larger.

## Open Questions

1. **CLAUDE.md creation**: Should I create it before the first dry run? (Probably yes — it's the context Claude Code reads)
2. **memory-kernel-dev setup**: Is there a dev remote/repo already? Need to verify access and PR workflow
3. **Budget calibration**: The $5/$3 limits are guesses. First run will calibrate actual costs
4. **Session persistence**: Should implementation sessions be preserved for debugging? (`--no-session-persistence` vs default)
