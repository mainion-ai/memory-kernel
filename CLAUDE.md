# memory-kernel

TypeScript library for persistent agent memory with event sourcing. npm package: `memory-kernel`.

## Development workflow

This is the **private development repo**. All new feature development happens here first, then gets promoted to `memory-kernel` (public) after review and approval.

## Before writing code, read CODING_INSTRUCTIONS.md

It contains test structure, API gotchas, security rules, and all coding conventions.

## Commands

```bash
npm test        # run all tests (vitest, 805+ tests)
npm run build   # compile TypeScript
```

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
