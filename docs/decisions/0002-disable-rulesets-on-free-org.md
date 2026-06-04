# ADR 0002 — Disable repository rulesets on private repo under Free GitHub org

**Status:** Accepted (partial amendment — see ADR 0003)
**Date:** 2026-05-05
**Issue:** —
**Supersedes:** —
**Amended by:** [ADR 0003](0003-workflow-side-dependabot-auto-merge.md) — corrects the closing recommendation that classic Branch Protection rules are the Free-plan replacement for Rulesets. They are not: classic Branch Protection also doesn't enforce on private repos under Free GitHub orgs (same Team/Enterprise paywall). The decision to disable Rulesets stands; the *replacement* path moved to workflow-side gating.

---

## Context

GitHub's **Rulesets** feature (Settings → Rules → Rulesets) is the modern
replacement for classic branch protection rules. It supports richer policies
(commit signing requirements, fine-grained bypass actor lists, push rules,
required deployments, etc.) and is configured at the org or repo level.

`mainion-ai/memory-kernel-dev` is a **private** repository owned by a
**Free** GitHub organization. GitHub surfaced this banner on the rulesets
page:

> Your rulesets won't be enforced on this private repository until you move
> to GitHub Team organization account.

This is by design in GitHub's plan matrix: rulesets enforce on private repos
only on **GitHub Team** (or higher). On Free orgs, rulesets enforce on
**public** repos only — on private repos they are stored but silently
non-functional. The classic **branch protection rules** feature remains
available on Free for private repos.

Keeping unenforced rulesets defined is worse than not having them: anyone
reading repo settings would assume the rules are blocking the listed
actions, when in fact pushes that violate them go through unchallenged.

## Options considered

### Option A — Keep rulesets defined, ignore the warning

**Pros:** zero work. Rulesets stay ready to flip on if we upgrade.

**Cons:** false sense of enforcement. A future contributor (or future-self)
sees "main: require pull request, block force-push" in Settings and assumes
those policies hold, when they do not. This is the worst of the options
from a safety-of-mental-model standpoint.

### Option B — Upgrade the org to GitHub Team

**Pros:** rulesets enforce; we get the more granular policy surface.

**Cons:** ~$4/user/month/seat for a solo/small-team dev repo. Not justified
for the current scale.

### Option C — Migrate to a personal account on GitHub Pro

**Pros:** $4/month flat (not per seat).

**Cons:** still costs money for the same outcome; loses org-level affordances
(teams, org-wide settings, transfer history). Not a meaningful improvement
over staying on the Free org.

### Option D — Make the repository public

Rulesets enforce on public repos in Free orgs.

**Pros:** zero monetary cost; rulesets functional.

**Cons:** exposes proprietary code. Out of scope for this decision.

### Option E — Disable rulesets, use classic branch protection where needed (chosen)

Delete the (non-functional) rulesets from Settings → Rules → Rulesets.
If specific guardrails are still wanted on `main` (block force-push,
require PR review, require status checks), reconstruct them as classic
**Branch protection rules** under Settings → Branches, which DO enforce
on private repos on the Free plan.

**Pros:** banner resolved; repo settings no longer mislead about what is
enforced; no spend; can still get the most-needed protections via the
classic feature.

**Cons:** classic rules have a smaller feature set than rulesets (no
fine-grained bypass actor lists, no commit-signing enforcement, no push
rules for blob size / file path patterns). For this repo's current needs,
the gap is acceptable.

## Decision

**Disabled all rulesets.** No replacement classic branch protection rules
have been added yet; `main` is currently unprotected at the GitHub side.
If/when we want enforcement (e.g., to prevent accidental force-push to
`main` after the public-sync workflow lands — see
[ADR 0001](0001-force-reset-public-main.md)), reach for classic Branch
protection rules under Settings → Branches.

## Consequences

- Settings page no longer asserts policies that aren't actually in effect.
- The GitHub banner ("rulesets won't be enforced…") is gone.
- Any prior ruleset configuration is lost — re-document the intended rules
  here before reinstating, so the intent survives independent of the
  GitHub UI state.
- If the org is ever upgraded to Team, revisit: rulesets become a real
  option again and the comparison vs classic rules tilts toward rulesets.

## Revisit triggers

- Org plan upgrade to Team or higher.
- A force-push incident on `main` (would justify at minimum a classic
  "block force-push" rule).
- Adding external collaborators who need different bypass policies than
  org members (rulesets' bypass-actor lists are the only way to express
  this).
