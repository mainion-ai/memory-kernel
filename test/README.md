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

**Total: 1587 tests across 106 files** (as of unreleased, 2026-05-24 — adds `doctor-fix-orchestrator.test.ts`, `doctor-fix-checks.test.ts`, and 7 new cases in `cli-doctor-e2e.test.ts` for `mk doctor --fix`/`--dry-run`). See `CODING_INSTRUCTIONS.md` for the full test file inventory and what each file covers.

## Notes

* The OpenClaw plugin (`packages/openclaw-memory-kernel`) is intentionally not imported by root tests.
  That subpackage has its own dependencies. The harness tests let us validate tool semantics without
  coupling root CI to the plugin dependency graph.
