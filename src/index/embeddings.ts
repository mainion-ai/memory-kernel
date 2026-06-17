/**
 * Embedding (vector) storage + retrieval for semantic KNN (#368).
 * All handles come from the shared connection cache in `./connection.js`.
 */

import { openIndex, indexExists } from './connection.js';

/**
 * Store an embedding vector for an atom.
 */
export function storeEmbedding(
  memoryDir: string,
  atomId: string,
  embedding: Buffer,
  model: string,
  dimensions: number,
  bodyHash: string,
  normalized: boolean = true,
): void {
  const db = openIndex(memoryDir);
  db.prepare(`
    INSERT OR REPLACE INTO atom_embeddings (atom_id, embedding, model, dimensions, body_hash, normalized)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(atomId, embedding, model, dimensions, bodyHash, normalized ? 1 : 0);
}

/** Maximum embeddings to load for in-memory KNN. Beyond this, warn and truncate. */
const MAX_EMBEDDINGS_FOR_KNN = 10_000;

/**
 * Get all embeddings for semantic search.
 * Returns atom_id + raw embedding buffer for KNN.
 *
 * NOTE: Loads vectors into memory. At 512-dim (2KB/vector), 10K atoms ≈ 20MB.
 * For 1536-dim (OpenAI), 10K atoms ≈ 60MB. Capped at MAX_EMBEDDINGS_FOR_KNN
 * to prevent memory issues. Consider sqlite-vss for larger stores.
 */
export function getAllEmbeddings(memoryDir: string): { atom_id: string; embedding: Buffer; normalized: boolean }[] | null {
  if (!indexExists(memoryDir)) return null;

  try {
    const db = openIndex(memoryDir);
    const count = (db.prepare('SELECT COUNT(*) as c FROM atom_embeddings').get() as { c: number }).c;
    if (count === 0) return null;

    if (count > MAX_EMBEDDINGS_FOR_KNN) {
      console.warn(
        `⚠ ${count} embeddings exceed KNN limit (${MAX_EMBEDDINGS_FOR_KNN}). ` +
        `Only the ${MAX_EMBEDDINGS_FOR_KNN} most recent will be used for semantic search. ` +
        `Consider sqlite-vss for larger stores.`,
      );
    }

    // Exclude SECRET/PERSONAL atoms from the graph-boost / KNN candidate set,
    // mirroring the same filter applied in queryIndex. NULL classification
    // (pre-classification atoms) stays visible. The COUNT(*) above is
    // intentionally unfiltered — it warns on total index size, not on
    // visible-result size.
    const rows = db.prepare(
      `SELECT e.atom_id, e.embedding, e.normalized
       FROM atom_embeddings e
       JOIN atoms a ON a.atom_id = e.atom_id
       WHERE a.classification IS NULL OR a.classification NOT IN ('SECRET', 'PERSONAL')
       ORDER BY e.rowid DESC
       LIMIT ${MAX_EMBEDDINGS_FOR_KNN}`,
    ).all() as { atom_id: string; embedding: Buffer; normalized: number }[];

    // Lazy migration: normalize any row with normalized=0 and write back.
    // This pays a one-time cost per legacy vector and lets the KNN hot loop
    // in src/recall.ts assume unit-norm storage going forward.
    const update = db.prepare('UPDATE atom_embeddings SET embedding = ?, normalized = 1 WHERE atom_id = ?');
    const out: { atom_id: string; embedding: Buffer; normalized: boolean }[] = [];
    const writeBacks: { id: string; buf: Buffer }[] = [];

    for (const r of rows) {
      if (r.normalized === 1) {
        out.push({ atom_id: r.atom_id, embedding: r.embedding, normalized: true });
        continue;
      }
      const f32 = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4);
      let norm = 0;
      for (let i = 0; i < f32.length; i++) norm += f32[i] * f32[i];
      norm = Math.sqrt(norm);
      const normalized = new Float32Array(f32.length);
      if (norm > 0) {
        for (let i = 0; i < f32.length; i++) normalized[i] = f32[i] / norm;
      }
      const buf = Buffer.from(normalized.buffer);
      out.push({ atom_id: r.atom_id, embedding: buf, normalized: true });
      writeBacks.push({ id: r.atom_id, buf });
    }

    if (writeBacks.length > 0) {
      const tx = db.transaction(() => {
        for (const w of writeBacks) update.run(w.buf, w.id);
      });
      tx();
    }

    return out;
  } catch {
    return null;
  }
}

/**
 * Check if an atom's embedding is stale (body changed since embedding was computed).
 */
export function isEmbeddingStale(memoryDir: string, atomId: string, currentBodyHash: string): boolean {
  if (!indexExists(memoryDir)) return true;

  try {
    const db = openIndex(memoryDir);
    const row = db.prepare('SELECT body_hash FROM atom_embeddings WHERE atom_id = ?').get(atomId) as {
      body_hash: string;
    } | undefined;
    if (!row) return true;
    return row.body_hash !== currentBodyHash;
  } catch {
    return true;
  }
}

/**
 * Bulk-load all (atom_id, body_hash) pairs for staleness detection.
 * Returns a Map for O(1) lookup in tight loops.
 *
 * Use this in batch paths (mk reindex --embed, embedAllAtoms) instead of
 * calling isEmbeddingStale once per atom — the per-atom path issues N
 * SELECT round-trips; this issues one.
 */
export function getAllEmbeddingHashes(memoryDir: string): Map<string, string> | null {
  if (!indexExists(memoryDir)) return null;

  try {
    const db = openIndex(memoryDir);
    const rows = db.prepare('SELECT atom_id, body_hash FROM atom_embeddings').all() as {
      atom_id: string;
      body_hash: string;
    }[];
    const map = new Map<string, string>();
    for (const r of rows) map.set(r.atom_id, r.body_hash);
    return map;
  } catch {
    return null;
  }
}

/**
 * Get embedding stats.
 */
export function embeddingStats(memoryDir: string): { count: number; model: string | null } | null {
  if (!indexExists(memoryDir)) return null;

  try {
    const db = openIndex(memoryDir);
    const count = (db.prepare('SELECT COUNT(*) as c FROM atom_embeddings').get() as { c: number }).c;
    const modelRow = db.prepare('SELECT model, COUNT(*) as cnt FROM atom_embeddings GROUP BY model ORDER BY cnt DESC LIMIT 1').get() as { model: string; cnt: number } | undefined;
    return { count, model: modelRow?.model ?? null };
  } catch {
    return null;
  }
}
