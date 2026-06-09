# Releasing memory-kernel

This repo's `main` branch is the source of truth for development. Releases
go to npm as the [`memory-kernel`](https://www.npmjs.com/package/memory-kernel)
package, signed with a GitHub Actions provenance attestation by
[`.github/workflows/release.yml`](./.github/workflows/release.yml).

The downstream half — per-host auto-upgrade — is a separate concern,
implemented by `fleet/mk-fleet-upgrade.sh` (follow-up PR for #142). This
document only covers the upstream "cut a release" flow.

> **Status (2026-05-25):** v1.22.0 is still the last tagged release. Eleven
> version-bumped commits sit on `main` without tags: v1.23.0 → **v1.26.0**
> (current `package.json` version, the engines-floor bump from
> [#198](https://github.com/mainion-ai/memory-kernel-dev/issues/198)).
> Tagging is blocked on the seven-thread prereq chain.
> **Six prereqs landed:** [#198](https://github.com/mainion-ai/memory-kernel-dev/issues/198)
> Node engines, [#195](https://github.com/mainion-ai/memory-kernel-dev/issues/195)
> privacy sweep (parts a+b+c), [#194](https://github.com/mainion-ai/memory-kernel-dev/issues/194)
> cross-repo squash-on-sync, [#196](https://github.com/mainion-ai/memory-kernel-dev/issues/196)
> docs audit + hygiene gate (parts a+c), and [#197](https://github.com/mainion-ai/memory-kernel-dev/issues/197)
> subpackage publish strategy (this section). **Two remain:**
> [#199](https://github.com/mainion-ai/memory-kernel-dev/issues/199) public-repo
> bootstrap + governance → [#152](https://github.com/mainion-ai/memory-kernel-dev/issues/152)
> npm OIDC + `release.yml` port to the public repo. The flow described
> below assumes #152 has shipped and the workflow lives on `mainion-ai/memory-kernel`
> (the public repo); the current file in this repo is a draft to be
> ported as part of #152.

## TL;DR

Per [CLAUDE.md > Versioning](./CLAUDE.md#versioning), five files must move
together for every release. The workflow will refuse to publish if any
one of them disagrees with the pushed tag.

1. Bump the version in **all five places** on `main` (PR or direct), in a single commit:

   1. `package.json` — `"version": "X.Y.Z"`
   2. `package-lock.json` — both top-level `"version"` and `packages[""].version` (regenerate with `npm install --package-lock-only` if easier than hand-editing)
   3. `packages/openclaw-memory-kernel/package.json` — `dependencies["memory-kernel"]: "^X.Y.Z"` (caret sync is a project convention — keep it in lockstep even when semver would already satisfy)
   4. `CHANGELOG.md` — add a `## [X.Y.Z] — YYYY-MM-DD` section; move any applicable `[Unreleased]` items into it
   5. Git tag `vX.Y.Z` on the release commit

2. `git push origin main vX.Y.Z`.
3. Watch the Release workflow on GitHub Actions.

The workflow takes it from there: tests run, all five version places are
checked against the tag, npm publish runs with a provenance attestation,
and a GitHub release is created — its notes are the curated `CHANGELOG.md`
`## [X.Y.Z]` section, and it posts a linked announcement in the public repo's
Discussions **Announcements** category. The MCP-server version in
`src/mcp/server.ts` is intentionally independent — do **not** bump it with the
package version.

## What the workflow does

Triggered by any push of a tag matching `v*`:

1. **Checkout** at the tagged commit.
2. **Setup Node 22** (current Maintenance LTS; matches the `engines.node = ">=22.16"` floor set in [#198](https://github.com/mainion-ai/memory-kernel-dev/issues/198)) with the npm registry configured. CI matrix runs against `[22, 24]`.
3. **`npm ci`**, **`npm run build`**, **`npm test`** — full suite must pass.
4. **Verify all five release-version places agree** — `vX.Y.Z` tag against `package.json` version, `package-lock.json` top-level + self-entry, `packages/openclaw-memory-kernel/package.json` `memory-kernel` dep pin (`^X.Y.Z`), and `CHANGELOG.md` `## [X.Y.Z]` section. Any mismatch fails the job — we'd rather fail the publish than ship an artifact whose version disagrees with its lockfile, openclaw pin, or changelog.
5. **`npm publish --provenance --access public`** — signed via sigstore using the GitHub Actions OIDC token. The published artifact carries an attestation tying it to this commit + workflow run.
6. **Build release notes from CHANGELOG** — `scripts/changelog-section.sh "$version" --body-only` extracts the `## [X.Y.Z]` section body (the same extractor `sync-to-public.sh` uses for the synthetic-commit body — one source of truth). The five-place check in step 4 already guaranteed the section exists.
7. **`gh release create --notes-file release-notes.md --discussion-category "Announcements"`** — GitHub release whose notes are the curated CHANGELOG section, plus an auto-created linked announcement in the public repo's Discussions. Requires the workflow's `discussions: write` permission and the **Announcements** category to exist on the public repo (it does).

## One-time setup

**Required: OIDC trusted publisher.** `npm publish --provenance` only works
through the sigstore OIDC flow. There is no fallback — without OIDC trust
configured, the publish fails with 403 regardless of any other token.

On [npmjs.com](https://www.npmjs.com/) → package settings → "Trusted
Publisher", add:

- Repository: `mainion-ai/memory-kernel-dev`
- Workflow filename: `release.yml`
- Environment name: *(blank)*

The `id-token: write` permission in the workflow already wires up the OIDC
token. Once OIDC trust is configured, `npm publish --provenance` works
automatically with no token rotation to manage.

### Optional: `NPM_TOKEN` secret

The workflow also reads `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` from a
repo secret. This is *not* a fallback for OIDC — it's wired up so future
jobs that publish without `--provenance` (e.g. a manual republish from a
maintainer's box, or a one-off "patch on top of a yanked version" flow)
can authenticate. The main release job will not use it.

## How the sync workflow runs

Per [#194](https://github.com/mainion-ai/memory-kernel-dev/issues/194), every `v*` tag pushed to this private dev repo triggers `.github/workflows/sync-on-tag.yml`, which builds a **synthetic squash commit** from the tagged tree and pushes it (plus the tag) to the public `mainion-ai/memory-kernel` repo. The public-repo `release.yml` (per [#152](https://github.com/mainion-ai/memory-kernel-dev/issues/152)) consumes the tag push and runs `npm publish --provenance`.

What the sync does, in order:

1. **Mints a short-lived GitHub App installation token** from the `MK_SYNC_APP_ID` + `MK_SYNC_APP_PRIVATE_KEY` repo secrets, scoped to `mainion-ai/memory-kernel` only.
2. **Clones public `main` shallowly** to capture the current HEAD as the synthetic commit's parent.
3. **Materialises the tagged tree** via `git archive | tar -x` into a staging directory.
4. **Applies the privacy filter** from `.privacy/redact-paths.txt` — each entry (a file path or directory, exact match — no glob expansion) is stripped from the staging dir via `rm -rf`. Missing entries are no-ops (a redact entry that didn't exist at this tag isn't an error). To redact "all files matching `*.secret.md`", list each match explicitly.
5. **Applies swap-in overrides** from `.privacy/public-overrides/<path>` — each file is copied into its target path in the staging dir. This happens *after* the redact pass, so a swap-in target can also appear in the redact list (e.g. `CLAUDE.md` is redacted then replaced with the public-friendly version).
6. **Composes the synthetic commit** — the staging dir's `.git` is replaced with a copy of public's `.git` (gives one object database with the parent plus the new tree). `git write-tree` produces the tree SHA; `git commit-tree TREE -p <public HEAD>` produces the commit SHA. Commit message is `Release <tag>` plus the matching `CHANGELOG.md` section as the body.
7. **Pushes** the synthetic commit to `<public>:main` (regular push, not force — concurrent edits abort the sync, which is the safe default), then pushes the tag.

### Triggers

- **`push` of a `v*` tag** — production sync. Always real-push (no dry-run).
- **`workflow_dispatch`** — manual sync with explicit `tag` input and `dry_run` checkbox. Used for re-runs and for validating the workflow before the GitHub App is configured. Default is `dry_run: true` so a misclick can't surprise-publish.

### Dry-run mode

In dry-run, the script does steps 1-6 but skips the push, reporting the synthetic SHA, target URL, and `git diff --stat` against the parent. Useful for inspecting what would land on public before doing it for real.

### Local testing

`scripts/sync-to-public.sh` is the standalone script that the workflow invokes. It can be exercised locally against a bare-repo fixture — see `test/sync-to-public.test.ts` (5 tests covering dry-run, real-push, CHANGELOG extraction, error cases). The script reads `PUBLIC_REPO_URL` from env; for local runs, point it at a bare repo:

```bash
PUBLIC_REPO_URL=/tmp/public.git scripts/sync-to-public.sh v1.26.0 --dry-run
```

### Required one-time setup

Tracked as the open work in [#194](https://github.com/mainion-ai/memory-kernel-dev/issues/194) and [#199](https://github.com/mainion-ai/memory-kernel-dev/issues/199):

- Register a `memory-kernel-sync` GitHub App in the `mainion-ai` org (done 2026-05-25).
- Install it on `mainion-ai/memory-kernel` only.
- Permissions: `contents: write` on the public repo. Nothing else.
- Store the App ID + private key as repo secrets `MK_SYNC_APP_ID` + `MK_SYNC_APP_PRIVATE_KEY` in this (`-dev`) repo (done 2026-05-25).
- Apply branch protections and other public-repo settings per [`docs/public-repo-settings.md`](docs/public-repo-settings.md) — the canonical operator checklist + snapshot.
- **First sync is a force-reset.** Public main currently sits at `9305088b` (v1.16.1, organic history). The first synthetic-commit push from this workflow replaces that HEAD with no parent. Rationale and the audit-preserved SHAs of the pre-sync state are in [`docs/decisions/0001-force-reset-public-main.md`](docs/decisions/0001-force-reset-public-main.md). Subsequent syncs are fast-forward only.

## Subpackage releases

`packages/openclaw-memory-kernel/` follows its own SemVer track, independent of the main `memory-kernel` package. Policy locked in [#197](https://github.com/mainion-ai/memory-kernel-dev/issues/197).

### Tag scheme

- Main package: `vX.Y.Z` (unchanged).
- Subpackage: **`openclaw-memory-kernel-vX.Y.Z`** (does not collide with the main `v*` tag space).

The sync workflow ([#194](https://github.com/mainion-ai/memory-kernel-dev/issues/194)) and the public-side `release.yml` ([#152](https://github.com/mainion-ai/memory-kernel-dev/issues/152)) will route by tag prefix:

- `v*` → main `memory-kernel` publish.
- `openclaw-memory-kernel-v*` → `openclaw-memory-kernel` publish.

> **Not yet wired.** `.github/workflows/sync-on-tag.yml` currently triggers on `v*` only; the `openclaw-memory-kernel-v*` trigger and the matching tag-prefix routing in `release.yml` are deferred to [#152](https://github.com/mainion-ai/memory-kernel-dev/issues/152). Pushing a subpackage tag today is a no-op against the sync workflow.

### When to bump the subpackage

| Bump | Trigger |
|---|---|
| **MAJOR** | Non-additive `peerDependencies` change (e.g. `openclaw` floor raised in a way that drops existing consumers, `@sinclair/typebox` major bump). Breaking change to the plugin's exported config schema, hook contract, or tool surface. |
| **MINOR** | Additive surface — new config field, new exported hook, new tool name. New `memory-kernel` features the subpackage now relies on (constraint widening). |
| **PATCH** | Tracking main-package PATCH releases with no API surface change. Bug fixes inside the plugin. |

The subpackage bump is **decoupled from the main-package bump** — a main-package PATCH does not automatically trigger a subpackage PATCH. The subpackage gets bumped only when its own contract or its `peerDependencies` change.

### What moves together on a subpackage release

For a subpackage `X.Y.Z` release, update in a single commit:

1. `packages/openclaw-memory-kernel/package.json` — `"version": "X.Y.Z"`.
2. `packages/openclaw-memory-kernel/package-lock.json` (if present) — both top-level `"version"` and `packages[""].version`.
3. `packages/openclaw-memory-kernel/CHANGELOG.md` — new `## [X.Y.Z] — YYYY-MM-DD` section.
4. Git tag `openclaw-memory-kernel-vX.Y.Z` on the release commit.

The main-package's `package.json` is **not** touched by a subpackage release. The `memory-kernel` caret pin inside `packages/openclaw-memory-kernel/package.json` is only updated when that pin actually needs to move (e.g. the subpackage now requires a feature added in a newer main-package release).

### Deprecation policy (applies to both packages)

Surfaces flagged for removal follow a **soft-warn → remove-at-next-MAJOR** discipline:

1. Mark the surface deprecated in the relevant CHANGELOG, in JSDoc, and (for plugin config fields) in the schema description in `openclaw.plugin.json`.
2. Keep emitting it (with the deprecation warning) for **at least two MINOR releases**.
3. Remove only on the next **MAJOR** bump of *the package that owns the surface*.

This rule applies symmetrically to main and subpackage. Concrete current case: `failIfMissingAgentStore` (subpackage) deprecated since v1.21.0, removed in subpackage 1.0.0 at earliest. See [`packages/openclaw-memory-kernel/INSTALL.md` → Deprecation policy](../packages/openclaw-memory-kernel/INSTALL.md#deprecation-policy) for the consumer-facing summary.

### Public-repo placement

The subpackage ships as a **monorepo entry** under `mainion-ai/memory-kernel/packages/openclaw-memory-kernel/` (Option A in #197), not as a separate `mainion-ai/openclaw-memory-kernel` repo. This keeps the compat matrix (subpackage × main × openclaw × typebox) self-documenting and avoids doubling the sync-workflow and GitHub App configuration. Splitting later (additive change via `git filter-repo --subdirectory-filter` + a new sync route) remains an option if external demand surfaces.

## SemVer guidance for engine bumps

Tightening `engines.node` (e.g. dropping a Node major) is **at minimum a MINOR** because existing consumers may be running the now-unsupported runtime and will see an `EBADENGINE` warning (or failure with `--engine-strict`). It's a **MAJOR** if your project promises strict-SemVer engine compat in its public contract; for v1.x of memory-kernel we treat it as MINOR because no public npm consumers exist pre-[#152](https://github.com/mainion-ai/memory-kernel-dev/issues/152).

## Failure modes

- **Version places out of sync** — the workflow's "Verify all five release-version places agree" step prints which of the five disagrees with the tag and exits before publishing. Fix: push a follow-up commit that brings the missing file in line (most often the openclaw caret pin or a missing `## [X.Y.Z]` CHANGELOG section), then re-tag. See the TL;DR for the full list.
- **Test failure on the tagged commit** — workflow exits before publishing. Fix on `main`, re-tag.
- **`npm publish` 403** — almost always means OIDC trust isn't configured for this repo + workflow on npmjs.com. `--provenance` requires OIDC; no token can substitute. See "One-time setup" above.
- **Tag already exists on npm** — npm refuses to overwrite. If you really need to re-publish that version, bump to a patch (`X.Y.Z+1`).

## Rolling back

`npm` doesn't allow re-publishing a released version. To revert:

1. Cherry-pick the revert(s) onto `main`.
2. Bump to a new patch version in **all five places** (per the TL;DR checklist above): `package.json`, both `package-lock.json` entries, the openclaw `memory-kernel` dep pin, and a new `## [X.Y.Z+1] — YYYY-MM-DD` section in `CHANGELOG.md` (note in the section that this is a revert release).
3. Tag the commit `vX.Y.Z+1` and push as a new release.
4. Mark the broken version as deprecated so anyone who already installed it sees a warning on their next `npm install`:

   ```
   npm deprecate memory-kernel@<broken-version> \
     "Broken release — use <fixed-version> or later"
   ```

   This doesn't remove the artifact (npm doesn't allow that), but downstream
   installers get a stderr nudge to upgrade.

Downstream hosts running the polling script (`mk-fleet-upgrade.sh`, follow-up PR) can also fall back manually with `npm install -g memory-kernel@<prev-version>` — keep that one-liner handy.

## Why pull-based (not push)

Per the design discussion on [#142](https://github.com/mainion-ai/memory-kernel-dev/issues/142):

- Pull means each host owns its own upgrade timing.
- No SSH keys or per-host registry to maintain.
- A bad release doesn't simultaneously brick every host — staggered polling intervals provide a natural canary window.

This workflow is *only* the publish side. Hosts pull from the resulting npm release on their own schedule.
