/**
 * Privacy filter on getAllEmbeddings.
 *
 * getAllEmbeddings() feeds the semantic / KNN graph-boost path. The SELECT
 * JOINs to `atoms` and excludes SECRET/PERSONAL rows so that classification
 * is enforced uniformly across the recall surface (same filter as queryIndex).
 * Atoms with the default TEAM classification stay visible.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import {
  initMemoryDir,
  createAtom,
  reindex,
  closeAllIndexes,
  getAllEmbeddings,
  storeEmbedding,
  serializeVector,
} from '../src/index.js';

const AGENT = 'test-agent';
const SESSION = 'test-session';
let memoryDir: string;

beforeEach(() => {
  memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-privacy-'));
  initMemoryDir(memoryDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(memoryDir, { recursive: true, force: true });
});

const base = (dir: string) => ({
  memoryDir: dir,
  agent_id: AGENT,
  session_id: SESSION,
});

describe('getAllEmbeddings — SECRET/PERSONAL filter', () => {
  it('excludes SECRET atoms from the returned embedding set', () => {
    const publicAtom = createAtom({
      ...base(memoryDir),
      type: 'fact',
      slug: 'public-a',
      body: 'Public content body.',
      classification: 'PUBLIC',
    });
    const secretAtom = createAtom({
      ...base(memoryDir),
      type: 'fact',
      slug: 'secret-b',
      body: 'Secret content body.',
      classification: 'SECRET',
    });
    reindex(memoryDir);

    storeEmbedding(memoryDir, publicAtom.frontmatter.id, serializeVector([0.1, 0.2, 0.3, 0.4]), 'fake', 4, 'hp');
    storeEmbedding(memoryDir, secretAtom.frontmatter.id, serializeVector([0.5, 0.6, 0.7, 0.8]), 'fake', 4, 'hs');

    const embeddings = getAllEmbeddings(memoryDir);
    expect(embeddings).not.toBeNull();
    const ids = embeddings!.map((e) => e.atom_id);
    expect(ids).toContain(publicAtom.frontmatter.id);
    expect(ids).not.toContain(secretAtom.frontmatter.id);
  });

  it('excludes PERSONAL atoms from the returned embedding set', () => {
    const personalAtom = createAtom({
      ...base(memoryDir),
      type: 'fact',
      slug: 'personal-c',
      body: 'Personal content body.',
      classification: 'PERSONAL',
    });
    const publicAtom = createAtom({
      ...base(memoryDir),
      type: 'fact',
      slug: 'pub-d',
      body: 'Public content body.',
      classification: 'PUBLIC',
    });
    reindex(memoryDir);

    storeEmbedding(memoryDir, personalAtom.frontmatter.id, serializeVector([0.1, 0.2, 0.3, 0.4]), 'fake', 4, 'hpe');
    storeEmbedding(memoryDir, publicAtom.frontmatter.id, serializeVector([0.5, 0.6, 0.7, 0.8]), 'fake', 4, 'hpu');

    const embeddings = getAllEmbeddings(memoryDir);
    expect(embeddings).not.toBeNull();
    const ids = embeddings!.map((e) => e.atom_id);
    expect(ids).toContain(publicAtom.frontmatter.id);
    expect(ids).not.toContain(personalAtom.frontmatter.id);
  });

  it('preserves atoms with the default TEAM classification', () => {
    const teamAtom = createAtom({
      ...base(memoryDir),
      type: 'fact',
      slug: 'team-default',
      body: 'Team-classified (default).',
      // classification omitted → defaults to TEAM
    });
    reindex(memoryDir);
    storeEmbedding(memoryDir, teamAtom.frontmatter.id, serializeVector([1, 0, 0, 0]), 'fake', 4, 'ht');

    const embeddings = getAllEmbeddings(memoryDir);
    expect(embeddings).not.toBeNull();
    const ids = embeddings!.map((e) => e.atom_id);
    expect(ids).toContain(teamAtom.frontmatter.id);
  });
});
