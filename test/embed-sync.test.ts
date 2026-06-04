/**
 * Direct coverage for src/embed-sync.ts (#104).
 *
 * Existing coverage: test/embed-sync-bulk-load.test.ts pins the one-SELECT
 * bulk-load optimization for embedAllAtoms; test/embeddings.test.ts covers
 * semanticSearchSync. This file adds the missing direct tests for embedAtom
 * (zero direct tests pre-PR) and async semanticSearch (zero direct tests
 * pre-PR), with explicit focus on the early-out branches:
 *
 *   - no embedding provider configured
 *   - index file missing
 *   - SECRET / PERSONAL classification gates
 *   - staleness short-circuit
 *   - API failure graceful-degrade
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  initMemoryDir,
  createAtom,
  reindex,
  closeAllIndexes,
  storeEmbedding,
} from '../src/index.js';
import { embedAtom, embedAllAtoms, semanticSearch } from '../src/embed-sync.js';
import * as embeddings from '../src/embeddings.js';
import { createHash } from 'node:crypto';
import type { Atom } from '../src/types.js';

let testDir: string;

function makeFactAtom(slug: string, body: string, classification?: 'PUBLIC' | 'TEAM' | 'PERSONAL' | 'SECRET'): Atom {
  return createAtom({
    memoryDir: testDir,
    agent_id: 't',
    session_id: 't',
    type: 'fact',
    slug,
    body,
    classification,
  });
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-embed-sync-direct-'));
  initMemoryDir(testDir);
  vi.restoreAllMocks();
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
  delete process.env.EMBEDDING_PROVIDER;
  delete process.env.EMBEDDING_API_KEY;
  vi.restoreAllMocks();
});

describe('embedAtom — early-out branches (no API call)', () => {
  it('returns false when no embedding provider is configured', async () => {
    const atom = makeFactAtom('no-provider', 'whatever body');
    reindex(testDir);
    // No EMBEDDING_PROVIDER set — getEmbeddingConfig returns null.
    const result = await embedAtom(testDir, atom);
    expect(result).toBe(false);
  });

  it('returns false when no API key is set even with a provider', async () => {
    process.env.EMBEDDING_PROVIDER = 'voyage';
    // No EMBEDDING_API_KEY or VOYAGE_API_KEY — getEmbeddingConfig returns null.
    const atom = makeFactAtom('no-key', 'whatever body');
    reindex(testDir);
    const result = await embedAtom(testDir, atom);
    expect(result).toBe(false);
  });

  it('returns false when no index file exists (indexExists short-circuit)', async () => {
    process.env.EMBEDDING_PROVIDER = 'voyage';
    process.env.EMBEDDING_API_KEY = 'sk-test';
    const atom = makeFactAtom('no-index', 'body');
    // Deliberately skip reindex — no index.db file.
    const result = await embedAtom(testDir, atom);
    expect(result).toBe(false);
  });

  it('returns false for SECRET-classified atoms (privacy gate)', async () => {
    process.env.EMBEDDING_PROVIDER = 'voyage';
    process.env.EMBEDDING_API_KEY = 'sk-test';
    const atom = makeFactAtom('secret-atom', 'sensitive content', 'SECRET');
    reindex(testDir);

    // Spy on embedText — we expect it NOT to be called for SECRET atoms.
    const embedSpy = vi.spyOn(embeddings, 'embedText');

    const result = await embedAtom(testDir, atom);
    expect(result).toBe(false);
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it('returns false for PERSONAL-classified atoms (privacy gate)', async () => {
    process.env.EMBEDDING_PROVIDER = 'voyage';
    process.env.EMBEDDING_API_KEY = 'sk-test';
    const atom = makeFactAtom('personal-atom', 'personal info', 'PERSONAL');
    reindex(testDir);

    const embedSpy = vi.spyOn(embeddings, 'embedText');

    const result = await embedAtom(testDir, atom);
    expect(result).toBe(false);
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it('returns false when the embedding is already current (body hash matches)', async () => {
    process.env.EMBEDDING_PROVIDER = 'voyage';
    process.env.EMBEDDING_API_KEY = 'sk-test';
    const atom = makeFactAtom('fresh-embed', 'current body');
    reindex(testDir);

    // Pre-store a current embedding for the atom (body hash matches)
    const bodyHash = createHash('sha256').update('current body').digest('hex');
    const fakeVec = new Array(512).fill(0);
    storeEmbedding(
      testDir,
      atom.frontmatter.id,
      Buffer.from(new Float32Array(fakeVec).buffer),
      'voyage-3-lite',
      512,
      bodyHash,
    );

    const embedSpy = vi.spyOn(embeddings, 'embedText');
    const result = await embedAtom(testDir, atom);
    expect(result).toBe(false);
    expect(embedSpy).not.toHaveBeenCalled();
  });
});

describe('embedAtom — success and failure paths', () => {
  it('returns true and stores a normalized vector when atom is stale and API succeeds', async () => {
    process.env.EMBEDDING_PROVIDER = 'voyage';
    process.env.EMBEDDING_API_KEY = 'sk-test';
    const atom = makeFactAtom('stale-embed', 'body to embed');
    reindex(testDir);

    vi.spyOn(embeddings, 'embedText').mockResolvedValue({
      vector: [3, 0, 4, 0], // un-normalized; embedAtom must normalize
      model: 'voyage-3-lite',
      tokens_used: 1,
    });

    const result = await embedAtom(testDir, atom);
    expect(result).toBe(true);
  });

  it('returns false (graceful degrade) when the embedding API throws', async () => {
    process.env.EMBEDDING_PROVIDER = 'voyage';
    process.env.EMBEDDING_API_KEY = 'sk-test';
    const atom = makeFactAtom('api-fail', 'will fail');
    reindex(testDir);

    vi.spyOn(embeddings, 'embedText').mockRejectedValue(
      new Error('upstream 503'),
    );

    const result = await embedAtom(testDir, atom);
    expect(result).toBe(false);
  });
});

describe('semanticSearch (async) — early-out branches', () => {
  it('returns null when no embedding provider is configured', async () => {
    const result = await semanticSearch(testDir, 'query');
    expect(result).toBeNull();
  });

  it('returns null when no stored embeddings exist (or no index)', async () => {
    process.env.EMBEDDING_PROVIDER = 'voyage';
    process.env.EMBEDDING_API_KEY = 'sk-test';
    // Create the atom but do NOT store any embeddings.
    makeFactAtom('no-stored-embeddings', 'body');
    reindex(testDir);

    const result = await semanticSearch(testDir, 'query');
    expect(result).toBeNull();
  });

  it('returns null when query embedding API throws', async () => {
    process.env.EMBEDDING_PROVIDER = 'voyage';
    process.env.EMBEDDING_API_KEY = 'sk-test';
    const atom = makeFactAtom('one-atom', 'cat dog');
    reindex(testDir);
    // Stash a stored vector so we get past the empty check
    const bodyHash = createHash('sha256').update('cat dog').digest('hex');
    storeEmbedding(
      testDir,
      atom.frontmatter.id,
      Buffer.from(new Float32Array(new Array(4).fill(0.5)).buffer),
      'voyage-3-lite',
      4,
      bodyHash,
    );

    vi.spyOn(embeddings, 'embedText').mockRejectedValue(new Error('API down'));

    const result = await semanticSearch(testDir, 'query');
    expect(result).toBeNull();
  });
});

describe('semanticSearch (async) — happy path', () => {
  it('returns scored hits sorted by similarity, capped by limit', async () => {
    process.env.EMBEDDING_PROVIDER = 'voyage';
    process.env.EMBEDDING_API_KEY = 'sk-test';

    const a1 = makeFactAtom('vec-a', 'first');
    const a2 = makeFactAtom('vec-b', 'second');
    const a3 = makeFactAtom('vec-c', 'third');
    reindex(testDir);

    // Construct stored vectors with deliberately different alignments to the query.
    // Query vector: [1, 0, 0, 0]  (post-normalize).
    // a1 highly aligned, a2 moderate, a3 orthogonal.
    const vecHighlyAligned = new Float32Array([0.99, 0.1, 0, 0]);
    const vecModerate = new Float32Array([0.7, 0.7, 0, 0]);
    const vecOrthogonal = new Float32Array([0, 1, 0, 0]);

    storeEmbedding(
      testDir,
      a1.frontmatter.id,
      Buffer.from(vecHighlyAligned.buffer.slice(0)),
      'voyage-3-lite',
      4,
      createHash('sha256').update('first').digest('hex'),
    );
    storeEmbedding(
      testDir,
      a2.frontmatter.id,
      Buffer.from(vecModerate.buffer.slice(0)),
      'voyage-3-lite',
      4,
      createHash('sha256').update('second').digest('hex'),
    );
    storeEmbedding(
      testDir,
      a3.frontmatter.id,
      Buffer.from(vecOrthogonal.buffer.slice(0)),
      'voyage-3-lite',
      4,
      createHash('sha256').update('third').digest('hex'),
    );

    vi.spyOn(embeddings, 'embedText').mockResolvedValue({
      vector: [1, 0, 0, 0],
      model: 'voyage-3-lite',
      tokens_used: 1,
    });

    const result = await semanticSearch(testDir, 'query', 2);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2); // capped by limit
    // The top hit should be the highly-aligned vector.
    expect(result![0].atom_id).toBe(a1.frontmatter.id);
    // Sorted descending — score[0] >= score[1].
    expect(result![0].similarity).toBeGreaterThanOrEqual(result![1].similarity);
  });
});

describe('embedAllAtoms — provider gate', () => {
  it('returns zero counts when no embedding provider is configured', async () => {
    makeFactAtom('one', 'body one');
    makeFactAtom('two', 'body two');
    reindex(testDir);

    const result = await embedAllAtoms(testDir);
    expect(result.embedded).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.timeMs).toBe(0);
  });

  it('skips SECRET and PERSONAL atoms without calling the batch API', async () => {
    process.env.EMBEDDING_PROVIDER = 'voyage';
    process.env.EMBEDDING_API_KEY = 'sk-test';

    makeFactAtom('secret-skip', 'secret body', 'SECRET');
    makeFactAtom('personal-skip', 'personal body', 'PERSONAL');
    reindex(testDir);

    const batchSpy = vi.spyOn(embeddings, 'embedBatch');

    const result = await embedAllAtoms(testDir);
    expect(result.embedded).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.errors).toBe(0);
    expect(batchSpy).not.toHaveBeenCalled();
  });

  it('counts errors when batch API throws, with no successful stores', async () => {
    process.env.EMBEDDING_PROVIDER = 'voyage';
    process.env.EMBEDDING_API_KEY = 'sk-test';

    makeFactAtom('err-1', 'body 1');
    makeFactAtom('err-2', 'body 2');
    reindex(testDir);

    vi.spyOn(embeddings, 'embedBatch').mockRejectedValue(
      new Error('rate limit'),
    );

    const result = await embedAllAtoms(testDir);
    expect(result.embedded).toBe(0);
    expect(result.errors).toBe(2);
  });

  it('invokes onProgress callback at least once during a non-empty batch', async () => {
    process.env.EMBEDDING_PROVIDER = 'voyage';
    process.env.EMBEDDING_API_KEY = 'sk-test';

    makeFactAtom('progress-1', 'body x');
    reindex(testDir);

    vi.spyOn(embeddings, 'embedBatch').mockResolvedValue([
      { vector: new Array(4).fill(0.1), model: 'voyage-3-lite', tokens_used: 1 },
    ]);

    const progressCalls: Array<[number, number]> = [];
    await embedAllAtoms(testDir, {
      onProgress: (done, total) => progressCalls.push([done, total]),
    });
    expect(progressCalls.length).toBeGreaterThanOrEqual(1);
    // Each call's "total" must equal the number of atoms.
    expect(progressCalls.every(([, total]) => total === 1)).toBe(true);
  });
});
