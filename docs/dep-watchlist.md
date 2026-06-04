# Dependency watchlist

Upstream deprecation warnings and unmaintained transitive dependencies that have **no actionable fix today** but should be revisited when conditions change. Filed here instead of as long-lived GitHub issues so the list is version-controlled, diffable, and lives next to the rest of the docs.

When an entry becomes actionable, lift it into an issue (or directly into a PR) and remove it from this file.

---

## `better-sqlite3` → `prebuild-install` deprecation warning

**Source:** [#177](https://github.com/mainion-ai/memory-kernel-dev/issues/177) (closed in favour of this file). Initially raised in System Review §2.11 (`docs/superpowers/reviews/2026-05-16-system-review.md`) and triaged in PR-20 (#105 dependency hygiene).

### Symptom

`npm install` prints:

```
npm warn deprecated prebuild-install@7.1.3: No longer maintained. Please contact the author of the relevant native addon; alternatives are available.
```

`prebuild-install` is the helper [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) uses to fetch precompiled native binaries. The package itself is unmaintained upstream; the warning originates with `better-sqlite3`, not memory-kernel.

### Why we are not acting on it today

- No maintained alternative downloader is wired into `better-sqlite3` yet.
- Removing the prebuilt path would force every `npm install` to compile native code locally — a significant regression on cold-cache CI runs and ARM hosts.
- The warning is cosmetic; installs still succeed.
- No active CVE targets `prebuild-install`.

### Revisit when

- `better-sqlite3` ships an alternative downloader (e.g., a `node-gyp-build` migration). Watch [WiseLibs/better-sqlite3 release notes](https://github.com/WiseLibs/better-sqlite3/releases).
- A maintained fork of `prebuild-install` becomes the recommended path.
- A security advisory targets `prebuild-install` directly.
- Migration to a different SQLite driver (e.g. `bun:sqlite`, `node:sqlite` once stable) is contemplated for unrelated reasons.

### Acceptance (if/when actioned)

- `npm install` produces no deprecation warning for `prebuild-install` (or a maintained replacement is in place).
- All SQLite-backed tests pass.
- CI install time does not regress more than 30s on cold cache.

---

## How to add an entry

Each entry needs four sections:

1. **Symptom** — what an operator sees (build warning text, audit advisory ID, etc.).
2. **Why we are not acting on it today** — the trade-off that justifies parking the item rather than fixing it now.
3. **Revisit when** — concrete upstream or environmental triggers that flip the cost/benefit. Include URLs to the upstream issue/release notes whenever possible.
4. **Acceptance** — what "done" looks like, so a future PR knows when the entry can be removed.

Keep entries focused on dependencies and tooling. Project-internal follow-ups belong in GitHub issues; doctrine that the team committed to belongs in `docs/invariants.md` or `CONTRIBUTING.md`.
