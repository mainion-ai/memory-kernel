---
name: mk-memory-setup
description: Set up memory-kernel — persistent, file-based agent memory — for any host that needs it. Universal core (install CLI, init store, seed identity + lifecycle atoms, schedule reflect) plus host-specific plumbing for NanoClaw container agents (mounts, allowlist, restart), OpenClaw plugin-based agents (plugin install, isolation config, AGENTS.md / MEMORY.md doctrine), or any MCP-capable client (Claude Desktop, Cursor, Continue) that needs an `mk-mcp` server entry. Use when the user asks to "set up memory-kernel", "install mk", "configure agent memory", "add persistent memory to my agent", "wire up memory-kernel for NanoClaw / OpenClaw / Claude Desktop / Cursor", or anything similar where memory-kernel is being introduced to an agent host. Triggers on "mk-memory-setup", "memory-kernel setup", "set up agent memory", "install memory-kernel", "configure mk", "persistent memory across sessions", "add memory to my agent", "memory-kernel for NanoClaw", "memory-kernel for OpenClaw", "memory-kernel MCP server".
---

# Memory-Kernel Setup

Set up persistent, typed memory for an AI agent. The skill has a **universal core** that works for every host (install CLI → init store → seed atoms → schedule reflect) and **host-specific extensions** for the three integration paths memory-kernel is designed around:

| Host | What it consumes | Reference file |
|------|------------------|----------------|
| **NanoClaw** (container agent) | Rendered `CLAUDE.md` loaded at session start | `references/nanoclaw.md` |
| **OpenClaw** (plugin-based agent) | Native `openclaw-memory-kernel` plugin + AGENTS.md / MEMORY.md doctrine | `references/openclaw.md` |
| **MCP client** (Claude Desktop, Cursor, etc.) | `mk-mcp` server launched by the client over stdio | `references/mcp-client.md` |
| **Generic / other** | The agent (or operator) wires up memory-kernel themselves using the SDK or CLI | — |

This skill runs on the **host machine** via Claude Code, not inside a container. It needs host-level access to install software, write config files, and (for NanoClaw) update databases and cron.

**Principle:** when something is broken or missing, fix it. Don't tell the user to go fix it themselves. Ask permission via `AskUserQuestion` for anything that touches their config or installs software, then do the work.

---

## Step 0: Preflight

Universal regardless of host:

```bash
node --version    # need >= 20.0.0
git --version
```

NanoClaw and OpenClaw also need:

```bash
sqlite3 --version # NanoClaw stores config in SQLite
docker --version  # NanoClaw container runtime; OpenClaw may use it depending on distribution
```

GitHub backup of the memory directory is optional:

```bash
gh auth status    # only needed if user wants GitHub backup
```

If anything's missing, install before proceeding (`brew install`, `apt install`, or distribution-appropriate). Don't proceed without `node ≥ 20`.

---

## Step 1: Detect / select the host

Auto-detect first; ask only if ambiguous.

```bash
HOST_HINTS=()

# NanoClaw
[ -d /workspace/group ] && [ -f /.dockerenv ] && HOST_HINTS+=("nanoclaw")  # inside the container
[ -f ~/.config/nanoclaw/mount-allowlist.json ] && HOST_HINTS+=("nanoclaw")
pgrep -f nanoclaw >/dev/null 2>&1 && HOST_HINTS+=("nanoclaw")

# OpenClaw — package.json deps or dedicated config dir
[ -f ./package.json ] && grep -q "openclaw-memory-kernel" ./package.json 2>/dev/null && HOST_HINTS+=("openclaw")
[ -d ~/openclaw ] || [ -d ~/.config/openclaw ] && HOST_HINTS+=("openclaw")

# MCP clients — Claude Desktop config in canonical locations
[ -f "$HOME/Library/Application Support/Claude/claude_desktop_config.json" ] && HOST_HINTS+=("mcp-client")
[ -f "$HOME/.config/Claude/claude_desktop_config.json" ] && HOST_HINTS+=("mcp-client")

echo "Detected: ${HOST_HINTS[*]:-none}"
```

Then run `AskUserQuestion`:

> *"Which host will use this memory?"*
>
> - **NanoClaw container agent** *(memory rendered into `CLAUDE.md`)*
> - **OpenClaw agent** *(loads the `openclaw-memory-kernel` plugin)*
> - **MCP client** *(Claude Desktop, Cursor, Continue — runs `mk-mcp` over stdio)*
> - **Other / generic** *(I just want the memory store; I'll wire up consumption myself)*

If exactly one host was auto-detected, propose it as the default (recommended) option and let the user confirm or override. Store the answer as `{HOST}` for use in subsequent steps.

---

## Step 2: Configuration

Use `AskUserQuestion` for these. Some questions only apply to certain hosts.

**Q1: Memory directory** *(all hosts)*
"Where should the memory data be stored?"
- `~/mk-memory` *(recommended — simple, top-level)*
- `~/repos/memory/kernel`
- Custom path

Store as `{MEMORY_DIR}` (expand to absolute path; do not keep `~`).

**Q2: Agent name** *(all hosts)*
"What is the agent's name? Used in commits, cron IDs, and as the seed for the identity atom."
- Free text; alphanumeric + dashes/underscores only (memory-kernel constraint).

**Q3: Version control** *(all hosts)*
"Back up the memory directory to GitHub?"
- **Yes** *(recommended)* — `git init` + private GitHub repo
- **No** — local only

If yes, also ask **Q3a:** GitHub username.

**Q4: Identity description** *(all hosts)*
"Describe this agent in 1–2 sentences. This becomes the identity atom seeded in Step 6."
- Free text.

**Q5: Host-specific config** — load the appropriate reference file:

| `{HOST}` | What to read |
|----------|--------------|
| `nanoclaw` | `references/nanoclaw.md` Step N1 (locate NanoClaw, ask for `{NANOCLAW_DIR}`) |
| `openclaw` | `references/openclaw.md` Step O1–O2 (plugin install + isolation mode) |
| `mcp-client` | `references/mcp-client.md` Step M1 (locate the client config file) |
| `other` | Skip — universal flow only |

---

## Step 3: Install memory-kernel CLI

Universal:

```bash
npm install -g memory-kernel
npx mk --version  # verify
```

If install fails with `EACCES`, fix npm prefix:

```bash
mkdir -p ~/.npm-global && npm config set prefix '~/.npm-global'
export PATH=~/.npm-global/bin:$PATH   # add to user's shell profile too
npm install -g memory-kernel
```

---

## Step 4: Initialise memory directory

Universal:

```bash
mkdir -p {MEMORY_DIR}
cd {MEMORY_DIR}
npx mk init .
```

This creates `ENTITIES/`, `CONFLICTS/`, `ARCHIVE/`, `EVIDENCE/`, `EPISODES/`, `events.ndjson`, and `.memory-index.db`. Verify:

```bash
ls -la {MEMORY_DIR}
```

If anything's missing, `mkdir -p` the missing subdirectories. The init is idempotent — running it again on an existing store is safe.

---

## Step 5: Optional — Git init + GitHub backup

**Skip entirely if the user said "No" to version control in Step 2.**

```bash
cd {MEMORY_DIR}
git init
git add -A
git commit -m "Initial memory-kernel setup"
gh repo create {GITHUB_USER}/memory --private --source=. --remote=origin --push
```

If `gh repo create` fails with "remote origin already exists":

```bash
git remote set-url origin https://github.com/{GITHUB_USER}/memory.git
git push -u origin main
```

If the repo already exists on GitHub:

```bash
git remote add origin https://github.com/{GITHUB_USER}/memory.git
git push -u origin main
```

---

## Step 6: Host-specific plumbing

Now the host actually needs different things. Read the appropriate reference file and follow its steps.

| `{HOST}` | Reference | What it covers |
|----------|-----------|----------------|
| `nanoclaw` | [`references/nanoclaw.md`](references/nanoclaw.md) | Mount allowlist, container_config in NanoClaw DB, conversation/impulse symlinks, render-path resolution, restart |
| `openclaw` | [`references/openclaw.md`](references/openclaw.md) | Plugin install, isolation config, AGENTS.md / MEMORY.md / compaction-prompt doctrine, plugin verification |
| `mcp-client` | [`references/mcp-client.md`](references/mcp-client.md) | Add `memory-kernel` server entry to `claude_desktop_config.json` (or equivalent), restart client, verify tools appear |
| `other` | — | Skip — the operator is wiring it up themselves; tell them how `mk render` writes to a path or how `mk-mcp` exposes the same operations over stdio |

After Step 6, the host knows where to find memory-kernel and how to consume it. The remaining steps are universal again.

---

## Step 7: Seed initial atoms

### 7a. Identity and preference

```bash
npx mk remember "{IDENTITY_DESCRIPTION}" \
  -d {MEMORY_DIR} -t fact \
  --tags identity agent-setup

npx mk remember "Created by {CREATOR_NAME}. Prefers direct communication, values agent autonomy." \
  -d {MEMORY_DIR} -t preference \
  --tags communication creator
```

Customise the preference body if you know the operator's actual preferences. Add infrastructure facts if useful:

```bash
npx mk remember "Running on {hostname}, {OS}, IP {IP}" \
  -d {MEMORY_DIR} -t fact --tags infrastructure
```

### 7b. Lifecycle atoms (universal — works for every host)

Seed the agent's operating manual as typed memory so the lifecycle is recallable from inside memory-kernel itself rather than living only in `docs/agent-session-loop.md`. Without this step, a freshly-bootstrapped agent has no idea when to run `wander`, the order of `citations` → `relink`, that `lint` exists, or the A2A handoff protocol — it has to be told out of band.

The bundled `seed-atoms/seed-lifecycle.sh` script reads each file in `seed-atoms/lifecycle/` and seeds an atom with a stable `--slug`. Run it with the absolute path of this skill directory:

```bash
# Replace <SKILL_DIR> with the absolute path of the directory containing
# this SKILL.md — the path Claude Code is reading right now.
SKILL_DIR="<SKILL_DIR>"
bash "$SKILL_DIR/seed-atoms/seed-lifecycle.sh" "{MEMORY_DIR}"
```

The script seeds 7 procedure atoms (Session Start, During Session, Session End, Every 5 Sessions, Maintenance Cadence, A2A Handoff, Diagnostics) and 1 constraint atom (Session-Loop Pitfalls). Constraint type carries 1.5× recall weight and reserved token budget, so the hard rules surface even on tight renders.

**Verify:**

```bash
npx mk recall -d "{MEMORY_DIR}" --types procedure,constraint --json | jq '[.atoms[] | select(.tags[]? == "session-loop")] | length'
# Expected: 8 (7 procedures + 1 constraint)
```

These atoms are host-agnostic — the same lifecycle applies whether the agent runs in NanoClaw, OpenClaw, or an MCP client. Re-seed instructions live in [`seed-atoms/lifecycle/README.md`](seed-atoms/lifecycle/README.md).

---

## Step 8: Render or expose memory

How memory reaches the agent depends on the host:

| `{HOST}` | What to do | Resulting surface |
|----------|------------|-------------------|
| `nanoclaw` | `npx mk render "{MEMORY_DIR}" "$CLAUDE_MD"` (CLAUDE_MD resolved in `references/nanoclaw.md` Step N5) | `/workspace/group/CLAUDE.md` inside the container |
| `openclaw` | Nothing to render — the plugin's bootstrap hook injects atoms at session start. Just confirm via `mk_recall` returns atoms. | Plugin tool calls |
| `mcp-client` | Nothing to render — the client launches `mk-mcp` and calls tools. Confirm by asking the agent to recall a seeded atom. | MCP tool calls |
| `other` | If the operator wants a rendered snapshot: `npx mk render "{MEMORY_DIR}" "<path>"`. Otherwise expose `mk-mcp` or use the SDK directly. | Operator's choice |

Verify the render (NanoClaw / generic):

```bash
head -20 "$CLAUDE_MD"
# Should start with:
# # Memory
# > Auto-generated from memory-kernel. X atoms, Y events.
```

Confirm the lifecycle atoms made it in:

```bash
grep -c session-loop "$CLAUDE_MD"
# Expect ≥ 1 (at least the constraint atom should always surface).
```

---

## Step 9: Schedule periodic reflect + render (universal command, host-aware paths)

A nightly cron keeps memory consolidated and (for NanoClaw / generic) keeps the rendered file fresh.

**With git backup** (replace `<CLAUDE_MD>` with the host-appropriate render target, or omit `&& mk render ...` for OpenClaw / MCP-only setups):

```bash
(crontab -l 2>/dev/null; echo "0 23 * * * cd {MEMORY_DIR} && npx mk reflect -d . --agent-id {AGENT_NAME} --session-id nightly-\$(date +\%Y\%m\%d) && npx mk render {MEMORY_DIR} <CLAUDE_MD> && git add -A && git commit -m \"nightly sync \$(date +\%Y-\%m-\%d)\" --allow-empty && git push 2>&1 | logger -t memory-sync") | crontab -
```

**Without git:**

```bash
(crontab -l 2>/dev/null; echo "0 23 * * * cd {MEMORY_DIR} && npx mk reflect -d . --agent-id {AGENT_NAME} --session-id nightly-\$(date +\%Y\%m\%d) && npx mk render {MEMORY_DIR} <CLAUDE_MD> 2>&1 | logger -t memory-sync") | crontab -
```

Verify the line is in place and matches what `/mk-doctor` will look for later:

```bash
crontab -l | grep memory
```

If the cron doesn't run, common causes: the user's PATH doesn't include the global `npx`. Add it explicitly to the cron line:

```bash
0 23 * * * PATH=/usr/local/bin:/usr/bin:$HOME/.nvm/versions/node/v22.*/bin cd {MEMORY_DIR} && ...
```

---

## Step 10: Verify

Universal verification — runs for every host:

```bash
npx mk status -d {MEMORY_DIR}
npx mk doctor -d {MEMORY_DIR}
npx mk lint -d {MEMORY_DIR} --json | jq '.warnings | length'
```

Expected:
- `mk status` reports atom counts by type (≥ 7 procedure, ≥ 1 constraint, ≥ 1 fact, ≥ 1 preference).
- `mk doctor` reports no issues.
- `mk lint` warnings count ≥ 0 (zero is best; small numbers on a fresh store are normal).

For host-specific verification, run the verify step from the appropriate reference file (Step N6 in `nanoclaw.md`, Step O4 in `openclaw.md`, Step M4 in `mcp-client.md`).

If any verification fails, run the `/mk-doctor` skill — it has a triage flow that maps symptoms to remediation steps.

---

## Step 11: Commit and finish

If using git, commit the final state:

```bash
cd {MEMORY_DIR}
git add -A
git commit -m "Memory-kernel setup complete"
git push
```

Then print a host-aware summary. The shape:

```
✅ Memory-Kernel Setup Complete

  Host:         {HOST}
  Agent:        {AGENT_NAME}
  Memory dir:   {MEMORY_DIR}
  GitHub repo:  {GITHUB_USER}/memory (private)  [or "Local only"]
  Cron:         Nightly sync at 23:00
```

Plus host-specific lines:

- **NanoClaw:** mount allowlist path, container_config status, render target path inside the container, "/workspace/extra/memory (read-write)" + "/workspace/group/CLAUDE.md (auto-loaded)".
- **OpenClaw:** plugin loaded confirmation, isolation mode in use, AGENTS.md / MEMORY.md / compaction-prompt status.
- **MCP client:** which client config was edited, the agent ID set in `MCP_AGENT_ID`, "restart your client to pick up the new server".
- **Other:** the absolute path to the memory directory and how to call `mk render` or `mk-mcp` later.

Close the summary with:

> Verify health any time with the `/mk-doctor` skill. The agent's full operating loop is already inside memory as 8 typed atoms (`mk recall --types procedure,constraint`).

---

## Generic troubleshooting

Host-specific troubleshooting lives in each reference file. The items below are universal.

**`npm install -g` fails with `EACCES`:** fix npm prefix as in Step 3.

**`npx mk init -d .` fails:** the correct syntax is `npx mk init .` (positional argument, not a `-d` flag).

**`npx mk retain` "unknown command":** the CLI command is `remember`, not `retain`. (`retain` is the SDK API name; the CLI uses verbs that read like English commands.)

**`npx mk remember` "too many arguments":** memory dir is the `-d` flag, not a positional. `npx mk remember "text" -d {MEMORY_DIR} -t fact`.

**Git push fails:** ensure `gh repo create` was run (Step 5) or that the remote exists: `git remote -v`. If the user is unauthenticated, `gh auth login` first.

**Lifecycle atoms didn't seed:** confirm `seed-lifecycle.sh` is executable (`chmod +x`), confirm `seed-atoms/lifecycle/` exists alongside it, then re-run with `bash` explicitly. Verify with `mk recall --types procedure,constraint --json | jq '[.atoms[] | select(.tags[]? == "session-loop")] | length'` — expect 8.

**`/mk-doctor` reports lifecycle missing on a previously-set-up agent:** that agent was bootstrapped before the lifecycle-seed step existed. Run `bash "$SKILL_DIR/seed-atoms/seed-lifecycle.sh" "{MEMORY_DIR}"` to seed them now.
