# During Session

## Write atoms as you learn things

```bash
# A verified fact
mk remember "The deploy pipeline takes ~4 minutes end-to-end" \
  -d {dir} -t fact --tags infrastructure,deploy

# A decision with rationale
mk remember "Use cursor pagination — offset pagination breaks under concurrent writes" \
  -d {dir} -t decision --tags api,performance

# An unverified hypothesis — beliefs are held in draft for explicit review, not auto-promoted
mk remember "The cache layer may reduce p99 by ~40% — untested" \
  -d {dir} -t belief --confidence 0.5 --tags performance,cache

# A stable user preference
mk remember "Operator approves infrastructure changes with a single word, no spec required" \
  -d {dir} -t preference --tags workflow,communication
```

**Do not write:** ephemeral task status, file contents, easily re-discovered info, or conversation small talk. Atoms persist — write only what is worth carrying forward.

## Create relation edges when you see connections

This step is the most commonly skipped. Skipping it starves the relation graph and degrades `mk wander` and `mk recall --graph` quality.

```bash
# When atom B extends or builds on atom A
mk relate BELI-2026-04-01-CACHE-HYPOTHESIS supports DECI-2026-03-15-USE-REDIS -d {dir}

# When new information supersedes old
mk relate FACT-2026-04-10-NEW-RATE-LIMIT supersedes FACT-2026-03-01-OLD-RATE-LIMIT -d {dir}

# When a belief contradicts another
mk relate BELI-2026-04-12-COUNTER-ARGUMENT contradicts BELI-2026-04-01-ORIGINAL-CLAIM -d {dir}
```

Relation types: `extends`, `contradicts`, `supports`, `caused_by`, `supersedes`, `applied_to`, `related`.

Check an atom's connections any time:
```bash
mk relations BELI-2026-04-01-CACHE-HYPOTHESIS -d {dir}
```

## Explore connections with wander

```bash
mk wander -d {dir} --tags philosophy,architecture --steps 5 --json
```

Run wander when exploring a new topic, when stuck, or during free time. Collisions in the output are atoms from different domains that activated together — these are worth investigating. No collisions means no unexpected connections were found; move on.

**Which tags to wander on:** Use the tags of the domain you're entering, or seed from a specific atom you just wrote. To audit an atom's neighbourhood rather than a domain, use `--seed`:

```bash
# Domain entry
mk wander -d {dir} --tags infrastructure,performance --steps 5 --json

# Specific atom neighbourhood
mk wander -d {dir} --seed BELI-2026-04-01-CACHE-HYPOTHESIS --steps 3 --json
```

**Session counting for the every-5-sessions rule:** one episode = one session. Check your episode count with `mk episodes -d {dir} --limit 1 --json` and track the cadence yourself, or keep a `preference` atom like `"Last reflect: 2026-04-19, next at session 5"` and update it after each reflect run.
