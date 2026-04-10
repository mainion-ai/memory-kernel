# memory-kernel

TypeScript library for persistent agent memory with event sourcing. npm package: `memory-kernel`.

## Development workflow

This is the **private development repo**. All new feature development happens here first, then gets promoted to `memory-kernel` (public) after review and approval. See `docs/AUTONOMOUS-DEV-PIPELINE.md` for the full workflow.

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
