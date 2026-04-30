# Fixture vault — small-vault

Twenty hand-generated atoms (every type × every status × every classification) plus one episode. Used by:

- `test/fixtures-smoke.test.ts` — round-trip every atom through `parseAtomFile`.
- The manual smoke checklist in `docs/superpowers/plans/2026-04-30-obsidian-mk-graph-phase2-plugin-scaffold.md` (Task 14).
- Future phases (Phase 3 / Phase 4) extend this vault with `events.ndjson` and wander seeds.

## Regenerate

```bash
node test/fixtures/generate-small-vault.mjs
```

The generator is deterministic — re-running produces an identical set of files.
