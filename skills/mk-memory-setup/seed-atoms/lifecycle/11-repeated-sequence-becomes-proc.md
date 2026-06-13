# Every Repeated Action Sequence Becomes A Procedure Atom

The moment you do a multi-step sequence for the **second** time, capture it as a `procedure` atom. Never bury a procedure inside a belief body, an episode summary, or your own context — write it as a typed, recallable `procedure`.

Procedures are how competence compounds. A sequence narrated inside a belief ("I think the way to redeploy is …") is not recallable as an action: it won't surface when you next need to *do* the thing, it can't be superseded cleanly when the steps change, and the next agent inherits prose, not a runbook.

**Apply when:**
- You repeat a command sequence (sync, deploy, recover, validate) → `mk remember -t procedure --slug <verb-noun>` with the ordered steps.
- You catch yourself writing "the way to X is …" inside a belief or fact → extract it into a procedure and relate the belief to it instead.
- A teammate/agent asks "how do I X" and the answer is steps → that answer is a procedure atom, not a chat reply.

**Why typed matters:** `procedure` is weighted for operational recall, supersedes cleanly when the steps change, and is what `mk render` surfaces as actionable. A belief that contains hidden steps is a procedure that will never be found when it's needed.
