# OpenClaw Host Integration

Host-specific setup for **OpenClaw**, where memory-kernel is consumed via the native plugin (`openclaw-memory-kernel`) and the host's *doctrine* (AGENTS.md, MEMORY.md, compaction prompt) tells the agent to route durable knowledge through `mk_remember` first.

This file is loaded by `SKILL.md` only when the host is detected (or selected) as OpenClaw. Universal steps (install CLI, init store, seed atoms, schedule reflect) live in `SKILL.md`; this file covers only the OpenClaw-specific work.

> **Status:** scaffold. The full content (plugin install steps, doctrine templates, compaction-prompt routing) lands in a follow-up commit. Until then, this file points at the canonical specs already in `docs/`.

---

## What OpenClaw needs

Three layers, in order:

1. **The plugin.** `packages/openclaw-memory-kernel` exposes 5 MCP-style tools (`mk_remember`, `mk_recall`, `mk_reflect`, `mk_get_context_bundle`, plus optional `mk_share_atom`/`mk_unshare_atom` in isolated mode) and 3 hooks (bootstrap on session start, pre-compaction checkpoint, session cleanup). When loaded, OpenClaw can call memory-kernel directly without an MCP server process.

2. **Isolation config.** Five knobs control how OpenClaw routes per-agent memory:
   - `isolationMode` — `auto` | `shared-only` | `per-agent-required`
   - `autoInitAgentStore` — auto-create `agents/<id>/` on first use
   - `sharedRecall` — union recall pulls in `shared/` atoms alongside agent-private ones
   - `failIfMissingAgentStore` *(deprecated)* — kept for backwards compat; throwing is now the default
   - `allowSharedFallback` — opt-in to silently fall back to shared mode when an agent store is missing (off by default; missing stores throw)

3. **The doctrine.** Three templates from [`docs/host-integration-doctrine.md`](../../../../docs/host-integration-doctrine.md) tell OpenClaw to treat memory-kernel as the primary memory layer:
   - **AGENTS.md** — instructs the agent to call `mk_get_context_bundle` at session start.
   - **MEMORY.md** — declares memory-kernel atoms as the source of truth; transcript search is secondary; loose markdown files are tertiary.
   - **Compaction prompt** — the most critical piece. Explicitly routes durable content (facts, decisions, constraints, beliefs) to `mk_remember` *first*, before anything is written to a file.

The plugin alone won't make the agent *use* memory-kernel as primary — that's the doctrine's job. Without the doctrine, agents drift back to writing markdown alongside.

---

## Step O1: Install the plugin

OpenClaw's plugin layout depends on which OpenClaw distribution is in use. Common patterns:

```bash
# As an npm dependency in the host's package.json
npm install openclaw-memory-kernel
```

```bash
# Or, during memory-kernel-dev work, link the local package
cd packages/openclaw-memory-kernel && npm link
cd <openclaw-host-root> && npm link openclaw-memory-kernel
```

Register it in OpenClaw's plugin config (the exact location varies — check the host's plugin loader docs). The registration entry typically supplies the 5 isolation knobs as plugin options.

For full plugin source and the registration contract, see [`packages/openclaw-memory-kernel/src/index.ts`](../../../../packages/openclaw-memory-kernel/src/index.ts).

---

## Step O2: Pick the isolation mode

Run `AskUserQuestion`:

> *"How should memory be isolated?"*
>
> - **`auto`** *(recommended for single-agent or small multi-agent setups)* — uses per-agent isolation when an agent ID is supplied at runtime; falls back to shared otherwise. Backward compatible with stores that started in shared mode.
> - **`per-agent-required`** *(recommended for multi-agent production)* — every tool call must supply an agent ID; missing IDs throw. Strongest separation, hardest to accidentally cross-contaminate.
> - **`shared-only`** — disables per-agent routing. All agents read and write the same store. Use only when you genuinely want a shared brain.

Then write the config (location depends on OpenClaw distribution; consult the host's docs):

```json
{
  "memoryKernel": {
    "isolationMode": "auto",
    "autoInitAgentStore": true,
    "sharedRecall": true,
    "allowSharedFallback": false
  }
}
```

`allowSharedFallback: false` is the safer default — a missing agent store throws rather than silently writing into shared memory. Set to `true` only if you have a deliberate reason to mix.

---

## Step O3: Seed the doctrine (AGENTS.md, MEMORY.md, compaction prompt)

Copy the three templates from [`docs/host-integration-doctrine.md`](../../../../docs/host-integration-doctrine.md) into the OpenClaw host:

- `AGENTS.md` → tells agents to call `mk_get_context_bundle` at session start.
- `MEMORY.md` → declares memory-kernel atoms as the source of truth.
- Compaction prompt → routes durable content to `mk_remember` first.

The template phrasing in `host-integration-doctrine.md` is canonical and battle-tested — use it verbatim before customising. The compaction prompt is the most consequential of the three: even if AGENTS.md and MEMORY.md drift, a correct compaction prompt keeps the host writing durable content into atoms instead of files.

> **Status:** in a follow-up commit, this section will inline the templates so the skill seeds them automatically rather than asking the user to copy-paste.

---

## Step O4: Verify the plugin loaded and the doctrine is active

```bash
# Plugin loaded — check OpenClaw's plugin list (command varies by host)
# Look for "openclaw-memory-kernel" in the loaded plugins.

# Tools callable — call mk_recall via whatever invocation the host exposes:
# expect a structured response with an `atoms` array.

# Doctrine active — open a fresh session and confirm the agent
# calls mk_get_context_bundle at session start. If it doesn't,
# AGENTS.md is wrong or unread; recheck the path.
```

If the plugin reports `EffectiveMemoryContext` errors at session start, the bootstrap hook didn't get an `agentIdentity.id`. Check the OpenClaw session-init pipeline supplies it.

---

## Step O5: Cron (universal — same as `SKILL.md` Step 10)

OpenClaw's plugin doesn't render CLAUDE.md the way NanoClaw does — atoms are injected at session start via the bootstrap hook, not loaded from a file. So the cron line typically *omits* the `mk render` step and runs only `mk reflect` + `mk gc`:

```bash
0 23 * * * cd <MEMORY_DIR> && npx mk reflect -d . --agent-id <agent-id> --session-id nightly-$(date +\%Y\%m\%d) && npx mk gc -d . 2>&1 | logger -t memory-sync
```

If you also want a rendered file for human inspection, append `&& npx mk render <MEMORY_DIR> <some-path>/snapshot.md`.

---

## Reference docs

- [`packages/openclaw-memory-kernel/src/index.ts`](../../../../packages/openclaw-memory-kernel/src/index.ts) — plugin source and registration contract
- [`docs/openclaw-mcp.md`](../../../../docs/openclaw-mcp.md) — using memory-kernel via the MCP server with OpenClaw
- [`docs/host-integration-doctrine.md`](../../../../docs/host-integration-doctrine.md) — canonical AGENTS.md / MEMORY.md / compaction templates
- [`docs/isolation.md`](../../../../docs/isolation.md) — full per-agent isolation guide

---

## OpenClaw-specific troubleshooting

**Plugin loads but tools aren't callable** — check OpenClaw's plugin error log; the most common cause is a missing `MEMORY_DIR` or a path the plugin can't write to.

**`mk_remember` works but the agent keeps writing to markdown files instead** — the compaction prompt isn't routing durable content to memory-kernel first. Re-read the compaction prompt section in `docs/host-integration-doctrine.md` and update the host's prompt verbatim.

**Recall returns nothing for an agent that's been writing atoms** — isolation mode mismatch. The atoms went into agent `A`'s store but the recall is being made under agent `B` (or under no agent ID, in `per-agent-required` mode). Check `MK_ISOLATION` env and the per-call agent ID.

**`failIfMissingAgentStore` warning** — that knob is deprecated. Switch to `allowSharedFallback: true` for the old silent fallback behaviour, or leave it false (recommended) so missing stores throw.
