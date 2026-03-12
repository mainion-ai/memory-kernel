# Using memory-kernel with OpenClaw (MCP)

memory-kernel ships an MCP server (`mk-mcp`) that exposes 8 tools and 4 resources over stdio. If you have OpenClaw with MCP support, this is the fastest way to get structured, typed memory alongside your existing session.

**No code changes required to either project.**

---

## Prerequisites

```bash
npm install -g memory-kernel   # installs mk and mk-mcp binaries
```

Create a memory directory and initialise it:

```bash
mkdir -p ~/.openclaw/mk-memory
mk init ~/.openclaw/mk-memory
```

---

## OpenClaw MCP config

Add to your OpenClaw MCP configuration (exact location depends on your OpenClaw version — typically `~/.openclaw/openclaw.json` under `mcp.servers`):

```json
{
  "mcp": {
    "servers": {
      "memory-kernel": {
        "command": "mk-mcp",
        "env": {
          "MEMORY_DIR": "/Users/YOU/.openclaw/mk-memory"
        }
      }
    }
  }
}
```

Optional env vars:

| Variable | Default | Purpose |
|---|---|---|
| `MEMORY_DIR` | *required* | Path to your memory directory |
| `MCP_AGENT_ID` | `"mcp-server"` | Agent label in the audit trail |
| `MCP_SESSION_ID` | auto | Session label in the audit trail |
| `MEMORY_ENCRYPTION_KEY` | — | 64-char hex key for SECRET atom encryption |

---

## Tools exposed

| Tool | Maps to | Description |
|---|---|---|
| `remember` | `createAtom()` | Store a typed atom (fact / decision / constraint / belief / open_question) |
| `recall` | `recall()` | Retrieve atoms — FTS5-ranked when `task` is set, typed-filtered when `types` is set |
| `reflect` | `reflect()` | Expire TTL'd atoms, dedup, auto-promote beliefs, detect conflicts, regenerate views |
| `gc` | `reflect()` | Alias for reflect (GC framing) |
| `merge` | `mergeEventLogs()` | Union-merge a remote memory directory with conflict detection |
| `list_conflicts` | `listAtoms()` | List active conflict atoms |
| `resolve_conflict` | `resolveConflict()` | Mark a conflict atom resolved |
| `get_context_bundle` | `checkpoint()` | Pre-assembled Markdown context (reflect + recall in one call) |

## Resources exposed

| URI | Contents |
|---|---|
| `memory://decisions` | All accepted and draft decisions |
| `memory://constraints` | Active constraints and rules |
| `memory://handoff` | Current working state and priority atoms |
| `memory://open-questions` | Unresolved open questions |

---

## Quick smoke test

After restarting OpenClaw, ask your agent:

```
Use the remember tool to store this decision: we use TypeScript for all new modules. confidence 0.95.
```

Then:

```
Use recall with task "TypeScript modules" and show me what comes back.
```

You should see a typed `decision` atom returned with FTS5-ranked results.

---

## Notes

- memory-kernel runs as a **separate process** (standard for MCP). It does not replace OpenClaw's built-in `memory_search` / `memory_get` — both run alongside each other.
- The `remember` tool name may conflict with built-in OpenClaw tools depending on your version. If so, use `get_context_bundle` or `recall` as the primary entry points, and rename the server key to distinguish it.
- For the integrated plugin experience (no separate process, tool names prefixed `mk_*`, SKILL.md routing), see [`openclaw-memory-kernel`](https://github.com/mainion-ai/openclaw-memory-kernel) *(coming soon)*.
