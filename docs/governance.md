# Governance

This document covers how the project accepts inbound contributions and where work happens. Decisions locked in [#199](https://github.com/mainion-ai/memory-kernel-dev/issues/199) parts (d) and (e).

---

## Repository layout

The project lives in two repositories:

- **`mainion-ai/memory-kernel`** (public) — npm publish source. Receives synced releases from the dev repo via the workflow in [#194](https://github.com/mainion-ai/memory-kernel-dev/issues/194). Public face of the project; where external contributors land.
- **`mainion-ai/memory-kernel-dev`** (private) — where day-to-day development happens. Per-PR plans, internal tooling, privacy filters, full commit history.

Releases flow public-ward only. Bug reports and feature requests can flow either direction depending on where they're filed.

---

## Where to file issues and PRs

### External contributors

**File on the public repo** (`mainion-ai/memory-kernel`). The maintainer triages there.

- Bug reports → public `/issues/new` (pick the bug-report template).
- Feature requests → public `/issues/new` (pick the feature-request template).
- Open-ended questions → public `/discussions`.
- Security vulnerabilities → see [`SECURITY.md`](../SECURITY.md). Do **not** file on the public tracker.
- PRs → public `/pulls`. See the *Pull requests against public main* note below.

### Maintainer / collaborators

Development work happens on `memory-kernel-dev`. Issues filed by the maintainer for internal tracking go there. Per-PR plans, design discussions, and sprint planning all stay on the dev side. Items relevant to external visibility get a corresponding public-side issue.

### Cross-repo linking

When a public issue maps to internal work, the maintainer opens a tracking issue on `memory-kernel-dev` with a link back. The public-side issue stays open until the work ships; resolution comments link the merge commit on dev and (after sync) the released tag on public.

---

## Triage doctrine

### First response

The maintainer targets a first response within **a few business days** of an issue or PR being filed on public. This is a target, not a contract — solo maintainer, single-timezone — but it's the working norm.

### Bug reports

1. Acknowledge on public. Confirm enough information to reproduce.
2. If reproducible: open a tracking issue on dev (with a link back), label the public issue `confirmed`, and proceed with the fix on dev.
3. Fix ships through the normal dev → sync → public release pipeline. The public issue closes when the fix lands on a synced tag.

### Feature requests

1. Acknowledge on public. Either accept, defer, or close-as-out-of-scope with a one-line rationale.
2. If accepted: open a tracking issue on dev, link both ways, ship via the normal pipeline.
3. If deferred: leave the public issue open with a clear "would consider PRs that..." note.

### Pull requests against public main

**External PRs against public are not merged directly.** The architecture in [#194](https://github.com/mainion-ai/memory-kernel-dev/issues/194) makes public main a synced-only branch (see [`public-repo-settings.md`](public-repo-settings.md)); merging an external PR there would either fight the sync workflow on the next release or get clobbered.

If an external contributor opens a PR against public:

1. Maintainer reviews on public.
2. If the change is good, maintainer manually applies the patch to a `memory-kernel-dev` branch (with author attribution preserved via `git commit --author`).
3. The dev-side PR follows the normal review + merge flow.
4. The public PR is closed with a link to the dev branch / merge commit and a credit note.
5. Contribution ships in the next synced release.

This adds friction the maintainer eats — it doesn't ask the contributor to navigate the dev repo. The CONTRIBUTING.md note flags this so contributors aren't surprised.

For trivial typo fixes, the maintainer may apply the patch by hand in dev and close the public PR with a thanks — judgment call per PR.

---

## Contributor licensing — no CLA, no DCO

The project is licensed under [Apache License 2.0](../LICENSE). Contributions are accepted under the same license.

### What this means

- **No separate CLA** to sign. By submitting a PR you assert that you have the right to license your contribution under Apache-2.0 — that's the standard inbound-licensing convention for permissive open-source projects.
- **No DCO sign-off** required. `git commit -s` is welcomed but not enforced.
- The CONTRIBUTING.md "By contributing to memory-kernel you agree that your contributions will be licensed under the Apache License 2.0" sentence is the inbound-licensing grant we rely on. Apache-2.0 §5 (Submission of Contributions) backs this directly.

### Why not DCO

DCO (Developer Certificate of Origin, the Linux kernel's lightweight CLA-equivalent) is designed for projects where contributor identity provenance matters at the foundation-governance level (CNCF, Linux Foundation). For a solo-maintained Apache-2.0 project, the friction of every contributor having to remember `-s` outweighs the audit benefit.

### Why not full CLA

Full CLAs are enterprise tooling for projects that anticipate **relicensing**, **dual-licensing**, or **patent prosecution** scenarios. None of those apply here.

### When this might change

If the project's governance changes — foundation transfer, corporate co-maintainer, dual-licensing — the stance gets re-evaluated. DCO can be added on top non-disruptively (an existing PR backlog doesn't need to sign anything retroactively because the inbound grant already happened under Apache-2.0).

---

## Code of Conduct

The project follows the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/), version 2.1, by default. A `CODE_OF_CONDUCT.md` file in the repo will be added if/when the project draws enough inbound traffic that the implicit reference isn't sufficient.

Reports of unacceptable behaviour: same channel as `SECURITY.md` (`mainion@proton.me`).

---

## Disagreements with these doctrines

This document captures the maintainer's current call on triage and licensing. If you'd like to propose a change — DCO sign-off, different triage flow, etc. — open a discussion on the public repo. Governance changes get the same review weight as code changes.
