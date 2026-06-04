# Project invariants

Short list of properties that hold project-wide. Code, tests, and docs all rely on these; violations are bugs.

---

## 1. Files are the source of truth; the index is a derived cache

Atom markdown files under `ENTITIES/`, `DECISIONS/`, `CONSTRAINTS/`, `BELIEFS/`, `QUESTIONS/`, `PROCEDURES/`, `PREFERENCES/`, and `FACTS/`, plus the `events.ndjson` event log and the per-session files under `EPISODES/`, are the durable, authoritative state. Everything else — the SQLite index at `.memory-index.db`, the rendered views in `INDEX.md` / `DECISIONS.md` / `CONSTRAINTS.md` / `OPEN_QUESTIONS.md` / `HANDOFF.md`, and the rendered `CLAUDE.md` — is a derived cache rebuildable from the files.

| Layer | Source of truth? | How to rebuild |
|---|---|---|
| Atom markdown files | yes | irrecoverable if deleted (unless the event log still has the create event — then `mk replay`) |
| `events.ndjson` | yes (for mutation history) | not rebuildable from files alone |
| `EPISODES/*.md` | yes (per-session summaries) | not rebuildable from atoms |
| `.memory-index.db` — most tables | **no, derived** | `mk reindex -d <dir>` |
| `INDEX.md` / `DECISIONS.md` / `CONSTRAINTS.md` / `OPEN_QUESTIONS.md` / `HANDOFF.md` | **no, derived** | `mk reflect -d <dir>` |
| Rendered `CLAUDE.md` | **no, derived** | `mk render -d <dir>` |

The practical consequence: deleting `.memory-index.db` and the rendered views never loses data — `mk reindex` and `mk reflect` reconstruct them from the atom files. Deleting atom files **does** lose data unless the event log retains the corresponding `atom_created` / `atom_updated` events, in which case `mk replay` reconstructs them.

## 2. Exception — `entity_triples` is not derivable from files

The `entity_triples` table in `.memory-index.db` (added in #75 for Tier-1 semantic conflict detection) is the one part of the index that is **not** rebuildable from atom markdown. Triples are LLM-extracted at atom-write time inside `createAtom()` / `updateAtom()` and are deliberately not serialized into the atom frontmatter or body — only the SQLite row exists on disk.

To preserve triples across a normal `mk reindex` run, the routine snapshots the existing `entity_triples` rows into a `_saved_triples` TEMP table, rebuilds the schema, and restores the snapshot at the end (see `src/index-db.ts:reindex`). This is the mechanism that lets the otherwise-derived-cache framing continue to hold for the rest of the index.

**Failure mode.** Deleting `.memory-index.db` outright (rather than running `mk reindex`, which preserves the snapshot in-process) discards entity triples **permanently** for every atom that has not since been re-extracted. There is no on-disk source to rebuild them from. Re-extraction only happens on the next `createAtom` / `updateAtom` for the affected atom; semantic-conflict detection on existing atoms silently degrades until then.

**Why this is the design.** Triples are write-time analysis output, not user-edited content, and storing them in frontmatter would couple atom serialization to whatever LLM extractor happens to be in use. The trade-off is the failure mode above, accepted as a known cost.

**Pointer for future work.** If triples are ever serialized into atom frontmatter (closing the exception), update this document and the header block in `src/index-db.ts`. See [#174](https://github.com/mainion-ai/memory-kernel-dev/issues/174) for the project history of this decision.

## 3. Exception (minor) — `atom_embeddings` is derivable but expensive

The `atom_embeddings` table is technically derivable from atom bodies — `mk reindex --embed` rebuilds it by re-calling the configured embedding provider. In practice the reindex routine preserves it via the same temp-table snapshot pattern as `entity_triples` because re-running the embedding provider for every atom is slow and (depending on provider) chargeable. This is a performance choice, not an information-loss exception: deleting `.memory-index.db` does not lose embeddings *permanently*, only forces a paid recompute on the next `mk reindex --embed`.

---

## Where this invariant shows up

These sites all state some form of "files are truth, index is cache" and should link here rather than re-deriving the rules:

- `CONTRIBUTING.md` — Code Style section
- `README.md` — "Why this design" and "Troubleshooting" sections
- `docs/migration.md` — closing line and per-version migration notes
- `docs/agent-quickref-native.md` and `docs/agent-quickref-container.md` — schema-upgrade subsections
- `docs/host-integration-doctrine.md` — layer primacy bullets (related but distinct concern: which *layer* owns a piece of knowledge, not which *file* is canonical)
- `scripts/activate-memory.ts` — DECI-FILE-FIRST atom body
- `src/index-db.ts` — header comment block
