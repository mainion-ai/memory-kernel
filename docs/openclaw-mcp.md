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
| `mk_remember` | `createAtom()` | Store a typed atom (fact / decision / constraint / belief / open_question) |
| `mk_recall` | `recall()` | Retrieve atoms — FTS5-ranked when `task` is set, typed-filtered when `types` is set |
| `mk_reflect` | `reflect()` | Expire TTL'd atoms, dedup, auto-promote beliefs, detect conflicts, regenerate views |
| `mk_gc` | `reflect()` | Alias for reflect (GC framing) |
| `mk_merge` | `mergeEventLogs()` | Union-merge a remote memory directory with conflict detection |
| `mk_list_conflicts` | `listAtoms()` | List active conflict atoms |
| `mk_resolve_conflict` | `resolveConflict()` | Mark a conflict atom resolved |
| `mk_get_context_bundle` | `checkpoint()` | Pre-assembled Markdown context (reflect + recall in one call) |

> **MCP vs. plugin tool coverage:** The MCP server exposes all 8 tools above. The native OpenClaw plugin (`packages/openclaw-memory-kernel`) exposes only the 4 core tools (`mk_remember`, `mk_recall`, `mk_reflect`, `mk_context_bundle`) — the 4 maintenance tools (`mk_merge`, `mk_gc`, `mk_list_conflicts`, `mk_resolve_conflict`) are available via the MCP server path if you need them.

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
Use mk_remember to store this decision: we use TypeScript for all new modules. confidence 0.95.
```

Then:

```
Use mk_recall with task "TypeScript modules" and show me what comes back.
```

You should see a typed `decision` atom returned with FTS5-ranked results.

---

## Notes

- memory-kernel runs as a **separate process** (standard for MCP). It does not replace OpenClaw's built-in `memory_search` / `memory_get` — both run alongside each other.
- For the integrated plugin experience (no separate process, SKILL.md routing), see [`packages/openclaw-memory-kernel/`](../packages/openclaw-memory-kernel/).
