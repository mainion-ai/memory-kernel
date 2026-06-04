# Contributing to memory-kernel

Thank you for your interest in contributing! This document explains how to get involved.

---

## How to Contribute

- **Bug reports & feature requests** — open an [issue](https://github.com/mainion-ai/memory-kernel/issues) with as much context as possible. Templates guide you through the fields the maintainer needs.
- **Questions & ideas** — start a [discussion](https://github.com/mainion-ai/memory-kernel/discussions) before opening a PR for anything non-trivial.
- **Pull requests** — for small, well-scoped changes you are welcome to open a PR against `mainion-ai/memory-kernel`. The maintainer applies accepted PRs through the dev-side workflow (see [`docs/governance.md`](docs/governance.md) → *Pull requests against public main*) — your authorship is preserved; the round-trip just looks a bit different from a direct merge.

For the full triage doctrine, contributor-licensing stance (no CLA, Apache-2.0 grant is sufficient), and code-of-conduct reference, see [`docs/governance.md`](docs/governance.md).

---

## Prerequisites

- **Node.js** 22.16 or later (matches the package's `engines.node` floor; Node 24 recommended — see [#198](https://github.com/mainion-ai/memory-kernel-dev/issues/198))
- **npm** (bundled with Node.js)

---

## Development Setup

```bash
# 1. Clone the repository
git clone git@github.com:mainion-ai/memory-kernel.git
cd memory-kernel

# 2. Install dependencies
npm install

# 3. Build
npm run build
```

---

## Running Tests

```bash
# Unit tests (vitest)
npm test

# Benchmark suite
npm run bench
```

---

## Submitting Changes

1. Branch from `main`:
   ```bash
   git checkout -b feat/your-feature-name
   ```
2. Make your changes and ensure all tests pass.
3. Follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) for commit messages:
   - `feat:` new functionality
   - `fix:` bug fix
   - `docs:` documentation only
   - `refactor:` no behaviour change
   - `test:` adding or updating tests
   - `chore:` tooling, deps, config
4. Open a pull request against `main` and fill in the PR template.

**PR checklist:**
- [ ] `npm test` passes locally
- [ ] `npm run build` produces no TypeScript errors
- [ ] New public APIs are documented in the README
- [ ] CHANGELOG updated if the change is user-visible
- [ ] All other .md files affected by your change are updated in the same PR — see the "Documentation hygiene" section in `CODING_INSTRUCTIONS.md` for the canonical table

---

## Code Style

- TypeScript strict mode — no `any`, no implicit returns.
- Prefer small, composable, testable functions over classes.
- **Files are the source of truth** — memory lives on disk; the SQLite index is a derived cache. See [`docs/invariants.md`](docs/invariants.md) for the full statement, including the `entity_triples` exception. Keep I/O explicit.
- Do not add comments that restate what the code does; prefer self-explanatory names.
- Run `npm run lint:all` before pushing (`tsc --noEmit`).

## Dependency hygiene

- Direct dependencies must be maintained, with a recent release and no known CVEs.
- Transitive dependencies are tolerated even when noisy, but warning-emitting or unmaintained ones get tracked in [`docs/dep-watchlist.md`](docs/dep-watchlist.md) with revisit triggers, not silently ignored.

---

## Reporting Bugs

When filing a bug, please include:

- memory-kernel version (`npm ls memory-kernel`)
- Node.js version (`node -v`)
- Operating system
- Minimal reproduction steps
- Actual vs. expected behaviour
- Relevant log output or error messages

---

## License

By contributing to memory-kernel you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE). **No separate CLA or DCO sign-off is required** — the inbound-licensing grant is satisfied by submitting your PR under this license (Apache-2.0 §5, "Submission of Contributions"). See [`docs/governance.md`](docs/governance.md) for the full stance and when it might change.
