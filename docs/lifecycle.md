# Atom lifecycle

How an atom moves through statuses, when it auto-promotes, what its tags mean, and which states surface in recall. The companion [contracts.md](contracts.md) has the at-a-glance draft-visibility matrix; this page is the reasoning behind it.

## Status state machine

```
            ┌─────────────────────────────────────────────┐
            ▼                                             │ (mk supersede)
  created ──▶ draft ──promote──▶ active ──supersede──▶ superseded
              │  (mk reflect /            │
              │   mk consolidate)         ├──TTL expiry──▶ expired
              │                           └──archive─────▶ archived
              └──(belief default; held for review)
```

| Status | Meaning | Surfaces in recall/render? |
|---|---|---|
| `draft` | Proposed, not yet vetted. **belief**/**open_question** and `mk extract` output start here. | Hand-authored: **yes**. Auto-extracted (`auto-extracted` tag): **no** (opt in with `--include-drafts`). |
| `active` | Vetted, in force. The normal state. | Yes. |
| `superseded` | Replaced by a newer atom (via `mk supersede <old> <new>`, which adds a `supersedes` relation on the new atom). | **No** — excluded from default recall, but **kept on disk** for audit/history. Re-surfaces only via `--as-of` time-travel or explicit history queries. |
| `archived` | Manually retired (still true historically, no longer in force). | No (kept on disk). |
| `expired` | Past its `ttl_days`; aged out by `mk reflect`. | No (kept on disk). |

**superseded vs archived vs obsolete:** `superseded` means *a specific newer atom replaces this one* (the supersede relation records which). `archived` means *retired with no designated replacement*. There is no `obsolete` status — older stores that used it are migrated to `archived` by the `schema-migrations` doctor check. Supersede is a **supervised** operation (an agent proposes it; it's applied deliberately), never automatic.

## Tiered auto-promotion (`mk reflect`)

`mk reflect` promotes eligible **draft** atoms to **active** — status-only, the atom's *type* never changes (no belief→fact rewrite; that rule was retired in v1.30.0). The gate is per-type:

| Type | Promotes when… | Rationale |
|---|---|---|
| `open_question` | immediately (no age/confidence gate) | additive, no quality risk |
| `fact`, `preference`, `decision` | age ≥ **48h** AND confidence ≥ **0.7** AND no contradiction with an active atom of the same type/scope | settles after a cooling-off period |
| `procedure` | **`executed_at` is set** (confirmed run via `mk execute <id>` or the session-end extractor) AND confidence ≥ **0.7** AND no contradiction (#309) | a procedure is trustworthy once it has actually run, not as written |
| `belief` | never auto-promotes — held for explicit review (`mk consolidate`) | over-produced + re-extraction drift |
| others (`constraint`, `entity_summary`, `conflict`) | not extract-produced; held | — |

On promotion: `status` → `active`, the `auto-extracted` tag is stripped, and an `atom_promoted` event is emitted. `mk consolidate` lets you review and promote drafts of any type by hand.

## Tag semantics

Tags are **single hyphen-separated tokens** (no whitespace — a whitespace tag is one opaque token that breaks FTS tag queries; `mk doctor`'s `tag-format` check and `mk remember` both flag it, #262). Most tags are free-form scope labels, but a few carry meaning:

| Tag | Meaning |
|---|---|
| `auto-extracted` | **Reserved** (`AUTO_EXTRACTED_TAG`). Stamped by `mk extract` on session-end drafts; gates draft visibility (see the matrix in [contracts.md](contracts.md)) and is stripped on promotion. Don't apply it by hand. |
| `session-loop`, `lifecycle`, `agent-setup`, `constraints` | Applied by the lifecycle seed set (`mk seed --lifecycle`); the `seed-set-freshness` doctor check (#330) keys on `session-loop`. |

No tag changes recall *weighting* directly; recall weighting is by atom **type** (see [`DEFAULT_TYPE_WEIGHTS`](../src/schema.ts)) and confidence/recency, not tags.

## Hand-authored vs auto-extracted drafts

Both have `status: draft`, but they behave differently in recall — the distinction is the **`auto-extracted` tag**, not the status:

- **Hand-authored draft** (you ran `mk remember -t belief …`, or wrote a draft atom file): **surfaces in recall and render immediately.** Vetting is your judgment call; nothing hides it.
- **Auto-extracted draft** (`mk extract` output, tagged `auto-extracted`): **excluded** from recall and render until `mk reflect`/`mk consolidate` promotes it — opt in with `--include-drafts` / `include_drafts: true` / the `mk_recall` `include_drafts` param.

This is why a belief you typed yourself shows up right away while an LLM-extracted draft doesn't: the gate is the tag, deliberately, so machine output is vetted before it influences context but your own notes aren't second-guessed.
