# memory-kernel

TypeScript library for persistent agent memory with event sourcing. npm package: `memory-kernel`.

## Development workflow

This is the **private development repo**. All new feature development happens here first, then gets promoted to `memory-kernel` (public) after review and approval.

## Before writing code, read CODING_INSTRUCTIONS.md

It contains test structure, API gotchas, security rules, and all coding conventions.

## Commands

```bash
npm test        # run all tests (vitest, 1070+ tests)
npm run build   # compile TypeScript
```

## Versioning

- Whenever code changes (not docs-only), propose a version bump for user approval **before** committing.
  - Bug fix, no public API change → PATCH (e.g. 1.12.0 → 1.12.1)
  - New public API (CLI flag, exported field/function, new command) → MINOR (e.g. 1.12.0 → 1.13.0)
  - Breaking change → MAJOR
- Wait for explicit approval of the proposed version before touching version fields.
- Bump these five places together in a single commit:
  1. `package.json` — `"version"`
  2. `package-lock.json` — both top-level `"version"` and the self-entry under `"packages": { "": { "version": ... } }` (regenerate via `npm install --package-lock-only` if easier)
  3. `packages/openclaw-memory-kernel/package.json` — the `"memory-kernel": "^X.Y.Z"` dependency pin (project convention: sync the caret on every release, even when semver would already satisfy)
  4. `CHANGELOG.md` — add `## [X.Y.Z] — YYYY-MM-DD` section; move any applicable `[Unreleased]` items into it
  5. Git tag `vX.Y.Z` on the release commit
- `src/mcp/server.ts` MCP-server `version` is intentionally independent — do not bump with package version.

## Key conventions

- Tests in `test/`, source in `src/`, CLI in `src/cli/`
- All file paths from user input must pass `assertWithinDir()` before I/O
- Always call `closeAllIndexes()` before directory cleanup in `afterEach`
- Events are NDJSON in `events.ndjson`
- Atom IDs: `TYPE-YYYY-MM-DD-SLUG-suffix`
- CLI commands use Commander.js patterns — see existing commands for style
- `--json` flag pattern: check `opts.json`, output `JSON.stringify(result, null, 2)`, return early
- Error handling: use `exitWithError(message, opts.json)` helper
- Relation types: `extends`, `contradicts`, `supports`, `caused_by`, `supersedes`, `applied_to`, `related`
- Wander has typed edge weights with presets: `constitution`, `tension`, `narrative`
- **Skill seed-atom convention:** `/mk-memory-setup` bundles its lifecycle seed atoms at `skills/mk-memory-setup/seed-atoms/lifecycle/` (one markdown body per atom) and seeds them via the bundled `seed-atoms/seed-lifecycle.sh` script (called from Step 7b in `SKILL.md`). The eight atoms (7 procedures + 1 constraint) mirror sections of `docs/agent-session-loop.md` — keep them in sync when either side changes. Re-seeding requires moving the stale `ENTITIES/<id>.md` to `ARCHIVE/` first, since `generateAtomId()` always appends a unique suffix.
- **Skill host-axis convention:** the setup and doctor skills treat memory-kernel as host-agnostic at their core, with host-specific knowledge living in `references/<host>.md`. The three first-class hosts are NanoClaw (rendered CLAUDE.md), OpenClaw (native plugin + AGENTS.md/MEMORY.md doctrine), and MCP clients (Claude Desktop / Cursor / Continue running `mk-mcp` over stdio). When adding host-specific behaviour, branch in the skill's host-detect step and write the details into the matching reference file rather than hard-coding into SKILL.md.

## Per-agent isolation

- Two modes: `shared` (default, backward compatible) and `per-agent` (config.yaml or `MK_ISOLATION` env var)
- In isolated mode: `MEMORY_DIR/agents/{agentId}/` per agent, `MEMORY_DIR/shared/` for explicitly shared atoms
- `resolveAgentDir(baseDir, agentId)` is the routing function — identity in shared mode
- CLI: `-a, --agent <id>` global option threads through all commands
- MCP: `resolveMemoryDir(ctx, agentId)` routes tool handlers to correct store
- Share is copy-based (snapshot), not symlink — re-share to update
- Union recall: `recallIsolated()` merges agent + shared atoms (agent wins on ID collision)
- Per-agent `render.yaml` controls render mode, token budget, type weights, include_shared
- Migration: `mk migrate --strategy fresh|partition|clone-to-shared`
- Key files: `src/isolation.ts`, `src/isolation-recall.ts`, `src/share.ts`, `src/migrate.ts`, `src/render.ts` (renderAgentClaudeMd)

## OpenClaw plugin isolation

- Plugin source: `packages/openclaw-memory-kernel/src/index.ts`
- `resolveEffectiveMemoryContext(cfg, agentId?)` is called: (1) once at register() time for the index-freshness check (`initCtx`), (2) once per session in the bootstrap hook (result cached in `sessionContexts`), and (3) on cache miss in `getContext()` (pre-bootstrap tool calls only, no runtime agentId)
- 5 config fields: `isolationMode` (`auto`|`shared-only`|`per-agent-required`), `autoInitAgentStore`, `sharedRecall`, `failIfMissingAgentStore` (deprecated), `allowSharedFallback`
- Missing agent store throws by default (prevents silent memory contamination). Set `allowSharedFallback: true` to opt-in to the old silent fallback.
- `failIfMissingAgentStore` is deprecated — throwing is now the default. `failIfMissingAgentStore: false` maps to `allowSharedFallback: true` for backward compat.
- All 5 tools and 3 hooks route through the resolved `EffectiveMemoryContext`
- Runtime agent identity: bootstrap hook extracts from `event.context.agentIdentity.id`, resolves `EffectiveMemoryContext` once, and caches it in `sessionContexts` Map (keyed by sessionKey). All tools and hooks use `getContext(sessionKey?)` which returns the cached context, falling back to `activeSessionKey` when sessionKey is unavailable (tool execute() calls). Session cleanup deletes the cached context to prevent unbounded Map growth.
- Security: `assertValidAgentId()` is called both in bootstrap (input validation) AND inside `resolveEffectiveMemoryContext()` (defense-in-depth before any filesystem operations)
- `checkpoint()` supports isolation-aware recall via `baseDir`/`isolated`/`sharedRecall` opts — `mk_context_bundle` and pre-compaction hook pass these
- `recallIsolatedWithEmbeddings()` + `mergeIsolatedBundles()` handle union recall in the async embedding path
- Key files: `src/checkpoint.ts`, `src/isolation-recall.ts`, `packages/openclaw-memory-kernel/src/index.ts`
- Tests: `test/openclaw-plugin-isolation.test.ts`, `test/checkpoint.test.ts`
