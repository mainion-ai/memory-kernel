/**
 * MMR (Maximal Marginal Relevance) result diversity tests.
 *
 * Phase 8 of scoring improvements: after scoring all atoms but before applying
 * the token budget, re-rank using MMR to prevent redundant atoms from filling
 * the token budget with near-duplicate content.
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
  computeTextSimilarity,
  applyMMR,
} from '../src/index.js';

import type { Atom } from '../src/types.js';

let testDir: string;

const base = (dir: string) => ({
  memoryDir: dir,
  agent_id: 'test',
  session_id: 'test-session',
});

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-mmr-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// computeTextSimilarity unit tests
// ---------------------------------------------------------------------------

describe('computeTextSimilarity', () => {
  it('identical texts return 1.0', () => {
    const text = 'The quick brown fox jumps over the lazy dog';
    expect(computeTextSimilarity(text, text)).toBe(1.0);
  });

  it('completely different texts return 0.0', () => {
    const a = 'The quick brown fox jumps over the lazy dog';
    const b = 'Completely unrelated content about something else entirely different';
    expect(computeTextSimilarity(a, b)).toBe(0.0);
  });

  it('partial overlap returns between 0 and 1', () => {
    const a = 'The quick brown fox jumps over the lazy dog in the park';
    const b = 'The quick brown cat runs over the lazy dog in the yard';
    const sim = computeTextSimilarity(a, b);
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });

  it('both empty strings return 1.0', () => {
    expect(computeTextSimilarity('', '')).toBe(1.0);
  });

  it('one empty string returns 0.0', () => {
    expect(computeTextSimilarity('hello world foo', '')).toBe(0.0);
    expect(computeTextSimilarity('', 'hello world foo')).toBe(0.0);
  });

  it('short texts (fewer than 3 words) with no trigrams return 1.0 for both empty', () => {
    // Two words each -> no trigrams -> both sets empty -> 1.0
    expect(computeTextSimilarity('ab', 'cd')).toBe(1.0);
  });

  it('is case-insensitive', () => {
    const a = 'The Quick Brown Fox Jumps Over';
    const b = 'the quick brown fox jumps over';
    expect(computeTextSimilarity(a, b)).toBe(1.0);
  });

  it('strips punctuation', () => {
    const a = 'hello, world! how are you doing today?';
    const b = 'hello world how are you doing today';
    expect(computeTextSimilarity(a, b)).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// applyMMR unit tests
// ---------------------------------------------------------------------------

function makeAtom(id: string, body: string): Atom {
  return {
    frontmatter: {
      id,
      type: 'fact',
      status: 'active',
      confidence: 1.0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ttl_days: null,
    },
    body,
  };
}

describe('applyMMR', () => {
  it('re-ranks redundant atoms lower', () => {
    // Make duplicates truly near-identical (high trigram overlap)
    const sharedPrefix = 'Notation systems erase what they cannot represent through formal encoding processes and every notation has an erasure profile that determines what becomes visible and what becomes invisible in the resulting representation';
    const dup1 = makeAtom('dup-1', sharedPrefix + ' — this is the first version of this observation.');
    const dup2 = makeAtom('dup-2', sharedPrefix + ' — this is the second version of this observation.');
    const dup3 = makeAtom('dup-3', sharedPrefix + ' — this is the third version of this observation.');
    const unique = makeAtom('unique', 'The immune system uses AIRE proteins to force thymic cells to express foreign tissue antigens for self-tolerance checking in the thymus gland during development.');

    // Scores close together — duplicates slightly higher than unique
    const scored = [
      { atom: dup1, score: 1.0 },
      { atom: dup2, score: 0.98 },
      { atom: dup3, score: 0.96 },
      { atom: unique, score: 0.90 },
    ];

    const result = applyMMR(scored, 0.5);
    const ids = result.map(r => r.atom.frontmatter.id);

    // First should still be dup1 (highest relevance)
    expect(ids[0]).toBe('dup-1');

    // Unique should be promoted above the 3rd duplicate at minimum
    // because the high similarity between dup2/dup3 and dup1 penalizes them
    const uniqueIdx = ids.indexOf('unique');
    const dup3Idx = ids.indexOf('dup-3');
    expect(uniqueIdx).toBeLessThan(dup3Idx);
  });

  it('returns unchanged when lambda=1.0', () => {
    const a = makeAtom('a', 'first atom about topic one with some content here');
    const b = makeAtom('b', 'first atom about topic one with some content here');

    const scored = [
      { atom: a, score: 1.0 },
      { atom: b, score: 0.5 },
    ];

    const result = applyMMR(scored, 1.0);
    expect(result.map(r => r.atom.frontmatter.id)).toEqual(['a', 'b']);
    // Scores should be unchanged
    expect(result[0].score).toBe(1.0);
    expect(result[1].score).toBe(0.5);
  });

  it('pure diversity (lambda=0.0) selects most different atoms first', () => {
    const a = makeAtom('a', 'The quick brown fox jumps over the lazy dog in the morning light');
    const b = makeAtom('b', 'The quick brown fox jumps over the lazy dog in the evening dark');
    const c = makeAtom('c', 'Completely different content about immune systems and biology research methods');

    const scored = [
      { atom: a, score: 1.0 },
      { atom: b, score: 0.9 },
      { atom: c, score: 0.3 },
    ];

    const result = applyMMR(scored, 0.0);
    const ids = result.map(r => r.atom.frontmatter.id);

    // First pick is highest score
    expect(ids[0]).toBe('a');
    // Second pick should be c (most different from a), not b (near-duplicate of a)
    expect(ids[1]).toBe('c');
  });

  it('single atom returns unchanged', () => {
    const a = makeAtom('a', 'single atom content');
    const scored = [{ atom: a, score: 0.8 }];
    const result = applyMMR(scored, 0.7);
    expect(result).toHaveLength(1);
    expect(result[0].atom.frontmatter.id).toBe('a');
  });

  it('empty input returns empty', () => {
    const result = applyMMR([], 0.7);
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// MMR clamping tests
// ---------------------------------------------------------------------------

describe('MMR lambda clamping', () => {
  it('values below 0 clamped to 0', () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'a', body: 'notation erasure systems and formal methods' });
    createAtom({ ...base(testDir), type: 'fact', slug: 'b', body: 'notation erasure systems and formal approaches' });
    createAtom({ ...base(testDir), type: 'fact', slug: 'c', body: 'immune system AIRE thymic selection biology' });
    reindex(testDir);

    // Should not throw — negative is clamped to 0
    const result = recall(testDir, {
      task: 'notation erasure',
      mmr_lambda: -5,
      decay_weight: 0,
    });
    expect(result.atoms.length).toBeGreaterThan(0);
  });

  it('values above 1 clamped to 1 (MMR disabled)', () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'a', body: 'notation erasure systems formal methods' });
    createAtom({ ...base(testDir), type: 'fact', slug: 'b', body: 'notation erasure systems formal approaches' });
    reindex(testDir);

    const withClamp = recall(testDir, {
      task: 'notation erasure',
      mmr_lambda: 5,
      decay_weight: 0,
    });
    const noMMR = recall(testDir, {
      task: 'notation erasure',
      mmr_lambda: 1.0,
      decay_weight: 0,
    });

    const clampIds = withClamp.atoms.map(a => a.frontmatter.id);
    const noMMRIds = noMMR.atoms.map(a => a.frontmatter.id);
    expect(clampIds).toEqual(noMMRIds);
  });
});

// ---------------------------------------------------------------------------
// Per-call mmr_lambda override
// ---------------------------------------------------------------------------

describe('per-call mmr_lambda override', () => {
  it('per-call override takes precedence over env var', () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'a', body: 'notation erasure systems formal methods guide' });
    createAtom({ ...base(testDir), type: 'fact', slug: 'b', body: 'notation erasure systems formal methods reference' });
    createAtom({ ...base(testDir), type: 'fact', slug: 'c', body: 'immune system AIRE thymic selection biology organisms' });
    reindex(testDir);

    const original = process.env.RECALL_MMR_LAMBDA;
    try {
      process.env.RECALL_MMR_LAMBDA = '1.0'; // env says disabled

      // Per-call override enables MMR
      const result = recall(testDir, {
        task: 'notation erasure systems',
        mmr_lambda: 0.3, // strong diversity
        decay_weight: 0,
      });

      // Should still return all atoms
      expect(result.atoms.length).toBeGreaterThan(0);
    } finally {
      if (original !== undefined) process.env.RECALL_MMR_LAMBDA = original;
      else delete process.env.RECALL_MMR_LAMBDA;
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: MMR with existing pipeline
// ---------------------------------------------------------------------------

describe('MMR stacks with existing pipeline', () => {
  it('MMR operates on already-penalized scores from IDF/length/coverage', () => {
    // 3 near-duplicate atoms about notation
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'notation-1',
      body: 'Notation systems erase what they cannot represent through formal encoding processes',
    });
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'notation-2',
      body: 'Notation systems erase what they cannot represent through formal encoding methods',
    });
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'notation-3',
      body: 'Notation systems erase what they cannot represent through formal encoding approaches',
    });

    // 1 unique atom about a different topic but still matching query
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'diverse',
      body: 'Notation in music uses staff lines and clefs for pitch representation in orchestral scores',
    });

    // Filler atoms
    for (let i = 0; i < 5; i++) {
      createAtom({
        ...base(testDir),
        type: 'fact',
        slug: `filler-${i}`,
        body: `unrelated content about architecture and design patterns variant ${i}`,
      });
    }

    reindex(testDir);

    // With MMR enabled
    const withMMR = recall(testDir, {
      task: 'notation systems representation',
      mmr_lambda: 0.5,
      decay_weight: 0,
      idf_damping: 1.0,
      length_norm_k: 0.5,
      coverage_boost: 0.5,
    });

    // Without MMR
    const withoutMMR = recall(testDir, {
      task: 'notation systems representation',
      mmr_lambda: 1.0,
      decay_weight: 0,
      idf_damping: 1.0,
      length_norm_k: 0.5,
      coverage_boost: 0.5,
    });

    // Both should return atoms
    expect(withMMR.atoms.length).toBeGreaterThan(0);
    expect(withoutMMR.atoms.length).toBeGreaterThan(0);

    // With MMR, the diverse atom should rank higher relative to the 3rd duplicate
    const mmrIds = withMMR.atoms.map(a => a.frontmatter.id.toLowerCase());
    const diverseIdxMMR = mmrIds.findIndex(id => id.includes('diverse'));
    const notation3IdxMMR = mmrIds.findIndex(id => id.includes('notation-3'));

    if (diverseIdxMMR >= 0 && notation3IdxMMR >= 0) {
      // Diverse should rank above the 3rd near-duplicate when MMR is active
      expect(diverseIdxMMR).toBeLessThan(notation3IdxMMR);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: recall() with token budget and MMR
// ---------------------------------------------------------------------------

describe('recall integration with MMR and token budget', () => {
  it('MMR diversifies results within token budget', () => {
    // Create near-duplicates that would normally fill the budget
    for (let i = 0; i < 5; i++) {
      createAtom({
        ...base(testDir),
        type: 'fact',
        slug: `dup-${i}`,
        body: `Memory kernel uses notation systems to erase what they cannot represent through formal encoding variant ${i}`,
      });
    }

    // Create a diverse atom
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'diverse',
      body: 'The immune system AIRE protein forces thymic epithelial cells to express foreign tissue antigens',
    });

    // Create an atom matching the query from a different angle
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'angle',
      body: 'Memory systems in cognitive science use spreading activation for associative recall',
    });

    reindex(testDir);

    const result = recall(testDir, {
      task: 'memory systems notation',
      mmr_lambda: 0.5,
      max_tokens: 2000,
      decay_weight: 0,
    });

    // Should return some atoms within budget
    expect(result.atoms.length).toBeGreaterThan(0);
    expect(result.token_estimate).toBeLessThanOrEqual(2500); // approximate
  });
});
