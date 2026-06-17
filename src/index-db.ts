/**
 * SQLite index for fast atom lookups — re-export facade (#368).
 *
 * Files remain the source of truth for most of this index — it is a derived
 * cache. If the index is stale or missing, fall back to file scan (listAtoms).
 * Rebuild with `mk reindex`.
 *
 * `entity_triples` (#75, Tier-1 semantic conflict detection) is LLM-extracted
 * at atom-write time and is NOT serialized into the atom markdown body, so it
 * has no source in the markdown to rebuild from. Its durable source of truth is
 * instead the `triples.ndjson` sidecar (`src/triples-sidecar.ts`, #370):
 * `insertTriples` mirrors every row there, and `reindex()` rebuilds the table
 * from it — so deleting `.memory-index.db` no longer loses triples. Within a
 * single reindex the existing rows are still snapshotted into a `_saved_triples`
 * TEMP table for speed; the sidecar is then reconciled to match (and recovered
 * from when the snapshot is empty because the DB was deleted). See `reindex()`
 * in `./index/indexing.ts`.
 *
 * Embeddings (`atom_embeddings`) are still preserved only via the `_saved_*`
 * snapshot — they are derivable from atom bodies but expensive to recompute, so
 * deleting the index forces re-embedding (an API cost, not data loss).
 *
 * The project-wide statement of this invariant (files are truth, index is
 * derived cache; `entity_triples` is durable via the `triples.ndjson` sidecar)
 * lives in `docs/invariants.md`. Update both this header and that document
 * together.
 *
 * --- Module layout (#368) ---
 * This file was split into internal modules under `src/index/`; it now just
 * re-exports them so every importer (and the public barrel `src/index.ts`) keeps
 * importing from `./index-db.js` unchanged:
 *   - `index/connection.ts` — owns the single SQLite connection cache + schema +
 *      lifecycle (`openIndex`/`closeIndex`/`closeAllIndexes`/`indexExists`).
 *   - `index/indexing.ts`   — atoms-table write/read (`reindex`/`indexAtom`/
 *      `removeFromIndex`/`queryIndex`/`indexStats`/`getAllAtomIds`).
 *   - `index/embeddings.ts` — embedding storage/retrieval for KNN.
 *   - `index/fts.ts`        — atom + episode full-text search and term-frequency helpers.
 *   - `index/relations.ts`  — typed graph-edge reads/writes.
 * The connection cache lives in exactly one place (`connection.ts`); every other
 * module obtains its handle from there, so reads and writes always share state.
 */

export { openIndex, closeIndex, closeAllIndexes, indexExists } from './index/connection.js';
export {
  reindex,
  indexAtom,
  removeFromIndex,
  queryIndex,
  indexStats,
  getAllAtomIds,
} from './index/indexing.js';
export type { IndexQueryResult } from './index/indexing.js';
export {
  storeEmbedding,
  getAllEmbeddings,
  isEmbeddingStale,
  getAllEmbeddingHashes,
  embeddingStats,
} from './index/embeddings.js';
export {
  searchFts,
  getTermDocumentFrequencies,
  getAtomsMatchingTerm,
  getCorpusSize,
  indexEpisode,
  removeEpisodeFromIndex,
  searchEpisodeFts,
} from './index/fts.js';
export { getRelationsForAtom, addRelation, getAllRelations } from './index/relations.js';
export type { AtomRelation } from './index/relations.js';
