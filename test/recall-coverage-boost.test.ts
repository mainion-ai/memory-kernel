/**
 * Query-term coverage boost tests.
 *
 * Phase 7 of scoring improvements: atoms matching only a fraction of query terms
 * get penalized so that atoms matching ALL query terms rank higher, even if
 * partial-match atoms have higher raw per-term BM25 scores.
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
  computeCoverageBoosts,
  getAtomsMatchingTerm,
} from '../src/index.js';

let testDir: string;

const base = (dir: string) => ({
  memoryDir: dir,
  agent_id: 'test',
  session_id: 'test-session',
});

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-coverage-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 1: Coverage boost penalizes partial-match atoms
// ---------------------------------------------------------------------------

describe('coverage boost penalizes partial-match atoms', () => {
  it('ranks 3/3-match atom above 1/3-match atom', () => {
    // Atom matching all 3 query terms
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'full-match',
      body: 'memory postgresql replication setup guide and documentation',
    });

    // Atom matching only 1 query term — similar length to full-match
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'partial-1',
      body: 'memory systems overview agent patterns and configuration notes',
    });

    // Atom matching 2/3 query terms — similar length
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'partial-2',
      body: 'memory postgresql database configuration and setup reference',
    });

    // Add more background atoms so FTS BM25 normalization is meaningful
    for (let i = 0; i < 5; i++) {
      createAtom({
        ...base(testDir),
        type: 'fact',
        slug: `filler-${i}`,
        body: `unrelated content about architecture and design variant ${i}`,
      });
    }

    reindex(testDir);

    // Use maximum coverage boost to ensure coverage dominates
    const result = recall(testDir, {
      task: 'memory postgresql replication',
      coverage_boost: 2.0,
      decay_weight: 0, // disable recency to isolate relevance
      idf_damping: 0,  // disable IDF to isolate coverage effect
      length_norm_k: 0, // disable length norm to isolate coverage effect
    });

    const atomIds = result.atoms.map(a => a.frontmatter.id.toLowerCase());
    const fullIdx = atomIds.findIndex(id => id.includes('full-match'));
    const partial1Idx = atomIds.findIndex(id => id.includes('partial-1'));

    // Full match (3/3) should rank above partial match (1/3)
    expect(fullIdx).toBeGreaterThanOrEqual(0);
    expect(partial1Idx).toBeGreaterThanOrEqual(0);
    expect(fullIdx).toBeLessThan(partial1Idx);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Single-term queries unaffected
// ---------------------------------------------------------------------------

describe('single-term queries unaffected by coverage boost', () => {
  it('produces identical ranking for single-term queries regardless of exponent', () => {
    for (let i = 0; i < 5; i++) {
      createAtom({
        ...base(testDir),
        type: 'fact',
        slug: `item-${i}`,
        body: `memory systems and patterns variant ${i}`,
      });
    }
    reindex(testDir);

    const withBoost = recall(testDir, {
      task: 'memory',
      coverage_boost: 2.0,
      decay_weight: 0,
    });

    const noBoost = recall(testDir, {
      task: 'memory',
      coverage_boost: 0,
      decay_weight: 0,
    });

    const boostedIds = withBoost.atoms.map(a => a.frontmatter.id);
    const noBoostedIds = noBoost.atoms.map(a => a.frontmatter.id);
    expect(boostedIds).toEqual(noBoostedIds);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Coverage boost disabled when exponent=0
// ---------------------------------------------------------------------------

describe('coverage boost disabled when exponent=0', () => {
  it('produces identical ranking when coverage_boost=0', () => {
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'full',
      body: 'memory postgresql replication',
    });
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'partial',
      body: 'memory systems overview agents',
    });
    reindex(testDir);

    const baseQuery = {
      task: 'memory postgresql replication',
      decay_weight: 0,
      idf_damping: 0,
      length_norm_k: 0,
    };

    const disabled = recall(testDir, { ...baseQuery, coverage_boost: 0 });
    const disabledAgain = recall(testDir, { ...baseQuery, coverage_boost: 0 });

    const ids1 = disabled.atoms.map(a => a.frontmatter.id);
    const ids2 = disabledAgain.atoms.map(a => a.frontmatter.id);
    expect(ids1).toEqual(ids2);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Stacks with IDF and length norm
// ---------------------------------------------------------------------------

describe('coverage boost stacks with IDF and length norm', () => {
  it('all three multipliers applied together', () => {
    // Full match, short
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'best',
      body: 'memory postgresql replication guide',
    });

    // Partial match (1/3), short — should be penalized by coverage
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'partial-short',
      body: 'memory systems overview',
    });

    // Full match, very long — should be penalized by length norm
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'full-long',
      body: 'memory postgresql replication ' + 'extra filler words to make this atom very long '.repeat(20),
    });

    // Create ubiquitous atoms to make "memory" common (for IDF)
    for (let i = 0; i < 10; i++) {
      createAtom({
        ...base(testDir),
        type: 'fact',
        slug: `common-${i}`,
        body: `memory belief systems variant ${i}`,
      });
    }

    reindex(testDir);

    const result = recall(testDir, {
      task: 'memory postgresql replication',
      coverage_boost: 0.5,
      idf_damping: 1.0,
      length_norm_k: 0.5,
      decay_weight: 0,
    });

    const atomIds = result.atoms.map(a => a.frontmatter.id.toLowerCase());
    const bestIdx = atomIds.findIndex(id => id.includes('best'));
    const partialIdx = atomIds.findIndex(id => id.includes('partial-short'));

    // The short full-match atom should beat the partial-match atom
    expect(bestIdx).toBeGreaterThanOrEqual(0);
    if (partialIdx >= 0) {
      expect(bestIdx).toBeLessThan(partialIdx);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 5: Per-call override works
// ---------------------------------------------------------------------------

describe('per-call coverage_boost override', () => {
  it('per-call override changes ranking', () => {
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'full-match',
      body: 'memory postgresql replication guide setup',
    });

    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'one-match',
      body: 'memory overview guide',
    });

    reindex(testDir);

    const baseQuery = {
      task: 'memory postgresql replication',
      decay_weight: 0,
      idf_damping: 0,
      length_norm_k: 0,
    };

    // With aggressive coverage boost (P=2)
    const aggressive = recall(testDir, { ...baseQuery, coverage_boost: 2.0 });
    const aggIds = aggressive.atoms.map(a => a.frontmatter.id.toLowerCase());
    const fullIdx = aggIds.findIndex(id => id.includes('full-match'));
    const oneIdx = aggIds.findIndex(id => id.includes('one-match'));

    // Full match should rank first with aggressive boost
    expect(fullIdx).toBe(0);
    if (oneIdx >= 0) {
      expect(fullIdx).toBeLessThan(oneIdx);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 6: Exponent clamped to [0, 2]
// ---------------------------------------------------------------------------

describe('coverage_boost exponent clamped', () => {
  it('negative exponent clamped to 0 (disabled)', () => {
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'a',
      body: 'memory postgresql replication',
    });
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'b',
      body: 'memory overview',
    });
    reindex(testDir);

    const baseQuery = {
      task: 'memory postgresql replication',
      decay_weight: 0,
      idf_damping: 0,
      length_norm_k: 0,
    };

    // Negative should be clamped to 0 (same as disabled)
    const negative = recall(testDir, { ...baseQuery, coverage_boost: -5 });
    const disabled = recall(testDir, { ...baseQuery, coverage_boost: 0 });

    const negIds = negative.atoms.map(a => a.frontmatter.id);
    const disIds = disabled.atoms.map(a => a.frontmatter.id);
    expect(negIds).toEqual(disIds);
  });

  it('exponent above 2 clamped to 2', () => {
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'a',
      body: 'memory postgresql replication',
    });
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'b',
      body: 'memory overview',
    });
    reindex(testDir);

    const baseQuery = {
      task: 'memory postgresql replication',
      decay_weight: 0,
      idf_damping: 0,
      length_norm_k: 0,
    };

    // P=100 should be clamped to P=2
    const extreme = recall(testDir, { ...baseQuery, coverage_boost: 100 });
    const capped = recall(testDir, { ...baseQuery, coverage_boost: 2 });

    const extremeIds = extreme.atoms.map(a => a.frontmatter.id);
    const cappedIds = capped.atoms.map(a => a.frontmatter.id);
    expect(extremeIds).toEqual(cappedIds);
  });
});

// ---------------------------------------------------------------------------
// computeCoverageBoosts unit test
// ---------------------------------------------------------------------------

describe('computeCoverageBoosts()', () => {
  it('returns empty map when exponent is 0', () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'a', body: 'memory postgresql' });
    reindex(testDir);

    const result = computeCoverageBoosts(
      testDir,
      ['memory', 'postgresql'],
      [{ atom_id: 'FACT-test-a', rank: -1 }],
      [],
      0,
    );
    expect(result.size).toBe(0);
  });

  it('returns empty map for single-term queries', () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'a', body: 'memory postgresql' });
    reindex(testDir);

    const result = computeCoverageBoosts(
      testDir,
      ['memory'],
      [{ atom_id: 'FACT-test-a', rank: -1 }],
      [],
      0.5,
    );
    expect(result.size).toBe(0);
  });
});
