# memory-kernel test environment

This repository already contains a broad set of unit/integration/system tests under `test/`.

This directory also includes:

1. **OpenClaw-like harness tests** (`test/openclaw/**`)
   - Simulates the `mk_*` tool workflow without importing the OpenClaw plugin package.
   - Purpose: reproduce agent-facing issues deterministically (e.g., "mk_recall returned nothing").

2. **Parity tests** (`test/recall/**`)
   - Validates that recall behavior is consistent across optional backends:
     - file scan fallback
     - SQLite/FTS indexed retrieval

3. **API contract tests** (`test/api/**`)
   - Protects public exports required by downstream integrations.

## Test layers (taxonomy)

Tests fall into four layers — useful when deciding where new coverage belongs and
when reading the coverage report (#390/#391):

| Layer | What it is | Examples | v8 coverage? |
|---|---|---|---|
| **Unit** | Pure functions against literal inputs, no store/IO | `scoring-modules`, `recall-should-use-reservations`, `budget` | ✅ in-process |
| **Engine-integration** | Engine APIs against a temp store (`initMemoryDir` + `createAtom`/`reflect`/`recall`/`reindex`) | `comprehensive`, `index-db`, `triples-sidecar`, `recall-*` | ✅ in-process |
| **CLI-subprocess-e2e** | Spawn the real `node dist/cli/mk.js` and assert stdout/exit-code | `cli-json`, `cli-doctor-e2e`, `cli-extract-errors`, `export-obsidian-cli` | ❌ child uninstrumented — **excluded from `test:coverage`** (see below) |
| **MCP-transport-e2e** | Real SDK `Client` ↔ `McpServer` over `InMemoryTransport` (JSON-RPC round-trip) | `mcp-transport-e2e` | ✅ in-process (server side) |

> **Coverage caveat (#390):** `npm run test:coverage` uses `vitest.coverage.config.ts`,
> which **excludes the CLI-subprocess-e2e files** — the child `mk` process isn't
> instrumented, so they contribute zero in-process coverage and would only slow/flake
> the run. As a result `src/cli/**` under-reports (handlers run only in the child).
> Read the figures as engine/in-process coverage, not whole-program.

## How to run

```bash
npm test               # full suite (all layers)
npm run test:coverage  # v8 coverage, report-only (excludes CLI-subprocess-e2e — see above)
```

See `CODING_INSTRUCTIONS.md` for the full test file inventory and what each file covers; `CHANGELOG.md` carries the current test count.

## Notes

* The OpenClaw plugin (`packages/openclaw-memory-kernel`) is intentionally not imported by root tests.
  That subpackage has its own dependencies. The harness tests let us validate tool semantics without
  coupling root CI to the plugin dependency graph.
