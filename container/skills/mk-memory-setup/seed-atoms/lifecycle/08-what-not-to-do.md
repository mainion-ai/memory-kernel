# Session-Loop Pitfalls — Hard Rules

These are non-negotiable. Each is a hard-earned lesson; violating them degrades memory quality in ways that are expensive to undo.

- **Don't skip `mk episode`.** Writing session state as FACT atoms pollutes the store with ephemeral content and inflates recall noise.
- **Don't skip `mk relate`.** A graph with no edges degrades recall and wander quality. The relation step is the most commonly skipped and the most damaging to skip.
- **Don't run `mk gc` without `mk reflect` first.** You'll miss atoms that reflect would have expired.
- **Don't skip `mk compact`.** The event log grows unbounded without it; `mk replay` and `mk merge` slow proportionally.
- **Don't run `mk import` or `mk merge` without `--dry-run` first.** Preview before committing — both are additive, but conflicts can arise.
- **Don't write ephemeral task status as atoms.** *"Currently debugging X"* is stale by next session. Atoms persist; write only what is worth carrying forward.
- **Don't run `mk relink --apply` before `mk citations`.** Citations builds the concept index that wander reads from; relink writes graph edges. Skip the order and wander activation is stale.
