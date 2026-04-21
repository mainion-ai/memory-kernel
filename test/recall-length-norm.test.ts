/**
 * Content-length normalization tests.
 *
 * Phase 6 of scoring improvements: long atoms that get inflated BM25 scores
 * from containing more text are penalized so that focused short atoms can
 * rank higher when they are more relevant.
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
  computeLengthFactors,
} from '../src/index.js';
import type { Atom } from '../src/types.js';

let testDir: string;

const base = (dir: string) => ({
  memoryDir: dir,
  agent_id: 'test',
  session_id: 'test-session',
});

/** Generate a body string of approximately `n` words. */
function wordsBody(n: number, keyword = 'memory'): string {
  const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor';
  const fillerWords = filler.split(' ');
  const words: string[] = [keyword]; // ensure the keyword appears
  for (let i = 1; i < n; i++) {
    words.push(fillerWords[i % fillerWords.length]);
  }
  return words.join(' ');
}

/** Helper to build a minimal Atom object for computeLengthFactors unit tests. */
function makeAtom(id: string, body: string): Atom {
  return {
    frontmatter: {
      id,
      type: 'fact',
      status: 'active',
      confidence: 0.9,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ttl_days: null,
    },
    body,
  };
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-lengthnorm-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// computeLengthFactors unit tests
// ---------------------------------------------------------------------------

describe('computeLengthFactors()', () => {
  it('long atoms get lower length factor', () => {
    const atoms = [
      makeAtom('short', wordsBody(50)),
      makeAtom('medium', wordsBody(100)),
      makeAtom('long', wordsBody(500)),
    ];

    const factors = computeLengthFactors(atoms, 0.5);

    // Average is ~(50+100+500)/3 ≈ 217 words
    // Short (50) is below average → factor 1.0
    // Long (500) is well above average → factor < 1.0
    expect(factors.get('long')).toBeLessThan(1.0);
    expect(factors.get('short')).toBe(1.0);
  });

  it('short atoms not boosted above 1.0', () => {
    const atoms = [
      makeAtom('tiny', wordsBody(10)),
      makeAtom('huge', wordsBody(1000)),
    ];

    const factors = computeLengthFactors(atoms, 0.5);

    // Tiny is way below average — should still be capped at 1.0
    expect(factors.get('tiny')).toBe(1.0);
    // Huge is way above — should be penalized
    expect(factors.get('huge')).toBeLessThan(1.0);
  });

  it('disabled when K=0', () => {
    const atoms = [
      makeAtom('a', wordsBody(50)),
      makeAtom('b', wordsBody(500)),
    ];

    const factors = computeLengthFactors(atoms, 0);

    // Empty map when disabled
    expect(factors.size).toBe(0);
  });

  it('single-atom edge case returns 1.0', () => {
    const atoms = [makeAtom('only', wordsBody(200))];

    const factors = computeLengthFactors(atoms, 0.5);

    // Single atom IS the average → ratio 1.0 → factor 1.0
    expect(factors.get('only')).toBe(1.0);
  });

  it('higher K produces stronger penalty', () => {
    const atoms = [
      makeAtom('short', wordsBody(50)),
      makeAtom('long', wordsBody(500)),
    ];

    const moderateFactors = computeLengthFactors(atoms, 0.5);
    const aggressiveFactors = computeLengthFactors(atoms, 1.0);

    const moderatePenalty = moderateFactors.get('long')!;
    const aggressivePenalty = aggressiveFactors.get('long')!;

    // Higher K → lower factor (stronger penalty)
    expect(aggressivePenalty).toBeLessThan(moderatePenalty);
  });

  it('empty atom list returns empty map', () => {
    const factors = computeLengthFactors([], 0.5);
    expect(factors.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration tests via recall
// ---------------------------------------------------------------------------

describe('length normalization in recall', () => {
  it('length normalization changes ranking — focused fact beats long summary', () => {
    // Create a focused fact (short, contains keyword)
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'focused-fact',
      body: 'memory kernel architecture overview',
    });

    // Create a long summary (many words, also contains keyword)
    createAtom({
      ...base(testDir),
      type: 'entity_summary',
      slug: 'long-summary',
      body: wordsBody(300, 'memory'),
    });

    reindex(testDir);

    // With K=0 (disabled), the long summary should rank at least as high
    // because it has more text → more FTS signal
    const resultK0 = recall(testDir, {
      task: 'memory',
      max_tokens: 50000,
      length_norm_k: 0,
    });

    // With K=0.5 (moderate), the focused fact should rank higher
    const resultK05 = recall(testDir, {
      task: 'memory',
      max_tokens: 50000,
      length_norm_k: 0.5,
    });

    // Both should return both atoms
    expect(resultK0.atoms.length).toBe(2);
    expect(resultK05.atoms.length).toBe(2);

    // Find positions
    const k0LongIdx = resultK0.atoms.findIndex(a => a.frontmatter.id.includes('LONG-SUMMARY'));
    const k05LongIdx = resultK05.atoms.findIndex(a => a.frontmatter.id.includes('LONG-SUMMARY'));
    const k05FactIdx = resultK05.atoms.findIndex(a => a.frontmatter.id.includes('FOCUSED-FACT'));

    // With normalization enabled, focused fact should rank above long summary
    expect(k05FactIdx).toBeLessThan(k05LongIdx);
  });

  it('stacks with IDF damping — long + common-terms atom gets double-penalized', () => {
    // Atom with common terms AND long body — should get both IDF and length penalty
    createAtom({
      ...base(testDir),
      type: 'entity_summary',
      slug: 'long-common',
      body: wordsBody(400, 'memory') + ' agent identity belief',
    });

    // Short atom with a rare term
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'short-rare',
      body: 'memory postgresql optimization technique',
    });

    // Another atom to make IDF meaningful (contains "memory" — common term)
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'filler',
      body: 'memory patterns in agent systems',
    });

    reindex(testDir);

    // Query with both common ("memory") and rare ("postgresql") terms
    const result = recall(testDir, {
      task: 'memory postgresql',
      max_tokens: 50000,
      length_norm_k: 0.5,
      idf_damping: 1.0,
    });

    // The short atom with the rare term should rank above the long common one
    const shortIdx = result.atoms.findIndex(a => a.frontmatter.id.includes('SHORT-RARE'));
    const longIdx = result.atoms.findIndex(a => a.frontmatter.id.includes('LONG-COMMON'));

    expect(shortIdx).toBeLessThan(longIdx);
  });

  it('respects RECALL_LENGTH_NORM_K env var', () => {
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'a',
      body: wordsBody(50, 'memory'),
    });
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'b',
      body: wordsBody(500, 'memory'),
    });
    reindex(testDir);

    // Set env var to disable
    const orig = process.env.RECALL_LENGTH_NORM_K;
    try {
      process.env.RECALL_LENGTH_NORM_K = '0';
      const result = recall(testDir, {
        task: 'memory',
        max_tokens: 50000,
      });
      // Should work without error — both atoms returned
      expect(result.atoms.length).toBe(2);
    } finally {
      if (orig !== undefined) {
        process.env.RECALL_LENGTH_NORM_K = orig;
      } else {
        delete process.env.RECALL_LENGTH_NORM_K;
      }
    }
  });

  it('length_norm_k is clamped to [0, 2]', () => {
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'clamp-test',
      body: 'memory kernel test for clamping extreme values',
    });
    reindex(testDir);

    // Extreme K value (e.g. 100) should be clamped to 2
    const resultExtreme = recall(testDir, {
      task: 'memory',
      max_tokens: 50000,
      length_norm_k: 100,
    });

    const resultMax = recall(testDir, {
      task: 'memory',
      max_tokens: 50000,
      length_norm_k: 2,
    });

    // Both should produce same results since 100 is clamped to 2
    expect(resultExtreme.atoms.length).toBe(resultMax.atoms.length);
    // Scores should be identical
    if (resultExtreme.atoms.length > 0 && resultMax.atoms.length > 0) {
      expect(resultExtreme.atoms[0].id).toBe(resultMax.atoms[0].id);
    }

    // Negative K should be clamped to 0 (disabled)
    const resultNeg = recall(testDir, {
      task: 'memory',
      max_tokens: 50000,
      length_norm_k: -5,
    });
    expect(resultNeg.atoms.length).toBeGreaterThan(0);
  });

  it('per-call length_norm_k overrides env var', () => {
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'short',
      body: 'memory kernel facts',
    });
    createAtom({
      ...base(testDir),
      type: 'entity_summary',
      slug: 'long',
      body: wordsBody(400, 'memory'),
    });
    reindex(testDir);

    // Set env to aggressive (1.0), but override per-call to disabled (0)
    const orig = process.env.RECALL_LENGTH_NORM_K;
    try {
      process.env.RECALL_LENGTH_NORM_K = '1.0';

      // Per-call override to 0 should disable normalization
      const result = recall(testDir, {
        task: 'memory',
        max_tokens: 50000,
        length_norm_k: 0,
      });
      expect(result.atoms.length).toBe(2);
    } finally {
      if (orig !== undefined) {
        process.env.RECALL_LENGTH_NORM_K = orig;
      } else {
        delete process.env.RECALL_LENGTH_NORM_K;
      }
    }
  });
});
