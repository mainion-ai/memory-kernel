<!--
Thanks for opening a PR. Fill in the sections below; delete any that
don't apply rather than leaving them empty.

For non-trivial changes, please also author a per-PR plan at
`docs/superpowers/plans/<date>-<slug>.md` describing scope, tests,
and risk — see existing exemplars under `docs/superpowers/plans/archive/`.
-->

## Summary

<!-- One or two sentences on what changed and why. -->

## Changes

<!--
Bullet list of the user-visible changes. For internal refactors with
no API surface change, say so explicitly.
-->

-

## Test plan

- [ ] `npm test` passes locally — full suite, no skips. Update any documentation that quotes a test count to match (see the "Version numbers and test counts" rule in [`CODING_INSTRUCTIONS.md`](../CODING_INSTRUCTIONS.md))
- [ ] `npm run build` produces no TypeScript errors
- [ ] If this PR adds or changes a CLI command / SDK export / config field, the README + relevant `docs/*.md` are updated in the same commit
- [ ] `CHANGELOG.md` updated under `[Unreleased]` or the next version section if the change is user-visible
- [ ] All other `.md` files affected by your change are updated in the same PR — see the "Documentation hygiene" section in [`CODING_INSTRUCTIONS.md`](../CODING_INSTRUCTIONS.md) for the canonical table

## Version bump

<!--
Per CLAUDE.md > Versioning, propose a version bump for non-docs changes
and wait for maintainer approval BEFORE touching version fields.
-->

- [ ] Not applicable (docs-only / internal-only)
- [ ] PATCH proposed — bug fix or transitive security fix, no public API change
- [ ] MINOR proposed — new public API (CLI flag, exported field/function, new command)
- [ ] MAJOR proposed — breaking change

## Related

<!-- Issues this closes or references; links to upstream discussion. -->

- Closes #
