# memory-kernel

TypeScript library for persistent agent memory with event sourcing. npm package: `memory-kernel`.

## Before writing code, read CODING_INSTRUCTIONS.md

It contains test structure, API gotchas, security rules, all coding conventions, and the **Documentation hygiene** table that lists which `.md` files to update for which kind of change.

## Commands

```bash
npm test        # run all tests (vitest)
npm run build   # compile TypeScript
npm run bench   # benchmark harness
```

## Versioning

See [`RELEASING.md`](RELEASING.md) for the release process and SemVer guidance. Per the project convention:

- Bug fix, no public API change → PATCH (e.g. 1.12.0 → 1.12.1)
- New public API (CLI flag, exported field/function, new command) → MINOR
- Breaking change → MAJOR

Five files move together on every release: `package.json`, `package-lock.json` (top-level + self-entry), `packages/openclaw-memory-kernel/package.json` (the `memory-kernel` dep pin), `CHANGELOG.md` (new `## [X.Y.Z] — YYYY-MM-DD` section, migrating any applicable `[Unreleased]` items), and the `vX.Y.Z` git tag.

The `src/mcp/server.ts` MCP-server `version` is intentionally independent — do not bump it with the package version.

## Key conventions

- Tests in `test/`, source in `src/`, CLI in `src/cli/`.
- All file paths from user input must pass `assertWithinDir()` before I/O.
- Always call `closeAllIndexes()` before directory cleanup in `afterEach`.
- Events are NDJSON in `events.ndjson`.
- Atom IDs: `TYPE-YYYY-MM-DD-SLUG-suffix`.
- CLI commands use Commander.js patterns — see existing commands for style.
- `--json` flag pattern: check `opts.json`, output `JSON.stringify(result, null, 2)`, return early.
- Error handling: use `exitWithError(message, opts.json)` helper from `src/cli/cli-util.ts`.
- Relation types: `extends`, `contradicts`, `supports`, `caused_by`, `supersedes`, `applied_to`, `related`.
- Wander has typed edge weights with presets: `constitution`, `tension`, `narrative`.
- Files are the source of truth; the SQLite index is a derived cache. See [`docs/invariants.md`](docs/invariants.md) for the full statement (including the `entity_triples` exception).

## Per-agent isolation

- Two modes: `shared` (default, backward compatible) and `per-agent` (`config.yaml` or `MK_ISOLATION` env var).
- In isolated mode: `MEMORY_DIR/agents/{agentId}/` per agent, `MEMORY_DIR/shared/` for explicitly shared atoms.
- `resolveAgentDir(baseDir, agentId)` is the routing function — identity in shared mode.
- CLI: `-a, --agent <id>` global option threads through all commands.
- MCP: `resolveMemoryDir(ctx, agentId)` routes tool handlers to the correct store.
- Share is copy-based (snapshot), not symlink — re-share to update.
- Union recall: `recallIsolated()` merges agent + shared atoms (agent wins on ID collision).
- Per-agent `render.yaml` controls render mode, token budget, type weights, `include_shared`.
- Migration: `mk migrate --strategy fresh|partition|clone-to-shared`.
- Key files: `src/isolation.ts`, `src/isolation-recall.ts`, `src/share.ts`, `src/migrate.ts`, `src/render.ts` (`renderAgentClaudeMd`).

## OpenClaw plugin isolation

- Plugin source: `packages/openclaw-memory-kernel/src/index.ts`.
- `resolveEffectiveMemoryContext(cfg, agentId?)` is called: (1) at `register()` for the index-freshness check (`initCtx`), (2) once per session in the bootstrap hook (cached in `sessionContexts`), and (3) on cache miss in `getContext()` (pre-bootstrap tool calls only).
- 5 config fields: `isolationMode` (`auto`|`shared-only`|`per-agent-required`), `autoInitAgentStore`, `sharedRecall`, `failIfMissingAgentStore` (deprecated), `allowSharedFallback`.
- Missing agent store throws by default (prevents silent memory contamination). Set `allowSharedFallback: true` to opt-in to the old silent-fallback behaviour.
- `failIfMissingAgentStore` is deprecated — throwing is now the default. `failIfMissingAgentStore: false` maps to `allowSharedFallback: true` for backward compat.
- All 5 tools and 3 hooks route through the resolved `EffectiveMemoryContext`.
- Runtime agent identity: bootstrap hook extracts from `event.context.agentIdentity.id`, resolves the context once, and caches it in `sessionContexts` Map (keyed by sessionKey). All tools and hooks use `getContext(sessionKey?)` which returns the cached context, falling back to `activeSessionKey` when sessionKey is unavailable (tool `execute()` calls). Session cleanup deletes the cached context to prevent unbounded Map growth.
- Security: `assertValidAgentId()` is called both in bootstrap (input validation) AND inside `resolveEffectiveMemoryContext()` (defense-in-depth before any filesystem operations).
- `checkpoint()` supports isolation-aware recall via `baseDir`/`isolated`/`sharedRecall` opts — `mk_context_bundle` and the pre-compaction hook pass these.
- `recallIsolatedWithEmbeddings()` + `mergeIsolatedBundles()` handle union recall in the async embedding path.
- Key files: `src/checkpoint.ts`, `src/isolation-recall.ts`, `packages/openclaw-memory-kernel/src/index.ts`.
- Tests: `test/openclaw-plugin-isolation.test.ts`, `test/checkpoint.test.ts`.

## Skill conventions

- **Skill seed-atom convention:** `/mk-memory-setup` bundles its lifecycle seed atoms at `skills/mk-memory-setup/seed-atoms/lifecycle/` (one markdown body per atom) and seeds them via the bundled `seed-atoms/seed-lifecycle.sh` script (called from Step 6b in `SKILL.md`). The 11 atoms (10 procedures + 1 constraint) mirror sections of `docs/agent-session-loop.md` — keep them in sync when either side changes. Re-seeding requires moving the stale `ENTITIES/<id>.md` to `ARCHIVE/` first, since `generateAtomId()` always appends a unique suffix.
- **Skill host-axis convention:** the setup and doctor skills treat memory-kernel as host-agnostic at their core, with host-specific knowledge living in `references/<host>.md`. The three first-class hosts are NanoClaw (rendered `CLAUDE.md`), OpenClaw (native plugin + `AGENTS.md`/`MEMORY.md` doctrine), and MCP clients (Claude Desktop / Cursor / Continue running `mk-mcp` over stdio). When adding host-specific behaviour, branch in the skill's host-detect step and write the details into the matching reference file rather than hard-coding into `SKILL.md`.
