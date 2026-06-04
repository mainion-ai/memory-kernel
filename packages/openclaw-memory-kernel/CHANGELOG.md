# Changelog — openclaw-memory-kernel

This package tracks its own SemVer lifecycle, independent of the main
`memory-kernel` package. See [`../../RELEASING.md` → Subpackage releases](../../RELEASING.md#subpackage-releases)
for the tag scheme, peer-dep discipline rule, and deprecation policy.

> **Pre-1.0 publish status.** The subpackage is not yet on npm — versions
> below ship in-tree only, alongside the main `memory-kernel` repo. The
> first npm publish is tracked in
> [#152](https://github.com/mainion-ai/memory-kernel-dev/issues/152).
> Entries below were extracted from the main-package CHANGELOG so consumers
> have a single chronology to read once publish lands.

## [Unreleased]

No subpackage-affecting changes since 0.3.0. The main-package v1.25.x and
v1.26.0 releases shipped doctor, privacy, and engine work that the
subpackage inherits via its `memory-kernel: ^1.26.0` dep pin, but the
subpackage's own contract (config schema, hooks, peer-deps) is unchanged.

## [0.3.0] — 2026-05-20

Carried in main-package
[v1.24.2](../../CHANGELOG.md#1242--2026-05-20).

### Changed — `@sinclair/typebox` moved to `peerDependencies` (BREAKING)

- `@sinclair/typebox` is no longer a runtime dependency; it is now a
  `peerDependencies` requirement (`^0.34.0`, non-optional). Consumers of
  the `openclaw-memory-kernel` plugin must install typebox themselves.
- Rationale: typebox is also OpenClaw's schema dep — duplicating it as a
  runtime dep pulled a parallel copy into the gateway process and caused
  identity-check failures on shared schemas.
- This is the subpackage's first **subpackage-MAJOR-shaped** bump under
  the new policy: a non-additive change to `peerDependencies`. (Numbered
  0.3.0 because we are still pre-1.0; under the post-1.0 rule this would
  bump MAJOR.)

### Changed — packaging metadata hygiene

- `package.json` gains an explicit `"files": [...]` allowlist (`dist`,
  `openclaw.plugin.json`, `skills`, `INSTALL.md`), shrinking the
  prospective `npm pack` tarball from 29.8 kB / 8 files to 18.8 kB / 6
  files. Pre-fix, the tarball would have shipped `src/index.ts` and
  `tsconfig.json`.
- `engines.node` set to `">=18"` to match the (then-current) CI matrix.
  Subsequently raised to `">=22.16"` in 0.3.x via main-package
  [v1.26.0](../../CHANGELOG.md#1260--2026-05-25).

## [0.2.0] — 2026-04-21

Carried in main-package
[v1.14.0](../../CHANGELOG.md#1140--2026-04-21).

### Changed — version cadence bump (no contract change)

- Bumped from 0.1.0 → 0.2.0 alongside the main-package recall-quality
  fixes. There was no subpackage-surface change in this release; under
  the post-#197 policy this would have been a PATCH. Preserved as 0.2.0
  here because that's what consumers may have pinned against.

Real subpackage-affecting work between 0.1.0 and 0.3.0 (no version bumps
at the time — pre-policy):

### Added — Per-agent memory isolation (carried in v1.21.0)

- Five new config fields: `isolationMode` (`auto` | `shared-only` |
  `per-agent-required`), `autoInitAgentStore`, `sharedRecall`,
  `failIfMissingAgentStore` (deprecated — see below), `allowSharedFallback`.
- Plugin auto-routes all tools and hooks (`mk_remember`, `mk_recall`,
  `mk_reflect`, `mk_context_bundle`, `mk_status`, plus the three named
  lifecycle hooks) to the resolved per-agent store.
- Runtime agent identity is extracted from
  `event.context.agentIdentity.id` at bootstrap and cached per
  `sessionKey`.
- Missing agent stores throw an actionable error by default;
  `allowSharedFallback: true` opts in to the old silent fallback.

### Deprecated — `failIfMissingAgentStore`

- Throwing is now the default when the agent store is missing.
  `failIfMissingAgentStore: false` maps to `allowSharedFallback: true`
  for backward compat.
- Under the post-#197 deprecation policy (soft-warn for ≥2 MINORs,
  remove next MAJOR), this surface stays in place until subpackage
  1.0.0. Migration path: switch to `allowSharedFallback`.

### Added — SecretRef support for `embeddingApiKey` / `encryptionKey` (carried in v1.21.0)

- Both fields now accept `{ source: "file", provider: "...", id: "/..." }`
  shapes in addition to literal strings. Plugin-local resolution via a
  `secretProviders` map keeps API keys out of `openclaw.json` and out
  of `~/.openclaw/.env`.
- Plugin-local resolution is documented as a short-term workaround
  pending OpenClaw's central SecretRef surface adding third-party plugin
  config fields. String form remains supported indefinitely.

### Changed — Observable bootstrap + pre-compaction hooks (carried in v1.21.0)

- `mk_bootstrap_recall` now pushes one-line status messages to
  `event.messages` (`mk: bootstrap injected N atoms` / `no atoms yet` /
  `failed — <err>` / `no memory dir — file-first fallback`) so host
  doctrine can route off them instead of guessing.
- `mk_precompact_checkpoint` similarly emits `mk: pre-compact checkpoint
  saved (N atoms, ~T tokens)` after `checkpoint()` succeeds.
- `currentSessionId` now flows from lifecycle events into the tool audit
  trail; tools attribute events to the real session instead of the
  previous `'unknown'` literal.

## [0.1.0] — 2026-03-15

Carried in main-package
[v1.0.1](../../CHANGELOG.md#101--2026-03-15).

### Added — Initial plugin

- Native OpenClaw plugin surfacing memory-kernel through structured
  tools and lifecycle hooks (runs in-process, no MCP subprocess).
- **Tools:** `mk_remember`, `mk_recall`, `mk_reflect`,
  `mk_context_bundle`. (`mk_status` joined in v1.21.0.)
- **Lifecycle hooks:** `mk_bootstrap_recall` (`agent:bootstrap`),
  `mk_precompact_checkpoint` (`session:compact:before`),
  `mk_session_end` (`command:new`, `command:reset`).
- **Config fields:** `memoryDir`, `encryptionKey`, `agentId`,
  `embeddingProvider`, `embeddingApiKey`, `embeddingModel`.
- Auto-reindex on plugin init when no SQLite index is present.
- Plugin manifest at `openclaw.plugin.json` with `configSchema`
  covering all six config fields.
- Embedding integration: when `embeddingProvider` is set, `mk_recall`
  and the bootstrap hook use hybrid FTS5 + vector recall.
- Bundled `SKILL.md` routing guide and `INSTALL.md` install walkthrough.

---

## Backfill note

Subpackage CHANGELOG entries before this file existed (everything above)
were extracted from main `CHANGELOG.md` after the fact, as part of
[#197](https://github.com/mainion-ai/memory-kernel-dev/issues/197). Going
forward, every subpackage-affecting change is logged here at the time the
PR lands. The main-package CHANGELOG references this file (rather than
duplicating) when a main-package version also requires a subpackage bump.
