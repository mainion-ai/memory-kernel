import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initMemoryDir, createAtom, reindex, closeAllIndexes, storeEmbedding } from '../src/index.js';
import { embedAllAtoms } from '../src/embed-sync.js';
import { serializeVector } from '../src/embeddings.js';
import { createHash } from 'node:crypto';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-bulk-'));
  initMemoryDir(testDir);
  vi.restoreAllMocks();
  process.env.EMBEDDING_PROVIDER = 'voyage';
  process.env.EMBEDDING_API_KEY = 'sk-test';
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
  delete process.env.EMBEDDING_PROVIDER;
  delete process.env.EMBEDDING_API_KEY;
  vi.restoreAllMocks();
});

describe('embedAllAtoms: bulk hash load', () => {
  it('issues one SELECT for all hashes, not one per atom', { timeout: 15000 }, async () => {
    const N = 50;
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      const a = createAtom({
        memoryDir: testDir,
        agent_id: 't', session_id: 't',
        type: 'fact',
        slug: `fact-${i}`,
        body: `fact number ${i}`,
      });
      ids.push(a.frontmatter.id);
    }
    reindex(testDir);
    const fakeVec = serializeVector(new Array(512).fill(0));
    for (let i = 0; i < N; i++) {
      const bodyHash = createHash('sha256').update(`fact number ${i}`).digest('hex');
      storeEmbedding(testDir, ids[i], fakeVec, 'voyage-3-lite', 512, bodyHash);
    }

    // Observe `prepare` calls without overriding them
    const spy = vi.spyOn(Database.prototype, 'prepare');

    const r = await embedAllAtoms(testDir);

    const hashSelects = spy.mock.calls
      .map((c) => c[0] as string)
      .filter((sql) => /SELECT[\s\S]*body_hash[\s\S]*FROM[\s\S]*atom_embeddings/i.test(sql));

    expect(r.skipped).toBe(N);
    expect(r.embedded).toBe(0);
    expect(r.errors).toBe(0);
    expect(hashSelects.length).toBe(1); // one bulk SELECT, not N
  });

  it('still detects stale atoms (mixed fresh and stale)', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const a = createAtom({
        memoryDir: testDir,
        agent_id: 't', session_id: 't',
        type: 'fact',
        slug: `mixed-${i}`,
        body: `mixed ${i}`,
      });
      ids.push(a.frontmatter.id);
    }
    reindex(testDir);

    const fakeVec = serializeVector(new Array(512).fill(0));

    // Atom 0: current hash → fresh
    storeEmbedding(testDir, ids[0], fakeVec, 'voyage-3-lite', 512,
      createHash('sha256').update('mixed 0').digest('hex'));
    // Atom 1: wrong hash → stale
    storeEmbedding(testDir, ids[1], fakeVec, 'voyage-3-lite', 512, 'stale-hash');
    // Atom 2: missing entry → stale
    // Atom 3: current hash → fresh
    storeEmbedding(testDir, ids[3], fakeVec, 'voyage-3-lite', 512,
      createHash('sha256').update('mixed 3').digest('hex'));

    // Stub embedBatch so embedAllAtoms doesn't actually network
    const embeddings = await import('../src/embeddings.js');
    vi.spyOn(embeddings, 'embedBatch').mockResolvedValue([
      { vector: new Array(512).fill(0.1), model: 'voyage-3-lite', tokens_used: 1 },
      { vector: new Array(512).fill(0.1), model: 'voyage-3-lite', tokens_used: 1 },
    ]);

    const r = await embedAllAtoms(testDir);
    expect(r.skipped).toBe(2);   // atoms 0 and 3 — current hashes
    expect(r.embedded).toBe(2);  // atoms 1 and 2 — stale / missing
  });
});
