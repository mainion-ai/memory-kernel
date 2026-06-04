# ADR 0001 — Preserve public `mainion-ai/memory-kernel` main on first sync

**Status:** Accepted (superseded 2026-06-04 — see "Revision" section below)
**Date:** 2026-05-25 (original), 2026-06-04 (revised)
**Issue:** [#199](https://github.com/mainion-ai/memory-kernel-dev/issues/199) part (a)
**Supersedes:** —

---

## Revision 2026-06-04 — Option A "preserve" chosen in practice

When implementing `scripts/sync-to-public.sh` for #194, the actual code path captured public's current HEAD as the synthetic commit's parent (`git commit-tree "$TREE_SHA" -p "$PARENT_SHA"`). The 2026-05-26 `dryrun-2026-05-26` validation succeeded specifically because the push was fast-forward (parent SHA = `9305088b` = public's current v1.16.1 HEAD).

This is **Option A — Preserve** from the table below, not Option B — Force-reset (the originally-chosen option).

Discovery of this mismatch during #152 Phase 1 work surfaced that the umbrella plan's "first sync needs --force accommodation" and the workflow's `force_first_sync` input were both solving a non-problem. Force-pushing main is a bigger operational risk than the cosmetic benefit of a single-shape history, and the existing-pinner UX of preserve is strictly better.

**Revised decision: Option A — Preserve.** The implementation reflects this. No `--force` flag is needed on the first sync or any subsequent sync. The pre-sync tags (`v1.12.0`, `v1.15.0`, `v1.16.1`) remain reachable on public main's history; v1.28.0 (the first synced release) appears as a child of `9305088b`.

The pre-sync state below is still recorded for audit, but it remains reachable in normal `git log` order rather than as orphan history.

---

---

## Context

The public repository `mainion-ai/memory-kernel` (npm publish source per [#152](https://github.com/mainion-ai/memory-kernel-dev/issues/152)) currently holds a small amount of organic commit history. Last known state on 2026-05-25:

- **Branch:** `main`
- **HEAD:** `9305088b6dff` — `chore(release): 1.16.1 — critical render + extract fixes` (2026-05-15)
- **Tags:** `v1.12.0`, `v1.15.0`, `v1.16.1`

The cross-repo squash-on-sync workflow ([#194](https://github.com/mainion-ai/memory-kernel-dev/issues/194), `scripts/sync-to-public.sh`) is now the only intended writer to public main. Its synthetic commits replay -dev's tagged tree state with privacy filters applied; they do not preserve -dev's organic commit history.

Before the first production sync run, we must decide what to do with the pre-existing public history.

## Options considered

### Option A — Preserve

Make the first synthetic commit a child of `9305088b6dff`. Public `git log` would show the v1.12.0–v1.16.1 release commits followed by a single giant squash for v1.27.0 (or whatever the first synced tag is).

**Pros:** existing pins keep working under standard `git pull`. v1.16.1 release notes stay reachable.

**Cons:** mixes two history models — organic per-PR commits up to v1.16.1, then synthetic squashes after. No semantic continuity between the two (the v1.16.1 "critical render + extract fixes" commit doesn't exist as an object in -dev — it was a direct-on-public release, never back-merged with that SHA). External diff tools will struggle to render the transition.

### Option B — Force-reset (chosen)

Force-push public main to the first synthetic commit (no parent). All pre-sync history becomes orphan commits, reachable only via the recorded SHAs below.

**Pros:** clean history model going forward. Public users see one consistent commit shape (synthetic squash) from v1.27.0 onwards. No tangled provenance.

**Cons:** existing v1.16.1 pinning users see an "unrelated history" error on next `git pull`. npm users are unaffected (they consume the registry, not git).

### Option C — Backfill

Reconstruct each intermediate -dev tag (v1.17.0, v1.18.x, v1.19.x, v1.20.x, v1.21.x, v1.22.0, ..., v1.26.1) as a synthetic commit, parented in chronological order onto the existing v1.16.1.

**Pros:** preserves tag-by-tag changelog story.

**Cons:** disproportionate work; the per-release CHANGELOG already lives in `CHANGELOG.md` which ships with each synced tree. Tag-by-tag git history is redundant.

## Decision

**Original (2026-05-25): Option B — force-reset.**

**Revised (2026-06-04): Option A — preserve.** See the "Revision" section at the top of this ADR. The Option A vs B comparison stays as historical record; the operational choice reflected in `scripts/sync-to-public.sh` and `.github/workflows/sync-on-tag.yml` is Preserve.

## Consequences

### Last organic public state (preserved for audit)

| Item | Value |
|---|---|
| Branch | `main` |
| HEAD commit SHA | `9305088b6dff` |
| Commit subject | `chore(release): 1.16.1 — critical render + extract fixes` |
| Commit date | 2026-05-15T12:13:55Z |
| Last reachable tag | `v1.16.1` |
| Earlier tags | `v1.15.0` (`08a8c50b9f8a`), `v1.12.0` (`56f7806889ae`) |

These SHAs are unreachable from public `main` after the first sync but remain valid object references; an archived clone of public taken before the first sync preserves the full history if needed for audit.

### Operator step (post-revision)

The first production run of `.github/workflows/sync-on-tag.yml` against a `v*` tag is a **vanilla fast-forward push** under the revised Option A: the synthetic commit's parent is public's current HEAD (`9305088b`, v1.16.1), so the push lands as a normal one-commit advance. No `--force`, no workflow flag, no operator accommodation.

After the first sync:

- `mainion-ai/memory-kernel` `main` HEAD = the synthetic commit, parented to v1.16.1's `9305088b`.
- Pre-sync tags (`v1.12.0`, `v1.15.0`, `v1.16.1`) stay reachable as ancestors.
- Subsequent synced tags fast-forward normally.
- Users who pinned `^1.16.0` on npm continue to work because npm decouples published artifacts from git tags. Users who pinned at the git level via `v1.16.1` can `git pull` cleanly — they get one new commit (v1.28.0), not an unrelated-history error.

The branch-protection allowlist (per `docs/public-repo-settings.md`) keeps the sync App's force-push capability permanently as a defensive measure — for hypothetical future scenarios like leaked-secret history rewrites — even though day-to-day syncs never use it.

### Communication (post-revision)

Under the preserve model, no special release-note wording is needed — the v1.28.0 release is structurally a normal "next version" from existing pinners' perspective. The auto-generated GitHub release notes (`gh release create --generate-notes`) are sufficient.

## References

- Discussion locked in chat 2026-05-25 alongside #199 parts (b), (d), (e).
- [#199](https://github.com/mainion-ai/memory-kernel-dev/issues/199) part (a) acceptance criteria.
- [#194](https://github.com/mainion-ai/memory-kernel-dev/issues/194) — sync workflow design.
- 2026-06-04 discovery: implementation diverged from original Option B during #194's coding; revised the ADR to record the actual chosen behaviour.
