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

## How to run

```bash
npm test
```

**Total: 551 tests across 21 files** (as of v1.0.0). See `CODING_INSTRUCTIONS.md` for the full test file inventory and what each file covers.

## Notes

* The OpenClaw plugin (`packages/openclaw-memory-kernel`) is intentionally not imported by root tests.
  That subpackage has its own dependencies. The harness tests let us validate tool semantics without
  coupling root CI to the plugin dependency graph.
