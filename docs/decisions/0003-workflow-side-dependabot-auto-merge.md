# ADR 0003 — Workflow-side gating for dependabot auto-merge

**Status:** Accepted
**Date:** 2026-06-03
**Issue:** —
**Amends:** [ADR 0002](0002-disable-rulesets-on-free-org.md) (corrects its mistaken
conclusion about classic Branch Protection as a Free-plan replacement)

---

## Context

[ADR 0002](0002-disable-rulesets-on-free-org.md) reasoned that **classic Branch
Protection rules** were the Free-plan replacement for Rulesets — rulesets are
gated behind GitHub Team for private repos, but classic Branch Protection was
believed to enforce on Free. ADR 0002 closed with: "If/when we want enforcement
(e.g., to prevent accidental force-push to `main` after the public-sync workflow
lands), reach for classic Branch protection rules under Settings → Branches."

While setting up the gates required for [PR #222](https://github.com/mainion-ai/memory-kernel-dev/pull/222)'s
dependabot auto-merge workflow, the **Settings → Branches → Add classic branch
protection rule** page surfaced the same Team/Enterprise paywall banner that
the Rulesets page shows:

> Your rules won't be enforced on this private repository until you move to a
> GitHub Team or Enterprise organization account.

So classic Branch Protection **also doesn't enforce** on private repos under a
Free org. The "Free-plan workaround" path ADR 0002 named no longer exists.

This is consequential because PR #222's `.github/workflows/dependabot-auto-merge.yml`
called `gh pr merge --auto --squash`. GitHub's `--auto` flag waits for
required status checks to pass — but "required" here means "required at the
branch-protection layer." With no enforced branch protection, the in-flight CI
run on a fresh PR isn't gating anything, and `--auto` falls through to an
**immediate merge** on the merging workflow's first call. dependabot patches
would land before CI finished — defeating the safety purpose of auto-merging
patch/minor only.

Three additional details surfaced during setup:

- The repo-level **"Allow auto-merge"** toggle (Settings → General → Pull
  Requests) appeared **grayed out** in the UI. We did not chase down whether
  this is plan-level or policy-level — moot under the chosen path.
- The `auto-merge` job had been firing and *correctly skipping* on
  non-dependabot PRs (the `github.actor == 'dependabot[bot]'` guard works),
  confirming the workflow's trigger plumbing is sound — only the gating
  mechanism needs to change.
- No dependabot PRs have shipped through this workflow yet — PR #217 (the
  only past dependabot merge) was merged manually before the workflow
  existed. So there is no live behaviour to regression-test against.

## Options considered

### Option A — Branch Protection (ADR 0002's choice, no longer viable)

Configure classic Branch Protection on `main` with required status checks
(`test (22)`, `test (24)`, `check`, `scan`); rely on `gh pr merge --auto`.

**Status:** *no longer viable* on the current plan tier. The setup page itself
declares the rule won't be enforced. Saving the form creates a phantom rule —
exactly the misleading state ADR 0002 disabled Rulesets to avoid.

### Option B — Workflow-side gating (chosen)

Refactor `dependabot-auto-merge.yml` to poll the PR's status-check rollup
until the required checks resolve, then call `gh pr merge --squash` directly.
The workflow becomes the gate, independent of branch-protection enforcement.

**Pros:**
- Works on the current plan tier with no spend.
- Same gating semantics as branch protection's `--auto`: wait for green,
  refuse on red, timeout if checks never appear.
- The list of "required" checks is explicit in the workflow YAML
  (`REQUIRED_CHECKS` env var) — visible in the same place as the merging
  logic, no UI state to drift against.
- The `auto-merge` job's existing `github.actor == 'dependabot[bot]'` +
  patch/minor guards are unchanged. Only the merge call changes.

**Cons:**
- Workflow YAML grows from ~28 lines to ~85.
- The poll holds an Actions minute slot for the duration of CI (~2 min of
  CI = ~2 min of poll = ~4 min of Actions billable on the merging side).
  Free plan provides 2,000 Actions minutes/month — at one dependabot PR
  per week this is ~16 min/month, negligible.
- The required check names are baked into the workflow YAML. If a check
  is renamed or a new required check is added, the workflow must be
  updated in sync. Mitigated by the names being clustered in one env var
  literal at the top of the step.

### Option C — Drop auto-merge entirely

Keep `.github/dependabot.yml` (weekly updates, grouping) and remove the
auto-merge workflow. Maintainer eyeballs each weekly rollup PR.

**Pros:** zero ongoing complexity; the workflow that doesn't exist can't
break. The dependabot config alone still pays off via grouping and cadence.

**Cons:** one manual click per week per ecosystem. At current pace that
is acceptable, but the convenience of auto-merge was the explicit reason
the workflow was added in the first place.

### Option D — Upgrade org to GitHub Team

Both Rulesets and classic Branch Protection start enforcing on private
repos. Reverts to ADR 0002's original architectural intent.

**Pros:** native gating; no custom polling logic; consistent with how
larger GitHub orgs operate.

**Cons:** ~$4/user/month/seat with no immediate value on this repo's
solo-ish scale. The poll-and-merge approach in B costs nothing and works
correctly. Reserve this for if/when the org actually needs Team for other
reasons (multiple teams, fine-grained CODEOWNERS, audit log, etc.).

## Decision

**Option B — workflow-side gating.** The workflow polls `gh pr view --json
statusCheckRollup` every 20 seconds (after a 30-second initial delay to
let CI register), waits for an explicit list of required checks (`test
(22)`, `test (24)`, `check`, `scan`) to all reach `SUCCESS` or `SKIPPED`,
then calls `gh pr merge --squash --delete-branch`. The job has a
20-minute hard timeout; if checks never resolve, the workflow fails
loudly and the PR falls back to manual merge.

The `dependabot/fetch-metadata@v2` action still gates `update-type` —
major bumps never reach the polling step.

## Consequences

- ADR 0002's "use classic Branch Protection" guidance is **incorrect for
  this plan tier**. The relevant fact has been added to ADR 0002 via a
  forward-link to this ADR.
- The **"Allow auto-merge" repo toggle is irrelevant** under this design.
  Whether it's grayed out in the UI no longer matters — `gh pr merge
  --squash` (without `--auto`) works regardless of the toggle's state.
- The `auto-merge` job's appearance in the PR check rollup is informational
  — it is *not* one of the required checks, and it self-excludes from the
  poll via the `SELF_CHECK_NAME` env var so it can't deadlock waiting on
  itself.
- Adding a new required check (e.g. a future `lint` or `type-check`
  workflow) requires updating the `REQUIRED_CHECKS` env var in this
  workflow. Documented in the workflow comments.
- The poll reads the PR's `statusCheckRollup`, which GitHub resolves
  through `commit.statusCheckRollup`. That nested rollup requires
  **`checks: read`** (CheckRun) and **`statuses: read`** (Status) in the
  workflow `permissions:` block. They are easy to omit because
  `contents: write` + `pull-requests: write` look sufficient — but the
  Dependabot-context token defaults undeclared permissions to none, so the
  GraphQL drill-down fails with `Resource not accessible by integration`.
  Both reads were added 2026-06-07 after every Dependabot PR (e.g. #239)
  fell back to manual merge.

## Revisit triggers

- **Plan upgrade to GitHub Team** — restore native `--auto` semantics via
  branch protection. The polling workflow can stay or be retired; both
  work.
- **A required check is renamed or added** — update `REQUIRED_CHECKS` in
  the workflow.
- **Dependabot's `fetch-metadata` action changes its `update-type` output
  values** — update the patch/minor guard in the workflow.
- **Github changes the Free-plan Branch Protection behaviour** — re-test
  whether saving a Branch Protection rule starts enforcing on private repos.
- **A polling timeout fires** — investigate why; the 15-minute default
  is generous (CI today runs in ~2 min). Persistent timeouts suggest a
  CI-runner queue problem or a misnamed required check.
