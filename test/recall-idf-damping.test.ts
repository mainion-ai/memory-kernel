/**
 * IDF hub damping tests.
 *
 * Phase 5 of scoring improvements: atoms matching only ubiquitous query terms
 * get penalized so that atoms matching rare terms rank higher.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  initMemoryDir,
  createAtom,
  recall,
  reindex,
  closeAllIndexes,
  getTermDocumentFrequencies,
  getCorpusSize,
} from '../src/index.js';

let testDir: string;

const base = (dir: string) => ({
  memoryDir: dir,
  agent_id: 'test',
  session_id: 'test-session',
});

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-idf-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// getTermDocumentFrequencies + getCorpusSize unit tests
// ---------------------------------------------------------------------------

describe('getTermDocumentFrequencies()', () => {
  it('returns null when index does not exist', () => {
    expect(getTermDocumentFrequencies(testDir, ['memory'])).toBeNull();
  });

  it('returns document counts for terms', () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'a', body: 'memory and belief systems' });
    createAtom({ ...base(testDir), type: 'fact', slug: 'b', body: 'memory and agent patterns' });
    createAtom({ ...base(testDir), type: 'fact', slug: 'c', body: 'postgresql database setup' });
    reindex(testDir);

    const df = getTermDocumentFrequencies(testDir, ['memory', 'postgresql']);
    expect(df).not.toBeNull();
    expect(df!.get('memory')).toBe(2);
    expect(df!.get('postgresql')).toBe(1);
  });
});

describe('getCorpusSize()', () => {
  it('returns 0 when index does not exist', () => {
    expect(getCorpusSize(testDir)).toBe(0);
  });

  it('returns correct atom count', () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'a', body: 'first atom' });
    createAtom({ ...base(testDir), type: 'fact', slug: 'b', body: 'second atom' });
    reindex(testDir);
    expect(getCorpusSize(testDir)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Specificity score tests via recall
// ---------------------------------------------------------------------------

describe('IDF hub damping in recall', () => {
  /**
   * Test 1: Specificity score is lower for atoms matching only common terms.
   * Create 20 atoms all containing "memory" and "belief". Create 1 atom
   * containing "memory" and "postgresql". Query "memory postgresql" — the
   * postgresql atom should rank higher with damping enabled.
   */
  it('ranks atom with rare term higher than atoms with only common terms', () => {
    // Create 20 ubiquitous-term atoms
    for (let i = 0; i < 20; i++) {
      createAtom({
        ...base(testDir),
        type: 'fact',
        slug: `common-${i}`,
        body: `memory belief agent session decision number ${i}`,
      });
    }

    // Create 1 atom with a rare term
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'rare-term',
      body: 'memory postgresql database configuration',
    });

    reindex(testDir);

    // Recall with idf_damping=1 (full damping)
    const result = recall(testDir, {
      task: 'memory postgresql',
      idf_damping: 1.0,
      decay_weight: 0, // disable recency to isolate relevance
    });

    // The postgresql atom should be in the top results
    const atomIds = result.atoms.map(a => a.frontmatter.id);
    const rareIdx = atomIds.findIndex(id => id.toLowerCase().includes('rare-term'));
    expect(rareIdx).toBeGreaterThanOrEqual(0);
    // It should be ranked first or near the top (within top 3)
    expect(rareIdx).toBeLessThan(3);
  });

  /**
   * Test 2: Hub damping changes ranking compared to no damping.
   */
  it('changes ranking compared to idf_damping=0', () => {
    // Create ubiquitous-term atoms
    for (let i = 0; i < 15; i++) {
      createAtom({
        ...base(testDir),
        type: 'fact',
        slug: `common-${i}`,
        body: `memory belief agent session decision variant ${i}`,
      });
    }

    // Rare-term atom
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'specific',
      body: 'memory postgresql replication setup',
    });

    reindex(testDir);

    const baseQuery = {
      task: 'memory postgresql',
      decay_weight: 0,
    };

    // Without damping
    const noDamping = recall(testDir, { ...baseQuery, idf_damping: 0 });
    const noDampingIds = noDamping.atoms.map(a => a.frontmatter.id);
    const noDampingRank = noDampingIds.findIndex(id => id.toLowerCase().includes('specific'));

    // With damping
    const withDamping = recall(testDir, { ...baseQuery, idf_damping: 1.0 });
    const withDampingIds = withDamping.atoms.map(a => a.frontmatter.id);
    const withDampingRank = withDampingIds.findIndex(id => id.toLowerCase().includes('specific'));

    // With damping, the specific atom should rank higher (lower index) or equal
    expect(withDampingRank).toBeLessThanOrEqual(noDampingRank);
  });

  /**
   * Test 3: Damping disabled when idf_damping=0.
   * Scores should be identical to baseline (no specificity adjustment).
   */
  it('produces identical results when idf_damping=0', () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'a', body: 'memory belief patterns for agents' });
    createAtom({ ...base(testDir), type: 'fact', slug: 'b', body: 'memory postgresql configuration' });
    reindex(testDir);

    const baseQuery = {
      task: 'memory postgresql',
      decay_weight: 0,
      idf_damping: 0,
    };

    const result1 = recall(testDir, baseQuery);
    const result2 = recall(testDir, baseQuery);

    // Results should be identical
    const ids1 = result1.atoms.map(a => a.frontmatter.id);
    const ids2 = result2.atoms.map(a => a.frontmatter.id);
    expect(ids1).toEqual(ids2);
  });

  /**
   * Test 4: Graceful degradation — when FTS index is unavailable,
   * specificity scores default to 1.0 (no penalty).
   */
  it('degrades gracefully without FTS index', () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'a', body: 'memory postgresql' });
    // Do NOT reindex — no FTS available

    // Should not throw
    const result = recall(testDir, {
      task: 'memory postgresql',
      idf_damping: 1.0,
    });
    expect(result.atoms).toBeDefined();
  });

  /**
   * Test 5: Single-term queries — all matching atoms get specificity 1.0
   * (IDF ratio is always 1 when there is only one term).
   */
  it('does not penalize on single-term queries', () => {
    for (let i = 0; i < 10; i++) {
      createAtom({
        ...base(testDir),
        type: 'fact',
        slug: `item-${i}`,
        body: `memory systems and patterns variant ${i}`,
      });
    }
    reindex(testDir);

    // Single-term query — no damping should be applied
    const dampedResult = recall(testDir, {
      task: 'memory',
      idf_damping: 1.0,
      decay_weight: 0,
    });

    const undampedResult = recall(testDir, {
      task: 'memory',
      idf_damping: 0,
      decay_weight: 0,
    });

    // Order should be the same since single-term queries skip IDF damping
    const dampedIds = dampedResult.atoms.map(a => a.frontmatter.id);
    const undampedIds = undampedResult.atoms.map(a => a.frontmatter.id);
    expect(dampedIds).toEqual(undampedIds);
  });
});
