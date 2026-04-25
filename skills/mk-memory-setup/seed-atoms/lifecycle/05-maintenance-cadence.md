# Maintenance Cadence (Cron)

These commands run from the host's cron, not from inside the agent's session — but the agent should know the cadence exists and what each step does, so it can interpret freshly-appearing atoms or drift signals correctly.

## Nightly — 02:00

```bash
mk render {memory-dir} {path/to/CLAUDE.md}
```

Refreshes CLAUDE.md so the next session starts with current memory. This is the minimum viable cron job — without it, CLAUDE.md goes stale after the first session.

## Weekly — Sunday 03:00

Run in this order:

```bash
# 1. Validate store integrity and semantic health
mk doctor -d {dir} --json
mk lint -d {dir} --json

# 2. Check for constitutive drift and entanglement
mk closure -d {dir} --trajectory --json

# 3. Build concept-name citation index (feeds wander activation)
mk citations -d {dir}

# 4. Surface implicit atom-to-atom connections from body text
mk relink -d {dir} --apply

# 5. Promote auto-extracted drafts
mk consolidate -d {dir} --json

# 6. Consolidate and expire
mk reflect -d {dir}
mk gc -d {dir}

# 7. Re-render with fresh index
mk render {memory-dir} {path/to/CLAUDE.md}
```

**Why each step:**

| Command | Why |
|---|---|
| `mk doctor` | Catches schema errors, broken links, and conflicts before they compound. |
| `mk lint` | Semantic health: contradictions, stale atoms, orphans, near-duplicates, confidence drift, TTL warnings. |
| `mk closure --trajectory` | Measures entanglement % and belief %; entanglement > 5 % = constitutive drift risk; belief % > 80 % = diversify atom types. **What drift looks like from the outside:** the agent reasons in circles, over-references its own prior conclusions, and resists updating on new evidence. The closure metric catches this structurally before it becomes behaviourally obvious. |
| `mk citations` | Indexes concept-name references across atoms; feeds wander's activation scoring. Run **before** `mk relink` — citations builds the concept index (used by wander), relink creates explicit graph edges (used by recall). They are separate commands because you may want to update wander scoring without modifying the relation graph, or vice versa. |
| `mk relink --apply` | Finds atom-ID references in body text and creates explicit relation edges; builds the graph that `mk recall --graph` traverses. |
| `mk consolidate` | Promotes auto-extracted draft atoms to active after duplicate detection; completes the extract → consolidate lifecycle. |
| `mk reflect` | Dedup, expire, promote — weekly catch for anything the every-5-session run missed. |
| `mk gc` | Archive the atoms reflect marked expired. |
| `mk render` | Publish the clean, consolidated state to CLAUDE.md. |

## Weekly — Sunday 04:00 (only if Ollama is available)

```bash
mk enrich-relations -d {dir} --apply
```

Reclassifies generic `related` edges into specific typed relations using local LLM inference. Ollama-only because this runs weekly and making API calls for every edge would have ongoing cost; a local model makes it free to run on cadence. The task suits smaller models well — edge classification is constrained-vocabulary, not open-ended generation. Optional quality improvement, not required for correct operation.

## Monthly — 1st of month, 04:00

```bash
mk compact -d {dir}
```

Compacts the event log — keeps only the latest mutation per atom, removes intermediate events. Without monthly compact, the event log grows unbounded and `mk replay` and `mk merge` slow down. Does not affect atoms or the SQLite index.
