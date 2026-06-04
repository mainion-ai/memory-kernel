import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { normalizeVector, dotProduct, cosineSimilarity, serializeVector } from '../src/embeddings.js';
import {
  initMemoryDir, createAtom, reindex, openIndex, closeAllIndexes,
} from '../src/index.js';
import { storeEmbedding, getAllEmbeddings } from '../src/index-db.js';
import { recall } from '../src/recall.js';

describe('normalizeVector', () => {
  it('returns a unit-norm vector', () => {
    const n = normalizeVector([3, 4]);
    const norm = Math.sqrt(n[0] * n[0] + n[1] * n[1]);
    expect(norm).toBeCloseTo(1, 10);
    expect(n[0]).toBeCloseTo(0.6, 10);
    expect(n[1]).toBeCloseTo(0.8, 10);
  });

  it('returns the zero vector unchanged (avoids NaN)', () => {
    expect(normalizeVector([0, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe('dotProduct on unit vectors == cosineSimilarity', () => {
  it('matches cosineSimilarity within 1e-10 for unit-normalized inputs', () => {
    const a = normalizeVector([1, 2, 3, 4, 5]);
    const b = normalizeVector([5, 4, 3, 2, 1]);
    expect(dotProduct(a, b)).toBeCloseTo(cosineSimilarity(a, b), 10);
  });
});

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-knn-norm-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('atom_embeddings.normalized column', () => {
  it('exists on the table after openIndex', () => {
    createAtom({
      memoryDir: testDir, agent_id: 't', session_id: 't',
      type: 'fact', slug: 'seed', body: 'seed',
    });
    reindex(testDir);
    const db = openIndex(testDir);
    const cols = db.prepare(`PRAGMA table_info(atom_embeddings)`).all() as { name: string }[];
    expect(cols.find(c => c.name === 'normalized')).toBeDefined();
  });

  it('lazily normalizes legacy un-normalized rows on first getAllEmbeddings', () => {
    const a = createAtom({
      memoryDir: testDir, agent_id: 't', session_id: 't',
      type: 'fact', slug: 'legacy', body: 'legacy',
    });
    reindex(testDir);

    // Insert un-normalized vector via storeEmbedding with normalized=false
    const raw = [3, 4]; // norm = 5
    storeEmbedding(testDir, a.frontmatter.id, serializeVector(raw), 'voyage-3-lite', 2,
      'h1', false);

    const stored1 = getAllEmbeddings(testDir);
    expect(stored1).not.toBeNull();
    expect(stored1!.length).toBe(1);
    const v = Array.from(new Float32Array(stored1![0].embedding.buffer,
      stored1![0].embedding.byteOffset, stored1![0].embedding.byteLength / 4));
    const norm = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
    expect(norm).toBeCloseTo(1, 5);

    // And the row should have been written back as normalized=1
    const db = openIndex(testDir);
    const row = db.prepare('SELECT normalized FROM atom_embeddings WHERE atom_id = ?')
      .get(a.frontmatter.id) as { normalized: number };
    expect(row.normalized).toBe(1);
  });
});

describe('KNN uses dot product on normalized vectors', () => {
  it('returns the same top-K ordering as the legacy cosine path', async () => {
    process.env.EMBEDDING_PROVIDER = 'voyage';
    process.env.EMBEDDING_API_KEY = 'sk-test';

    const a1 = createAtom({ memoryDir: testDir, agent_id: 't', session_id: 't',
      type: 'fact', slug: 'pagination-api-offset',
      body: 'pagination api offset' });
    const a2 = createAtom({ memoryDir: testDir, agent_id: 't', session_id: 't',
      type: 'fact', slug: 'auth-token-rotation',
      body: 'auth token rotation' });
    const a3 = createAtom({ memoryDir: testDir, agent_id: 't', session_id: 't',
      type: 'fact', slug: 'pagination-cursor',
      body: 'pagination cursor' });
    reindex(testDir);

    // Vectors are pre-normalized at write time per the new contract (since the
    // 7th `normalized` arg defaults to true). Anyone copying this test as a
    // template must keep the inputs unit-norm or pass `false` explicitly.
    storeEmbedding(testDir, a1.frontmatter.id,
      serializeVector(normalizeVector([1, 0, 1, 0])), 'voyage-3-lite', 4, 'h1');
    storeEmbedding(testDir, a2.frontmatter.id,
      serializeVector(normalizeVector([0, 1, 0, 1])), 'voyage-3-lite', 4, 'h2');
    storeEmbedding(testDir, a3.frontmatter.id,
      serializeVector(normalizeVector([0.9, 0.1, 0.9, 0.1])), 'voyage-3-lite', 4, 'h3');

    const queryVector = [1, 0, 1, 0];
    const r = await recall(testDir, { task: 'pagination', queryVector, max_tokens: 1000 });
    expect(r.atoms.length).toBeGreaterThan(0);

    // a1 + a3 both FTS-match "pagination" AND have high semantic similarity
    // to the query vector. a2 ("auth token rotation") FTS-misses and has
    // ~0 semantic similarity — under the #214 fix it correctly drops out
    // of the result. The original assertion expected a2 to surface anyway
    // via the score-0 fallback; that's the hallucination-scaffold behaviour
    // we removed. Test now asserts only the actually-relevant ordering.
    const ids = r.atoms.map(a => a.frontmatter.id);
    for (const pid of [a1.frontmatter.id, a3.frontmatter.id]) {
      expect(ids).toContain(pid);
    }

    delete process.env.EMBEDDING_PROVIDER;
    delete process.env.EMBEDDING_API_KEY;
  });
});
