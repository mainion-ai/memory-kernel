# Project invariants

Short list of properties that hold project-wide. Code, tests, and docs all rely on these; violations are bugs.

---

## 1. Files are the source of truth; the index is a derived cache

Atom markdown files under `ENTITIES/`, `DECISIONS/`, `CONSTRAINTS/`, `BELIEFS/`, `QUESTIONS/`, `PROCEDURES/`, `PREFERENCES/`, and `FACTS/`, plus the `events.ndjson` event log, the `triples.ndjson` entity-triple sidecar (see §2), and the per-session files under `EPISODES/`, are the durable, authoritative state. Everything else — the SQLite index at `.memory-index.db`, the rendered views in `INDEX.md` / `DECISIONS.md` / `CONSTRAINTS.md` / `OPEN_QUESTIONS.md` / `HANDOFF.md`, and the rendered `CLAUDE.md` — is a derived cache rebuildable from the files.

| Layer | Source of truth? | How to rebuild |
|---|---|---|
| Atom markdown files | yes | irrecoverable if deleted (unless the event log still has the create event — then `mk replay`) |
| `events.ndjson` | yes (for mutation history) | not rebuildable from files alone |
| `EPISODES/*.md` | yes (per-session summaries) | not rebuildable from atoms |
| `.memory-index.db` — most tables | **no, derived** | `mk reindex -d <dir>` |
| `INDEX.md` / `DECISIONS.md` / `CONSTRAINTS.md` / `OPEN_QUESTIONS.md` / `HANDOFF.md` | **no, derived** | `mk reflect -d <dir>` |
| Rendered `CLAUDE.md` | **no, derived** | `mk render -d <dir>` |

The practical consequence: deleting `.memory-index.db` and the rendered views never loses data — `mk reindex` and `mk reflect` reconstruct them from the atom files. Deleting atom files **does** lose data unless the event log retains the corresponding `atom_created` / `atom_updated` events, in which case `mk replay` reconstructs them.

## 2. `entity_triples` — durable via the `triples.ndjson` sidecar

The `entity_triples` table in `.memory-index.db` (added in #75 for Tier-1 semantic conflict detection) is LLM-extracted at atom-write time and is deliberately **not** serialized into the atom markdown frontmatter or body. It is therefore not rebuildable from the atom files alone.

Its durable source of truth is instead the **`triples.ndjson` sidecar** at the store root (`src/triples-sidecar.ts`, #370), parallel to `events.ndjson`: `insertTriples` mirrors every row there, so the file is a complete on-disk record of all triples independent of the SQLite index. `mk reindex` rebuilds the table from it. This keeps the "index is a derived cache" framing whole — `entity_triples` is no longer an exception; it is derived from the sidecar rather than from the atom markdown.

**Reindex mechanics.** Within a single `mk reindex` the existing rows are still snapshotted into a `_saved_triples` TEMP table and restored (fast path). The sidecar is then reconciled to match the rebuilt table — which also **backfills** pre-#370 stores that have table triples but no sidecar yet, and **prunes** triples whose atom no longer exists. When the snapshot is empty because `.memory-index.db` was deleted outright, reindex **recovers** the triples from the sidecar for atoms that still exist.

**No longer a data-loss failure mode.** Deleting `.memory-index.db` and running `mk reindex` now restores all triples from the sidecar; semantic-conflict detection no longer silently degrades. (Pre-#370 stores must run `mk reindex` once after upgrading to create the sidecar from their existing table.)

**Why a sidecar rather than frontmatter.** Triples are write-time analysis output, not user-edited content; storing them in frontmatter would couple atom serialization to whatever LLM extractor is in use and ripple into canonicalization, doctor checks, and the privacy scanner. The sidecar keeps the atom file format stable while still making triples disk-durable. See [#174](https://github.com/mainion-ai/memory-kernel-dev/issues/174) and [#370](https://github.com/mainion-ai/memory-kernel-dev/issues/370) for the project history.

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
