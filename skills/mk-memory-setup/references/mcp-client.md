# MCP-Client Host Integration

Host-specific setup for any **MCP-capable client** — Claude Desktop, Cursor, Continue, Goose, or any other tool that speaks the Model Context Protocol. The client launches a local `mk-mcp` server and consumes memory through MCP tool calls.

This file is loaded by `SKILL.md` only when the host is detected (or selected) as an MCP client. Universal steps (install CLI, init store, seed atoms, schedule reflect) live in `SKILL.md`; this file covers only the wiring.

> **Status:** scaffold. The full content (per-client config templates, isolation routing, multi-agent setup) lands in a follow-up commit. Until then, this file shows the canonical Claude Desktop config and points at `docs/openclaw-mcp.md` for richer integration patterns.

---

## What MCP clients need

A **server entry** in the client's MCP config that:
1. Launches `mk-mcp` (the binary shipped with the `memory-kernel` npm package).
2. Sets `MEMORY_DIR` to the absolute path of the memory directory.
3. Optionally sets `MCP_AGENT_ID` to route all this client's tool calls into a specific per-agent store (e.g., `MCP_AGENT_ID=claude-desktop`).

That's it. No mounts, no plugin install, no doctrine files — the client talks to `mk-mcp` over stdio, and `mk-mcp` handles everything else.

---

## Step M1: Locate the client's MCP config

| Client | Config path |
|--------|-------------|
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Linux) | `~/.config/Claude/claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` (consult Cursor's docs — path may differ by version) |
| Other | Consult the client's MCP docs |

If the file doesn't exist, create it with an empty `mcpServers: {}` and continue.

---

## Step M2: Add the memory-kernel server entry

For Claude Desktop (the most common MCP client today), add this entry inside `mcpServers`:

```json
{
  "mcpServers": {
    "memory-kernel": {
      "command": "node",
      "args": ["/path/to/memory-kernel/dist/mcp/server.js"],
      "env": {
        "MEMORY_DIR": "/absolute/path/to/your/memory",
        "MCP_AGENT_ID": "claude-desktop"
      }
    }
  }
}
```

Or, if you installed memory-kernel globally and `mk-mcp` is on the PATH:

```json
{
  "mcpServers": {
    "memory-kernel": {
      "command": "mk-mcp",
      "env": {
        "MEMORY_DIR": "/absolute/path/to/your/memory"
      }
    }
  }
}
```

`MCP_AGENT_ID` is optional but recommended once you have more than one agent or client sharing a memory directory — it routes every tool call through that agent's store under per-agent isolation. Without it, calls land in the default `mcp-server` agent.

For per-agent isolation in detail, see [`docs/isolation.md`](../../../../docs/isolation.md).

---

## Step M3: Restart the client

Restart Claude Desktop (or Cursor, or whichever client) so it picks up the new config. The server starts automatically the first time the client invokes a tool from the entry.

---

## Step M4: Verify

Inside a fresh client session, ask the agent something like:

> *"What memory tools do you have available?"*

The agent should report tools whose names start with `mk_` — `mk_remember`, `mk_recall`, `mk_reflect`, `mk_get_context_bundle`, etc. Then ask:

> *"Recall what you know about [some seeded topic]."*

If the agent calls `mk_recall` and returns atoms, wiring is good. If the agent says it has no relevant tools, the config didn't take effect — check the client's MCP server logs.

---

## Step M5: Cron (universal — same as `SKILL.md` Step 10)

MCP clients consume memory live via the server, not via a rendered file. So the cron typically only runs `mk reflect` + `mk gc`, not `mk render`:

```bash
0 23 * * * cd <MEMORY_DIR> && npx mk reflect -d . --agent-id <agent-id> --session-id nightly-$(date +\%Y\%m\%d) && npx mk gc -d . 2>&1 | logger -t memory-sync
```

You can still render to a markdown file for human inspection if you want a "what does the agent know right now" snapshot:

```bash
npx mk render <MEMORY_DIR> ~/Documents/agent-memory-snapshot.md
```

---

## Reference docs

- [`docs/openclaw-mcp.md`](../../../../docs/openclaw-mcp.md) — canonical MCP server integration guide; works for any MCP-capable client, not only OpenClaw despite the filename
- [`docs/isolation.md`](../../../../docs/isolation.md) — per-agent isolation, including `MCP_AGENT_ID` routing
- [`docs/sdk-reference.md`](../../../../docs/sdk-reference.md) — full tool list and parameters

---

## MCP-specific troubleshooting

**Tools don't appear in the client** — restart the client. If still missing, check the client's MCP error log (location varies; on Claude Desktop for macOS look in `~/Library/Logs/Claude/`). Most common causes: wrong path to `server.js`, missing `MEMORY_DIR`, `node` not on the client's PATH.

**`Cannot find module` when the server tries to start** — `MEMORY_DIR` points at a directory but `node_modules` for memory-kernel aren't where the `command`/`args` say they are. Either `npm install -g memory-kernel` so `mk-mcp` is on the global PATH and use the `command: "mk-mcp"` form, or supply an absolute path to the package's `dist/mcp/server.js`.

**Recall returns nothing despite atoms existing** — wrong `MEMORY_DIR`, or `MCP_AGENT_ID` is set and the atoms live in a different agent's store. Confirm `MEMORY_DIR` matches where you ran `mk init`, and check `ls "$MEMORY_DIR/agents/"` if you're in isolated mode.

**Two clients fight over memory** — set distinct `MCP_AGENT_ID` values and enable per-agent isolation (see `docs/isolation.md`). Each client gets its own store; explicit `mk_share_atom` calls promote individual atoms into the shared namespace both clients can see.
