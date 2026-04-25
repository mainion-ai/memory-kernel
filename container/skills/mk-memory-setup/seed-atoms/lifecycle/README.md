# Lifecycle Seed Atoms

These eight files are the bodies of the memory-kernel lifecycle atoms that `/mk-memory-setup` seeds during agent bootstrap. They turn the agent's own operating manual (`docs/agent-session-loop.md`) into typed, recallable memory so the agent's lifecycle is part of memory-kernel itself, not an out-of-band doc reference.

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

## Why split, not one big atom

- **Per-task recall.** *"How do I do A2A handoff?"* surfaces only the A2A atom — not 270 lines of unrelated lifecycle prose.
- **Type weights matter.** The "What Not To Do" section is genuinely a set of hard rules — it belongs as a `constraint` (1.5× recall weight + reserved token budget), not buried inside a procedure.
- **Wander quality.** Granular atoms with distinct tags activate independently in spreading activation; a single monolithic atom degenerates into a hub.

## Source of truth

These files mirror the corresponding sections of [`docs/agent-session-loop.md`](../../../../docs/agent-session-loop.md). When the doc is updated, update the matching seed file (and vice versa). A pre-publish lint check could be added to verify they don't drift; for now, treat the doc as canonical and re-seed agents after edits via `mk remember --slug <slug>` (overwrites the existing atom).
