---
name: mk-memory-setup
description: Set up memory-kernel — persistent, file-based agent memory — for any host that needs it. Universal core (install CLI, init store, seed identity + lifecycle atoms, schedule reflect) plus host-specific plumbing for NanoClaw container agents (mounts, allowlist, restart), OpenClaw plugin-based agents (plugin install, isolation config, AGENTS.md / MEMORY.md doctrine), or any MCP-capable client (Claude Desktop, Cursor, Continue) that needs an `mk-mcp` server entry. Use when the user asks to "set up memory-kernel", "install mk", "configure agent memory", "add persistent memory to my agent", "wire up memory-kernel for NanoClaw / OpenClaw / Claude Desktop / Cursor", or anything similar where memory-kernel is being introduced to an agent host. Triggers on "mk-memory-setup", "memory-kernel setup", "set up agent memory", "install memory-kernel", "configure mk", "persistent memory across sessions", "add memory to my agent", "memory-kernel for NanoClaw", "memory-kernel for OpenClaw", "memory-kernel MCP server".
---

# Memory-Kernel Setup

Set up persistent, typed memory for an AI agent. The skill runs the **universal core** first (preflight, configure, install, init, seed) for every host, then **branches** into a host-specific track depending on what's consuming the memory.

| Host | What it consumes | Branch | Reference file |
|------|------------------|--------|----------------|
| **NanoClaw** (container agent) | Rendered `CLAUDE.md` loaded at session start | A | [`references/nanoclaw.md`](references/nanoclaw.md) |
| **OpenClaw** (plugin-based agent) | Native `openclaw-memory-kernel` plugin + `AGENTS.md` / `MEMORY.md` doctrine | B | [`references/openclaw.md`](references/openclaw.md) |
| **MCP client** (Claude Desktop, Cursor, Continue) | `mk-mcp` server launched by the client over stdio | C | [`references/mcp-client.md`](references/mcp-client.md) |
| **Generic / other** | Operator wires consumption manually via SDK or CLI | D | — |

This skill runs on the **host machine** via Claude Code, not inside a container. It needs host-level access to install software, write config files, and (for NanoClaw) update databases and cron.

**Principle:** when something is missing or broken, fix it. Don't tell the user to go fix it. Ask permission via `AskUserQuestion` for anything that touches their config or installs software — then do the work.

The skill is structured as:

- **Part 1 — Universal core** (steps 1–6). Same for every host.
- **Part 2 — Pick a host branch** (step 7+). Pick one of A / B / C / D and skip the others.

---

# Part 1 — Universal core

## Step 1: Preflight

Check tools are present at the versions memory-kernel needs:

```bash
node --version    # need >= 22.16
git --version
```

NanoClaw and OpenClaw branches also need:

```bash
sqlite3 --version # NanoClaw stores config in SQLite
docker --version  # NanoClaw container runtime; OpenClaw may use depending on distribution
```

GitHub backup of the memory directory is optional:

```bash
gh auth status
```

If anything's missing, install it before proceeding (`brew install`, `apt install`, distribution-appropriate). Don't proceed without **`node >= 22.16`** — memory-kernel uses APIs that aren't stable on earlier Node and Node 20 reached end-of-life 2026-04-30.

---

## Step 2: Configuration questions

These apply to every host. Use `AskUserQuestion` for all four; record answers as `{MEMORY_DIR}`, `{AGENT_NAME}`, `{IDENTITY_DESCRIPTION}`, and the version-control flag.

### Q1 — Memory directory *(all hosts)*

> *"Where should the memory data live on disk?"*
>
> - **`~/mk-memory`** *(recommended — simple, top-level, easy to back up)*
> - **`~/repos/memory/kernel`** *(under your repos folder if you prefer that layout)*
> - **Custom path**

Expand to an absolute path; do not keep the `~`. The directory will be created in Step 4. Store as `{MEMORY_DIR}`.

### Q2 — Agent name *(all hosts)*

> *"What is the agent's name? Used in commits, cron IDs, and as the seed for the identity atom."*

Free text; alphanumeric + dashes/underscores only (memory-kernel constraint on agent IDs). Store as `{AGENT_NAME}`.

> **Trade-off (agent identity).** Once seeded, atoms reference this name in their `agent_id`. Renaming later is mechanical but requires rewriting frontmatter across the store and re-seeding lifecycle atoms — easier to pick the name you'll keep. If unsure between a personal name and a role name (e.g. `alice` vs `code-reviewer`), prefer the role: roles outlive seats.

### Q3 — Version control *(all hosts)*

> *"Back up the memory directory to GitHub?"*
>
> - **Yes** *(recommended)* — `git init` plus a private GitHub repo, with nightly auto-commit
> - **No** — local only

If yes, also ask **Q3a — GitHub username** (free text). Store as `{GITHUB_USER}`.

### Q4 — Identity description *(all hosts)*

> *"Describe this agent in 1–2 sentences. This becomes the identity atom seeded in Step 6."*

Free text, 1–2 sentences. The seeded atom is `type: fact`, tagged `identity` and `agent-setup`. Store as `{IDENTITY_DESCRIPTION}`.

---

## Step 3: Install the CLI

```bash
npm install -g memory-kernel
npx mk --version  # verify
```

If install fails with `EACCES`, fix the npm prefix (one-line setup, then retry):

```bash
mkdir -p ~/.npm-global && npm config set prefix '~/.npm-global'
export PATH=~/.npm-global/bin:$PATH    # add this to the user's shell profile
npm install -g memory-kernel
```

---

## Step 4: Init the memory directory

```bash
mkdir -p {MEMORY_DIR}
cd {MEMORY_DIR}
npx mk init .
```

`mk init` is idempotent — running it twice on an existing store is safe.

Verify the layout:

```bash
ls -la {MEMORY_DIR}
```

Expected: `ENTITIES/`, `CONFLICTS/`, `ARCHIVE/`, `EVIDENCE/`, `EPISODES/`, `events.ndjson`, and `.memory-index.db`. Create any missing subdirs manually with `mkdir -p` — `mk init` respects existing ones on re-run.

---

## Step 5: Git + GitHub backup *(skip if Q3 was "No")*

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

## Step 6: Seed identity + lifecycle atoms

### 6a — Identity and preference *(universal)*

```bash
npx mk remember "{IDENTITY_DESCRIPTION}" \
  -d {MEMORY_DIR} -t fact \
  --tags identity agent-setup

npx mk remember "Created by {CREATOR_NAME}. Prefers direct communication, values agent autonomy." \
  -d {MEMORY_DIR} -t preference \
  --tags communication creator
```

Customize the preference body if you know the operator's actual preferences. Add infrastructure facts if useful:

```bash
npx mk remember "Running on {hostname}, {OS}, IP {IP}" \
  -d {MEMORY_DIR} -t fact --tags infrastructure
```

### 6b — Lifecycle atoms *(universal — works for every host)*

Seed the agent's *operating manual* as typed memory so the lifecycle is recallable from inside memory-kernel itself rather than living only in `docs/agent-session-loop.md`. Without this step, a freshly-bootstrapped agent has no idea when to run `wander`, the order of `citations` → `relink`, that `lint` exists, or the A2A handoff protocol — it has to be told out of band.

The bundled `seed-atoms/seed-lifecycle.sh` script reads each file in `seed-atoms/lifecycle/` and seeds an atom with a stable slug. Run it with the absolute path of this skill directory:

```bash
# Replace <SKILL_DIR> with the absolute path of the directory containing
# this SKILL.md — the path Claude Code is reading right now.
SKILL_DIR="<SKILL_DIR>"
bash "$SKILL_DIR/seed-atoms/seed-lifecycle.sh" "{MEMORY_DIR}"
```

The script seeds 7 procedure atoms (Session Start, During Session, Session End, Every 5 Sessions, Maintenance Cadence, A2A Handoff, Diagnostics) and 1 constraint atom (Session-Loop Pitfalls). The constraint type carries 1.5× recall weight and reserved token budget, so the hard rules surface even on tight renders.

**Verify:**

```bash
npx mk recall -d "{MEMORY_DIR}" --types procedure,constraint --json \
  | jq '[.atoms[] | select(.tags[]? == "session-loop")] | length'
# Expected: 8 (7 procedures + 1 constraint)
```

Re-seed instructions live in [`seed-atoms/lifecycle/README.md`](seed-atoms/lifecycle/README.md).

---

## Step 6c: Initialize the KNOWLEDGE/ folder

`mk init` (Step 4) already created `KNOWLEDGE/`, `KNOWLEDGE/draft/`, and a
`KNOWLEDGE/README.md` documenting the convention. Confirm and explain it to the
operator:

```bash
ls -la "{MEMORY_DIR}/KNOWLEDGE"   # README.md + draft/
```

**The convention** (also in `KNOWLEDGE/README.md`):

- Drop finished knowledge — design docs, research notes, reports — as `.md`
  files in `KNOWLEDGE/`. They get **observed into atoms**, so conclusions flow
  into recall without a manual `mk remember`.
- **`KNOWLEDGE/draft/` is never observed** — scratch space; move a doc out of
  `draft/` when it's ready.
- Docs are observed with the **document** prompt:
  `mk observe KNOWLEDGE/<doc>.md --mode document -d {MEMORY_DIR}` then
  `mk reflect` to turn observations into atoms.

> The **nightly** KNOWLEDGE scan (mtime manifest in the `mk init --cron`
> memory-sync wrapper) is a follow-up; until it ships, observe docs on demand
> with the command above.

**Seed a standing instruction** so any agent rendered from this store inherits
the convention automatically:

```bash
npx mk remember -d "{MEMORY_DIR}" -t preference --tags knowledge,session-loop \
  "Knowledge convention: drop design docs, research, and reports as Markdown in KNOWLEDGE/ — they are observed into atoms automatically. Use KNOWLEDGE/draft/ for work in progress (never observed). Don't paste finished knowledge into chat expecting it to persist; put it in KNOWLEDGE/."
```

---

# Part 2 — Pick a host branch

The universal core is done. The host determines how the agent actually *consumes* this memory. Auto-detect first, then ask.

```bash
HOST_HINTS=()
[ -d /workspace/group ] && [ -f /.dockerenv ] && HOST_HINTS+=("nanoclaw")
[ -f ~/.config/nanoclaw/mount-allowlist.json ] && HOST_HINTS+=("nanoclaw")
pgrep -f nanoclaw >/dev/null 2>&1 && HOST_HINTS+=("nanoclaw")
[ -f ./package.json ] && grep -q "openclaw-memory-kernel" ./package.json && HOST_HINTS+=("openclaw")
{ [ -d ~/openclaw ] || [ -d ~/.config/openclaw ]; } && HOST_HINTS+=("openclaw")
[ -f "$HOME/Library/Application Support/Claude/claude_desktop_config.json" ] && HOST_HINTS+=("mcp-client")
[ -f "$HOME/.config/Claude/claude_desktop_config.json" ] && HOST_HINTS+=("mcp-client")
echo "Detected: ${HOST_HINTS[*]:-none}"
```

Then run `AskUserQuestion`:

> **Which host will use this memory?**
>
> - **NanoClaw container agent** *(memory rendered into `CLAUDE.md`)* → **Branch A**
> - **OpenClaw agent** *(loads the `openclaw-memory-kernel` plugin)* → **Branch B**
> - **MCP client** *(Claude Desktop, Cursor, Continue — runs `mk-mcp` over stdio)* → **Branch C**
> - **Other / generic** *(I just want the memory store; I'll wire up consumption myself)* → **Branch D**

If exactly one host was auto-detected, propose it as the recommended option in the question. Store the answer as `{HOST}` and jump to the matching branch. Skip the other three.

---

## Branch A — NanoClaw

NanoClaw consumes memory through a rendered `CLAUDE.md` that the container loads at session start. The steps below wire memory-kernel into NanoClaw's mount allowlist, the `container_config` row in the NanoClaw DB, and conversation/impulse symlinks. Most of the per-host plumbing lives in [`references/nanoclaw.md`](references/nanoclaw.md).

### A1 — Locate NanoClaw

```bash
ls -d ~/nanoclaw ~/repos/nanoclaw 2>/dev/null
```

If neither exists, ask:

> *"Where is your NanoClaw installation?"* — full path. The skill needs to write to the mount allowlist and update the `container_config` DB row.

Store as `{NANOCLAW_DIR}`. Then follow [`references/nanoclaw.md`](references/nanoclaw.md) Steps N1–N5 — mount allowlist, `container_config` DB row, conversation/impulse symlinks, render-path resolution.

### A2 — Render `CLAUDE.md`

```bash
npx mk render "{MEMORY_DIR}" "$CLAUDE_MD"
# CLAUDE_MD path resolved in references/nanoclaw.md Step N5
```

**Verify:**

```bash
head -20 "$CLAUDE_MD"
# Expected first lines:
# # Memory
# > Auto-generated from memory-kernel. X atoms, Y events.

grep -c session-loop "$CLAUDE_MD"
# Expect >= 1 — the constraint atom should always surface.
```

### A3 — Schedule nightly reflect + render + git push

**With git backup:**

```bash
(crontab -l 2>/dev/null; echo "0 23 * * * cd {MEMORY_DIR} && npx mk reflect -d . --agent-id {AGENT_NAME} --session-id nightly-\$(date +\%Y\%m\%d) && npx mk render {MEMORY_DIR} <CLAUDE_MD_PATH> && git add -A && git commit -m \"nightly sync \$(date +\%Y-\%m-\%d)\" --allow-empty && git push 2>&1 | logger -t memory-sync") | crontab -
```

**Without git** — drop the `git ...` chain. If the cron doesn't run, the most common cause is a missing PATH in the cron environment. Add it explicitly:

```bash
0 23 * * * PATH=/usr/local/bin:/usr/bin:$HOME/.nvm/versions/node/v22.*/bin cd {MEMORY_DIR} && ...
```

### A4 — Verify

```bash
npx mk status -d {MEMORY_DIR}
npx mk doctor -d {MEMORY_DIR}
crontab -l | grep memory
```

Plus the NanoClaw-specific verification in [`references/nanoclaw.md`](references/nanoclaw.md) Step N6 — mount allowlist check, `container_config` row check, conversation/impulse symlinks, restart confirmation.

### A5 — Finish

```
✅ Memory-Kernel Setup Complete (NanoClaw)

  Agent:        {AGENT_NAME}
  Memory dir:   {MEMORY_DIR}
  GitHub repo:  {GITHUB_USER}/memory (private)  [or "Local only"]
  Mounts:       /workspace/extra/memory (rw), /workspace/group/CLAUDE.md (auto-loaded)
  Cron:         Nightly at 23:00 — reflect → render → push
```

> Health-check any time with `/mk-doctor`. The agent's full operating loop is already inside memory as 8 typed atoms: `mk recall --types procedure,constraint`.

---

## Branch B — OpenClaw

OpenClaw consumes memory through a native plugin — no rendering, no `CLAUDE.md`. The plugin's bootstrap hook injects atoms at session start. Setup focuses on plugin install, isolation mode, and the AGENTS.md / MEMORY.md / compaction-prompt doctrine. Most of the per-host plumbing lives in [`references/openclaw.md`](references/openclaw.md).

### B1 — Locate OpenClaw

```bash
ls -d ~/openclaw ~/repos/openclaw 2>/dev/null
```

Ask if not auto-detected. Store as `{OPENCLAW_DIR}`. Then follow [`references/openclaw.md`](references/openclaw.md) for the full flow.

### B2 — Choose isolation mode

`AskUserQuestion`:

> **How should this agent's memory be isolated?**
>
> - **Shared** *(default — single store, all agents see all atoms)*
> - **Per-agent** *(each agent gets its own private store with a shared corkboard for explicit cross-agent atoms)*

> **Trade-off (isolation mode).** Shared mode is the simpler default — one store, no routing logic, all atoms recallable. Per-agent mode prevents two agents from silently overwriting each other's beliefs and lets each agent develop its own understanding, but requires a stable `agent_id` for every caller and adds a `shared/` directory for explicit cross-agent atoms. Pick **per-agent** if you'll have two or more distinct agents sharing the directory; pick **shared** if it's just one agent (or you're not sure yet — migration to per-agent later is supported via `mk migrate`).

If per-agent: ask for the `agent_id` to pin (free text, alphanumeric + dashes/underscores). Store as `{OPENCLAW_AGENT_ID}`.

### B3 — Plugin install + isolation config

Follow [`references/openclaw.md`](references/openclaw.md) Steps O1–O2 verbatim. The skill writes the appropriate plugin config block based on B2's answer.

### B4 — Doctrine (AGENTS.md / MEMORY.md / compaction prompt)

Follow [`references/openclaw.md`](references/openclaw.md) Step O3 — the doctrine files steer the host's `AGENTS.md`, `MEMORY.md`, and compaction prompts so the agent uses memory consistently.

### B5 — Schedule nightly reflect *(no render needed)*

```bash
(crontab -l 2>/dev/null; echo "0 23 * * * cd {MEMORY_DIR} && npx mk reflect -d . --agent-id {AGENT_NAME} --session-id nightly-\$(date +\%Y\%m\%d) && git add -A && git commit -m \"nightly sync \$(date +\%Y-\%m-\%d)\" --allow-empty && git push 2>&1 | logger -t memory-sync") | crontab -
```

Drop the `git ...` chain if no GitHub backup.

### B6 — Verify

```bash
npx mk status -d {MEMORY_DIR}
npx mk doctor -d {MEMORY_DIR}
```

Plus the OpenClaw-specific verification in [`references/openclaw.md`](references/openclaw.md) Step O4 — plugin loaded confirmation, bootstrap hook called, `mk_recall` returns atoms.

### B7 — Finish

```
✅ Memory-Kernel Setup Complete (OpenClaw)

  Agent:        {AGENT_NAME}
  Memory dir:   {MEMORY_DIR}
  GitHub repo:  {GITHUB_USER}/memory (private)  [or "Local only"]
  Plugin:       openclaw-memory-kernel loaded
  Isolation:    {shared | per-agent — id: {OPENCLAW_AGENT_ID}}
  Cron:         Nightly at 23:00 — reflect → push
```

> Health-check any time with `/mk-doctor`. AGENTS.md / MEMORY.md / compaction-prompt doctrine wired.

---

## Branch C — MCP client (Claude Desktop, Cursor, Continue)

The client launches `mk-mcp` as an MCP server over stdio. Setup is one config-file edit plus a client restart.

### C1 — Locate the client config

Common paths:

- macOS Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Linux Claude Desktop: `~/.config/Claude/claude_desktop_config.json`
- Cursor / Continue: client-specific — see [`references/mcp-client.md`](references/mcp-client.md) Step M1

Store the resolved path as `{CLIENT_CONFIG}`.

### C2 — Choose embedding provider

`AskUserQuestion`:

> **Enable semantic search via embeddings?** Embeddings let recall match by *meaning*, not just keywords. Costs an API call per atom (re-embed on each change) and an API key.
>
> - **No embeddings — FTS only** *(recommended for getting started — works fully without any API key)*
> - **Voyage** *(`voyage-3-lite`, 512-dim — lower cost, smaller index. Needs `EMBEDDING_API_KEY`.)*
> - **OpenAI** *(`text-embedding-3-small`, 1536-dim — higher cost, larger index, broader vocabulary. Needs `EMBEDDING_API_KEY`.)*

> **Trade-off (embedding provider).** FTS-only works perfectly for keyword-rich queries and stores under ~500 atoms — most agents never need more. Embeddings start to pay off when atoms grow longer and prose-heavier, or when the agent asks queries that paraphrase rather than echo the stored text. Add later by setting `EMBEDDING_PROVIDER` + key and running `mk reindex --embed`; no need to decide now.

Record the answer as `{EMBEDDING_BLOCK}` (a JSON snippet to inject into the client config's `env`, or empty if FTS-only).

### C3 — Edit the client config

Add a `memory-kernel` server entry. Skeleton:

```json
{
  "mcpServers": {
    "memory-kernel": {
      "command": "npx",
      "args": ["-y", "memory-kernel", "mcp"],
      "env": {
        "MEMORY_DIR": "{MEMORY_DIR}",
        "MCP_AGENT_ID": "{AGENT_NAME}"
      }
    }
  }
}
```

If C2 picked an embedding provider, merge `EMBEDDING_PROVIDER` and `EMBEDDING_API_KEY` into the `env` block. The JSON-merge logic and per-client config-path table live in [`references/mcp-client.md`](references/mcp-client.md) Step M2.

### C4 — Restart the client

Tell the user explicitly: *"Restart Claude Desktop / Cursor / Continue now. The new server doesn't load until restart."*

### C5 — Verify

After restart, prompt the agent to recall a seeded atom (the identity atom is a good probe):

```
Agent prompt: "What do you know about yourself?"
Expected: cites the identity atom seeded in Step 6.
```

Plus the MCP-specific verification in [`references/mcp-client.md`](references/mcp-client.md) Step M4.

### C6 — Finish

```
✅ Memory-Kernel Setup Complete (MCP client)

  Agent:        {AGENT_NAME}
  Memory dir:   {MEMORY_DIR}
  GitHub repo:  {GITHUB_USER}/memory (private)  [or "Local only"]
  Client config: {CLIENT_CONFIG}
  Embeddings:   {none | voyage | openai}
  Agent ID:     {AGENT_NAME}  (via MCP_AGENT_ID)
```

> Restart your client to pick up the new server. Health-check any time with `/mk-doctor`.

---

## Branch D — Generic / other

The agent (or operator) wires up consumption manually — no host-specific config edit, no plugin install, no client restart. Two paths from here:

### D1 — `mk render` to a path

If the agent reads a single markdown file at session start, render to that path on a cron:

```bash
npx mk render "{MEMORY_DIR}" "/path/to/agent-context.md"
```

Schedule it nightly the same way Branch A does, but render to your chosen path instead of the NanoClaw `CLAUDE_MD` location. The render output is identical.

### D2 — `mk-mcp` over stdio

If the agent speaks MCP, launch the server directly:

```bash
MEMORY_DIR={MEMORY_DIR} MCP_AGENT_ID={AGENT_NAME} npx mk mcp
```

Connect your agent's MCP client to this stdio. The tool surface is identical to Branch C.

### D3 — Verify

```bash
npx mk status -d {MEMORY_DIR}
npx mk doctor -d {MEMORY_DIR}
```

### D4 — Finish

```
✅ Memory-Kernel Setup Complete (Generic)

  Agent:        {AGENT_NAME}
  Memory dir:   {MEMORY_DIR}
  GitHub repo:  {GITHUB_USER}/memory (private)  [or "Local only"]
  Consumption:  manual (mk render to <path> or mk-mcp over stdio)
```

> Health-check any time with `/mk-doctor`. The agent's full operating loop is already inside memory as 8 typed atoms.

---

## Generic troubleshooting

Host-specific troubleshooting lives in each reference file. The items below are universal.

**`npm install -g` fails with `EACCES`:** fix the npm prefix as in Step 3.

**`npx mk init -d .` fails:** the correct syntax is `npx mk init .` (positional argument, not a `-d` flag).

**`npx mk retain` "unknown command":** the CLI command is `remember`, not `retain`. (`retain` is the SDK API name; the CLI uses verbs that read like English commands.)

**`npx mk remember` "too many arguments":** memory dir is the `-d` flag, not a positional. `npx mk remember "text" -d {MEMORY_DIR} -t fact`.

**Git push fails:** ensure `gh repo create` was run (Step 5) or that the remote exists: `git remote -v`. If the user is unauthenticated, `gh auth login` first.

**Lifecycle atoms didn't seed:** confirm `seed-lifecycle.sh` is executable (`chmod +x`), confirm `seed-atoms/lifecycle/` exists alongside it, then re-run with `bash` explicitly. Verify with `mk recall --types procedure,constraint --json | jq '[.atoms[] | select(.tags[]? == "session-loop")] | length'` — expect 8.

**`/mk-doctor` reports lifecycle missing on a previously-set-up agent:** that agent was bootstrapped before the lifecycle-seed step existed. Run `bash "$SKILL_DIR/seed-atoms/seed-lifecycle.sh" "{MEMORY_DIR}"` to seed them now.
