/**
 * Embeddings & semantic search — tests.
 *
 * Tests the embedding infrastructure without making real API calls:
 * - Vector math (cosine similarity, serialization)
 * - Embedding config resolution
 * - SQLite embedding storage (store, retrieve, stale detection)
 * - Semantic search with pre-computed vectors (KNN)
 * - Recall with semantic re-ranking (queryVector)
 * - atomToEmbeddingText formatting
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  initMemoryDir,
  createAtom,
  reindex,
  recall,
  indexExists,
  indexStats,
  closeAllIndexes,
  cosineSimilarity,
  serializeVector,
  deserializeVector,
  atomToEmbeddingText,
  storeEmbedding,
  getAllEmbeddings,
  isEmbeddingStale,
  embeddingStats,
} from '../src/index.js';
import { semanticSearchSync } from '../src/embed-sync.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-embed-'));
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

const base = (dir: string) => ({
  memoryDir: dir,
  agent_id: 'test',
  session_id: 'test-session',
});

// --- Vector math ---

describe('cosine similarity', () => {
  it('should return 1 for identical vectors', () => {
    const v = [1, 2, 3, 4, 5];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it('should return 0 for orthogonal vectors', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it('should return -1 for opposite vectors', () => {
    const a = [1, 2, 3];
    const b = [-1, -2, -3];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it('should return 0 for mismatched dimensions', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it('should return 0 for zero vectors', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it('should handle high-dimensional vectors', () => {
    const dim = 512;
    const a = Array.from({ length: dim }, (_, i) => Math.sin(i));
    const b = Array.from({ length: dim }, (_, i) => Math.cos(i));
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThan(-1);
    expect(sim).toBeLessThan(1);
  });
});

// --- Serialization ---

describe('vector serialization', () => {
  it('should roundtrip a vector through serialize/deserialize', () => {
    const original = [0.1, 0.2, 0.3, -0.5, 1.0, 0.0];
    const buf = serializeVector(original);
    const restored = deserializeVector(buf);

    expect(restored.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 5);
    }
  });

  it('should produce correct buffer size (4 bytes per float)', () => {
    const v = new Array(512).fill(0.5);
    const buf = serializeVector(v);
    expect(buf.byteLength).toBe(512 * 4); // Float32 = 4 bytes
  });

  it('should handle empty vector', () => {
    const buf = serializeVector([]);
    const restored = deserializeVector(buf);
    expect(restored.length).toBe(0);
  });
});

// --- atomToEmbeddingText ---

describe('atomToEmbeddingText', () => {
  it('should format body-only text', () => {
    const text = atomToEmbeddingText('Hello world');
    expect(text).toBe('Hello world');
  });

  it('should prepend type', () => {
    const text = atomToEmbeddingText('Hello', undefined, 'fact');
    expect(text).toContain('[fact]');
    expect(text).toContain('Hello');
  });

  it('should include tags', () => {
    const text = atomToEmbeddingText('Hello', ['api', 'infra'], 'fact');
    expect(text).toContain('tags: api, infra');
    expect(text).toContain('[fact]');
    expect(text).toContain('Hello');
  });

  it('should trim body whitespace', () => {
    const text = atomToEmbeddingText('  padded  ');
    expect(text).toBe('padded');
  });
});

// --- Embedding config ---

describe('getEmbeddingConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore environment
    delete process.env.EMBEDDING_PROVIDER;
    delete process.env.EMBEDDING_API_KEY;
    delete process.env.EMBEDDING_MODEL;
  });

  it('should return null when provider is none (default)', async () => {
    const { getEmbeddingConfig } = await import('../src/embeddings.js');
    delete process.env.EMBEDDING_PROVIDER;
    expect(getEmbeddingConfig()).toBeNull();
  });

  it('should return null when provider set but no API key', async () => {
    const { getEmbeddingConfig } = await import('../src/embeddings.js');
    process.env.EMBEDDING_PROVIDER = 'voyage';
    delete process.env.EMBEDDING_API_KEY;
    expect(getEmbeddingConfig()).toBeNull();
  });

  it('should return config when provider and key are set', async () => {
    const { getEmbeddingConfig } = await import('../src/embeddings.js');
    process.env.EMBEDDING_PROVIDER = 'voyage';
    process.env.EMBEDDING_API_KEY = 'test-key';
    const config = getEmbeddingConfig();
    expect(config).not.toBeNull();
    expect(config!.provider).toBe('voyage');
    expect(config!.model).toBe('voyage-3-lite');
    expect(config!.dimensions).toBe(512);
  });

  it('should allow model override', async () => {
    const { getEmbeddingConfig } = await import('../src/embeddings.js');
    process.env.EMBEDDING_PROVIDER = 'openai';
    process.env.EMBEDDING_API_KEY = 'test-key';
    process.env.EMBEDDING_MODEL = 'text-embedding-3-large';
    const config = getEmbeddingConfig();
    expect(config!.model).toBe('text-embedding-3-large');
  });
});

// --- SQLite embedding storage ---

describe('embedding storage', () => {
  it('should store and retrieve embeddings', () => {
    initMemoryDir(testDir);
    const atom = createAtom({ ...base(testDir), type: 'fact', slug: 'test-fact', body: 'Test fact body' });
    reindex(testDir);

    const vector = [0.1, 0.2, 0.3, 0.4, 0.5];
    const buf = serializeVector(vector);
    storeEmbedding(testDir, atom.frontmatter.id, buf, 'test-model', vector.length, 'hash123');

    const all = getAllEmbeddings(testDir);
    expect(all).not.toBeNull();
    expect(all!.length).toBe(1);
    expect(all![0].atom_id).toBe(atom.frontmatter.id);

    // Verify the vector data roundtrips
    const restored = deserializeVector(all![0].embedding);
    expect(restored.length).toBe(vector.length);
    for (let i = 0; i < vector.length; i++) {
      expect(restored[i]).toBeCloseTo(vector[i], 5);
    }
  });

  it('should detect stale embeddings', () => {
    initMemoryDir(testDir);
    const atom = createAtom({ ...base(testDir), type: 'fact', slug: 'stale', body: 'Original body' });
    reindex(testDir);

    // No embedding yet — should be stale
    expect(isEmbeddingStale(testDir, atom.frontmatter.id, 'hash-v1')).toBe(true);

    // Store embedding
    const buf = serializeVector([0.1, 0.2]);
    storeEmbedding(testDir, atom.frontmatter.id, buf, 'model', 2, 'hash-v1');

    // Same hash — not stale
    expect(isEmbeddingStale(testDir, atom.frontmatter.id, 'hash-v1')).toBe(false);

    // Different hash — stale
    expect(isEmbeddingStale(testDir, atom.frontmatter.id, 'hash-v2')).toBe(true);
  });

  it('should report embedding stats', () => {
    initMemoryDir(testDir);
    const atom = createAtom({ ...base(testDir), type: 'fact', slug: 'a', body: 'Fact A' });
    createAtom({ ...base(testDir), type: 'belief', slug: 'b', body: 'Belief B' });
    reindex(testDir);

    // No embeddings yet
    const stats0 = indexStats(testDir);
    expect(stats0!.embeddings).toBe(0);

    // Add one embedding using the actual atom ID
    storeEmbedding(testDir, atom.frontmatter.id, serializeVector([0.1]), 'test-model', 1, 'h1');

    const eStats = embeddingStats(testDir);
    expect(eStats).not.toBeNull();
    expect(eStats!.count).toBe(1);
    expect(eStats!.model).toBe('test-model');
  });

  it('should return null for no index', () => {
    initMemoryDir(testDir);
    // No reindex — no index DB
    expect(getAllEmbeddings(testDir)).toBeNull();
  });

  it('should upsert embedding on duplicate atom_id', () => {
    initMemoryDir(testDir);
    const atom = createAtom({ ...base(testDir), type: 'fact', slug: 'upsert', body: 'Body' });
    reindex(testDir);

    const id = atom.frontmatter.id;
    storeEmbedding(testDir, id, serializeVector([0.1, 0.2]), 'model-v1', 2, 'h1');
    storeEmbedding(testDir, id, serializeVector([0.3, 0.4]), 'model-v2', 2, 'h2');

    const all = getAllEmbeddings(testDir);
    expect(all!.length).toBe(1);
    const restored = deserializeVector(all![0].embedding);
    expect(restored[0]).toBeCloseTo(0.3, 5);
  });
});

// --- Semantic search (sync, with pre-computed vectors) ---

describe('semantic search (sync)', () => {
  it('should find most similar atoms by cosine similarity', () => {
    initMemoryDir(testDir);
    const a1 = createAtom({ ...base(testDir), type: 'fact', slug: 'api-fact', body: 'API rate limit is 1000' });
    const a2 = createAtom({ ...base(testDir), type: 'fact', slug: 'db-fact', body: 'Database uses PostgreSQL' });
    const a3 = createAtom({ ...base(testDir), type: 'belief', slug: 'perf-belief', body: 'Performance improves with caching' });
    reindex(testDir);

    // Store embeddings — a1 and a3 are similar, a2 is different
    const vApi = [0.9, 0.1, 0.0, 0.1]; // API-like
    const vDb = [0.0, 0.1, 0.9, 0.1]; // DB-like
    const vPerf = [0.8, 0.2, 0.1, 0.0]; // similar to API

    storeEmbedding(testDir, a1.frontmatter.id, serializeVector(vApi), 'test', 4, 'h1');
    storeEmbedding(testDir, a2.frontmatter.id, serializeVector(vDb), 'test', 4, 'h2');
    storeEmbedding(testDir, a3.frontmatter.id, serializeVector(vPerf), 'test', 4, 'h3');

    // Search with a query vector similar to API
    const queryVector = [0.85, 0.15, 0.05, 0.05];
    const results = semanticSearchSync(testDir, queryVector, 10);

    expect(results).not.toBeNull();
    expect(results!.length).toBe(3);

    // a1 (API) should be most similar to query
    expect(results![0].atom_id).toBe(a1.frontmatter.id);
    // a3 (perf/cache) should be second
    expect(results![1].atom_id).toBe(a3.frontmatter.id);
    // a2 (DB) should be least similar
    expect(results![2].atom_id).toBe(a2.frontmatter.id);

    // Verify scores are in descending order
    for (let i = 1; i < results!.length; i++) {
      expect(results![i - 1].similarity).toBeGreaterThanOrEqual(results![i].similarity);
    }
  });

  it('should respect limit parameter', () => {
    initMemoryDir(testDir);
    const atoms = [];
    for (let i = 0; i < 5; i++) {
      atoms.push(createAtom({ ...base(testDir), type: 'fact', slug: `f-${i}`, body: `Fact ${i}` }));
    }
    reindex(testDir);

    for (const atom of atoms) {
      storeEmbedding(testDir, atom.frontmatter.id, serializeVector([Math.random(), Math.random()]), 'test', 2, `h${atom.frontmatter.id}`);
    }

    const results = semanticSearchSync(testDir, [0.5, 0.5], 2);
    expect(results).not.toBeNull();
    expect(results!.length).toBe(2);
  });

  it('should return null when no embeddings exist', () => {
    initMemoryDir(testDir);
    createAtom({ ...base(testDir), type: 'fact', slug: 'lonely', body: 'No embeddings here' });
    reindex(testDir);

    const results = semanticSearchSync(testDir, [0.5, 0.5], 10);
    expect(results).toBeNull();
  });
});

// --- Recall with semantic re-ranking ---

describe('recall with queryVector', () => {
  it('should re-rank atoms using combined FTS + semantic scores', () => {
    initMemoryDir(testDir);
    const a1 = createAtom({ ...base(testDir), type: 'fact', slug: 'api-rate', body: 'The API rate limit is 1000 requests per minute', scope: { tags: ['api'] } });
    const a2 = createAtom({ ...base(testDir), type: 'fact', slug: 'db-pool', body: 'Database connection pool size is 20', scope: { tags: ['database'] } });
    const a3 = createAtom({ ...base(testDir), type: 'decision', slug: 'cache-strategy', body: 'We decided to use Redis for API response caching', scope: { tags: ['api', 'cache'] } });
    reindex(testDir);

    // Store embeddings: a3 (cache strategy) most semantically similar to "API performance"
    storeEmbedding(testDir, a1.frontmatter.id, serializeVector([0.5, 0.3, 0.1, 0.1]), 'test', 4, 'h1');
    storeEmbedding(testDir, a2.frontmatter.id, serializeVector([0.0, 0.1, 0.9, 0.0]), 'test', 4, 'h2');
    storeEmbedding(testDir, a3.frontmatter.id, serializeVector([0.8, 0.6, 0.1, 0.0]), 'test', 4, 'h3');

    // Recall with task + queryVector (simulating "API performance optimization")
    const queryVector = [0.7, 0.5, 0.1, 0.05];
    const bundle = recall(testDir, {
      task: 'API performance',
      queryVector,
    });

    expect(bundle.atoms.length).toBeGreaterThanOrEqual(2);
    // With semantic re-ranking, the cache strategy (highest semantic similarity)
    // should appear near the top
    const ids = bundle.atoms.map((a) => a.frontmatter.id);
    expect(ids).toContain(a3.frontmatter.id);
  });

  it('should fall back to FTS-only when no queryVector provided', () => {
    initMemoryDir(testDir);
    createAtom({ ...base(testDir), type: 'fact', slug: 'deploy-time', body: 'Deploy takes 4 minutes' });
    createAtom({ ...base(testDir), type: 'fact', slug: 'test-coverage', body: 'Test coverage is 85%' });
    reindex(testDir);

    const bundle = recall(testDir, { task: 'deploy' });
    // Should still work fine without queryVector — pure FTS ranking
    expect(bundle.atoms.length).toBeGreaterThanOrEqual(1);
  });
});
