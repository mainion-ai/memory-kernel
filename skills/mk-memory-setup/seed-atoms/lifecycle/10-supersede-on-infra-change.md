# Supersede Capability Atoms In The Same Change As The Infra Change

When infrastructure changes — a new flag, a new provider, a newly-installed binary, a config that flips a capability on or off — **supersede the affected capability atoms in the same change**, not "later."

A stale capability atom doesn't sit harmlessly; it *actively sabotages* the rollout. An atom that says "embeddings are not configured" or "recall is FTS-only" will be recalled with full confidence after you've just enabled embeddings, and it will steer you (or the next agent) back into the old behavior — the exact failure that wasted a fleet day.

**The discipline:**
- Flip a capability (enable embeddings, add a flag, upgrade the binary) → immediately write the new-reality atom and `mk supersede <old-atom-id> <new-atom-id>` to retire the stale one (supersede takes both the old and the new atom IDs).
- Treat capability atoms as part of the infra's surface area: changing the infra without updating its atoms is an incomplete change, like editing code without updating its tests.
- After the change, recall the capability area and confirm no surviving atom contradicts the new state (`mk doctor` won't catch a stale *belief* — you must).

**Heuristic:** if a change makes any existing atom false, that atom is part of the change. Don't leave it for a future cleanup pass.
