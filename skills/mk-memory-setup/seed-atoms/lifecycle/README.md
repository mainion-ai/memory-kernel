# Lifecycle Seed Atoms

These 11 files are the bodies of the memory-kernel lifecycle atoms that `/mk-memory-setup` seeds during agent bootstrap. They turn the agent's own operating manual (`docs/agent-session-loop.md`) into typed, recallable memory so the agent's lifecycle is part of memory-kernel itself, not an out-of-band doc reference.

## Files

| File | Atom type | Slug | Tags |
|------|-----------|------|------|
| `01-session-start.md` | `procedure` | `session-start-procedure` | `session-loop, lifecycle, agent-setup` |
| `02-during-session.md` | `procedure` | `during-session-procedure` | `session-loop, lifecycle, agent-setup` |
| `03-session-end.md` | `procedure` | `session-end-procedure` | `session-loop, lifecycle, agent-setup` |
| `04-every-5-sessions.md` | `procedure` | `every-5-sessions-procedure` | `session-loop, lifecycle, agent-setup` |
| `05-maintenance-cadence.md` | `procedure` | `maintenance-cadence-procedure` | `session-loop, lifecycle, agent-setup` |
| `06-a2a-handoff.md` | `procedure` | `a2a-handoff-procedure` | `session-loop, lifecycle, agent-setup` |
| `07-diagnostics.md` | `procedure` | `diagnostics-procedure` | `session-loop, lifecycle, agent-setup` |
| `08-what-not-to-do.md` | `constraint` | `session-loop-pitfalls` | `session-loop, constraints, agent-setup` |
| `09-verify-memory-claims.md` | `procedure` | `verify-memory-claims-procedure` | `session-loop, lifecycle, agent-setup` |
| `10-supersede-on-infra-change.md` | `procedure` | `supersede-on-infra-change-procedure` | `session-loop, lifecycle, agent-setup` |
| `11-repeated-sequence-becomes-proc.md` | `procedure` | `repeated-sequence-procedure` | `session-loop, lifecycle, agent-setup` |

## Why split, not one big atom

- **Per-task recall.** *"How do I do A2A handoff?"* surfaces only the A2A atom — not 270 lines of unrelated lifecycle prose.
- **Type weights matter.** The "What Not To Do" section is genuinely a set of hard rules — it belongs as a `constraint` (1.5× recall weight + reserved token budget), not buried inside a procedure.
- **Wander quality.** Granular atoms with distinct tags activate independently in spreading activation; a single monolithic atom degenerates into a hub.

## Source of truth

These files mirror the corresponding sections of [`docs/agent-session-loop.md`](../../../../docs/agent-session-loop.md). When the doc is updated, update the matching seed file (and vice versa). A pre-publish lint check could be added to verify they don't drift; for now, treat the doc as canonical.

## Seeding

The bundled `../seed-lifecycle.sh` script reads each file in this directory and creates an atom via `npx mk remember`. Run it from anywhere with the memory directory as the only argument:

```bash
bash <skill-dir>/seed-atoms/seed-lifecycle.sh ~/mk-memory
```

Verify after seeding:

The seeder reports its own reconciliation summary (created / updated / unchanged / deduped). A dry re-run confirms idempotency:

```bash
npx mk seed --lifecycle -d ~/mk-memory --dry-run
# Expected on a correctly-seeded store: 11 unchanged, 0 created/updated/deduped
```

## Re-seeding after a section edit (#329)

`mk seed --lifecycle` (which `seed-lifecycle.sh` delegates to) is **idempotent** — just re-run it after editing any section file:

```bash
# Refresh after editing one or more lifecycle/*.md bodies — no manual archiving needed.
bash <skill-dir>/seed-atoms/seed-lifecycle.sh ~/mk-memory
#   • unchanged sections: no-op
#   • edited section:     old atom superseded in place, new one created (1 active per slug)
#   • pre-existing dupes: collapsed to a single active atom per slug

# Re-render so the consuming host picks up the new content
npx mk render ~/mk-memory <path-to-CLAUDE.md-or-equivalent>
```

Atoms are matched on the stable **slug segment** of their id (e.g. `session-start-procedure`), which both legacy and freshly-seeded atoms carry, so re-seeding never leaves duplicates — you no longer need to move stale files to `ARCHIVE/` by hand. Superseded versions stay on disk for audit and are excluded from recall.
