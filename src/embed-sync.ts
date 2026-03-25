/**
 * Synchronous embedding integration for memory-kernel.
 *
 * Since createAtom/indexAtom are synchronous but embedding APIs are async,
 * this module provides helpers that bridge the gap:
 *
 * - embedAtom() — async, call after createAtom/updateAtom
 * - embedAllAtoms() — async, used by mk reindex --embed
 * - semanticSearch() — sync, KNN over stored vectors
 */

import { getEmbeddingConfig, embedText, embedBatch, cosineSimilarity, serializeVector, deserializeVector, atomToEmbeddingText } from './embeddings.js';
import { storeEmbedding, getAllEmbeddings, isEmbeddingStale, indexExists } from './index-db.js';
import { listAtoms } from './store.js';
import { hashEvidence } from './evidence.js';
import type { Atom } from './types.js';

// --- Async embedding operations ---

/**
 * Embed a single atom and store the vector in the index.
 * No-op if embeddings are not configured or index doesn't exist.
 */
export async function embedAtom(memoryDir: string, atom: Atom): Promise<boolean> {
  const config = getEmbeddingConfig();
  if (!config) return false;
  if (!indexExists(memoryDir)) return false;

  const text = atomToEmbeddingText(
    atom.body,
    atom.frontmatter.scope?.tags,
    atom.frontmatter.type,
  );

  const bodyHash = contentHash(atom.body);

  // Skip if embedding is current
  if (!isEmbeddingStale(memoryDir, atom.frontmatter.id, bodyHash)) {
    return false;
  }

  try {
    const result = await embedText(text, config);
    storeEmbedding(
      memoryDir,
      atom.frontmatter.id,
      serializeVector(result.vector),
      result.model,
      result.vector.length,
      bodyHash,
    );
    return true;
  } catch (err) {
    // Degrade gracefully — log but don't throw
    if (process.env.DEBUG) {
      console.error(`⚠ Embedding failed for ${atom.frontmatter.id}:`, (err as Error).message);
    }
    return false;
  }
}

/**
 * Embed all atoms in a memory directory.
 * Skips atoms whose embeddings are already current (same body_hash).
 * Returns count of newly embedded atoms.
 */
export async function embedAllAtoms(
  memoryDir: string,
  opts?: { onProgress?: (done: number, total: number) => void },
): Promise<{ embedded: number; skipped: number; errors: number; timeMs: number }> {
  const start = Date.now();
  const config = getEmbeddingConfig();
  if (!config) {
    return { embedded: 0, skipped: 0, errors: 0, timeMs: 0 };
  }

  const atoms = listAtoms(memoryDir);
  let embedded = 0;
  let skipped = 0;
  let errors = 0;

  // Batch embedding for efficiency (up to 100 at a time)
  const BATCH_SIZE = 100;
  const toEmbed: { atom: Atom; text: string; hash: string }[] = [];

  for (const atom of atoms) {
    const hash = contentHash(atom.body);
    if (!isEmbeddingStale(memoryDir, atom.frontmatter.id, hash)) {
      skipped++;
      continue;
    }

    toEmbed.push({
      atom,
      text: atomToEmbeddingText(atom.body, atom.frontmatter.scope?.tags, atom.frontmatter.type),
      hash,
    });
  }

  // Process in batches
  for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
    const batch = toEmbed.slice(i, i + BATCH_SIZE);
    const texts = batch.map((b) => b.text);

    try {
      const results = await embedBatch(texts, config);

      for (let j = 0; j < results.length; j++) {
        const { atom, hash } = batch[j];
        const result = results[j];

        storeEmbedding(
          memoryDir,
          atom.frontmatter.id,
          serializeVector(result.vector),
          result.model,
          result.vector.length,
          hash,
        );
        embedded++;
      }
    } catch (err) {
      errors += batch.length;
      if (process.env.DEBUG) {
        console.error(`⚠ Batch embedding failed:`, (err as Error).message);
      }
    }

    opts?.onProgress?.(embedded + skipped + errors, atoms.length);
  }

  return { embedded, skipped, errors, timeMs: Date.now() - start };
}

// --- Semantic search ---

/**
 * Semantic search: embed a query text and find the most similar atoms.
 * Returns atom IDs with similarity scores, sorted by relevance.
 *
 * This is a hybrid operation:
 * - Query embedding: async (API call)
 * - KNN search: sync (in-memory cosine similarity over stored vectors)
 *
 * Returns null if embeddings are not available.
 */
export async function semanticSearch(
  memoryDir: string,
  queryText: string,
  limit = 20,
): Promise<{ atom_id: string; similarity: number }[] | null> {
  const config = getEmbeddingConfig();
  if (!config) return null;

  // Get stored embeddings
  const stored = getAllEmbeddings(memoryDir);
  if (!stored || stored.length === 0) return null;

  // Embed the query
  let queryVector: number[];
  try {
    const result = await embedText(queryText, config);
    queryVector = result.vector;
  } catch {
    return null;
  }

  // KNN: compute cosine similarity against all stored vectors
  const scored = stored.map(({ atom_id, embedding }) => ({
    atom_id,
    similarity: cosineSimilarity(queryVector, deserializeVector(embedding)),
  }));

  // Sort by similarity (highest first) and limit
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, limit);
}

/**
 * Synchronous KNN search using a pre-computed query vector.
 * Use when you already have the query embedding (e.g., cached from a previous call).
 */
export function semanticSearchSync(
  memoryDir: string,
  queryVector: number[],
  limit = 20,
): { atom_id: string; similarity: number }[] | null {
  const stored = getAllEmbeddings(memoryDir);
  if (!stored || stored.length === 0) return null;

  const scored = stored.map(({ atom_id, embedding }) => ({
    atom_id,
    similarity: cosineSimilarity(queryVector, deserializeVector(embedding)),
  }));

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, limit);
}

// --- Helpers ---

/** SHA-256 hash of atom body for embedding staleness detection. Reuses hashEvidence. */
function contentHash(body: string): string {
  return hashEvidence(Buffer.from(body));
}
