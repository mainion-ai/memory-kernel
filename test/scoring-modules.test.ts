/**
 * Unit tests for the extracted pure scoring modules (src/scoring/*).
 *
 * These lock the behavior of the IO-free ranking primitives at their new
 * module locations after they were extracted out of the recall() orchestrator
 * (arch-review Phase A). Behavior is identical to the pre-extraction code;
 * recall.ts re-exports the same names so the public barrel is unchanged.
 */
import { describe, it, expect } from 'vitest';
import { temporalDecay } from '../src/scoring/temporal.js';
import { computeTextSimilarity, applyMMR } from '../src/scoring/diversity.js';
import { computeLengthFactors } from '../src/scoring/length.js';
import { applyGraphBoost } from '../src/scoring/graph-boost.js';
import type { Atom } from '../src/types.js';

const DAY_MS = 1000 * 60 * 60 * 24;

/** Minimal Atom stub — the pure scorers only read `frontmatter.id` and `body`. */
function atom(id: string, body: string): Atom {
  return { frontmatter: { id }, body } as unknown as Atom;
}

describe('scoring/temporal — temporalDecay', () => {
  it('returns 1.0 for an atom created now', () => {
    expect(temporalDecay(new Date().toISOString(), 30)).toBeCloseTo(1.0, 5);
  });

  it('returns ~0.5 at one half-life of age', () => {
    const createdAt = new Date(Date.now() - 30 * DAY_MS).toISOString();
    expect(temporalDecay(createdAt, 30)).toBeCloseTo(0.5, 2);
  });

  it('clamps future-dated atoms to 1.0', () => {
    const createdAt = new Date(Date.now() + 10 * DAY_MS).toISOString();
    expect(temporalDecay(createdAt, 30)).toBe(1.0);
  });

  it('returns 0 when half-life is non-positive (division guard)', () => {
    expect(temporalDecay(new Date().toISOString(), 0)).toBe(0);
  });
});

describe('scoring/diversity — computeTextSimilarity', () => {
  it('is 1.0 for identical text', () => {
    const t = 'the quick brown fox jumps over the lazy dog';
    expect(computeTextSimilarity(t, t)).toBe(1.0);
  });

  it('is 0.0 for texts with no shared trigrams', () => {
    expect(
      computeTextSimilarity('alpha beta gamma delta', 'one two three four'),
    ).toBe(0.0);
  });
});

describe('scoring/diversity — applyMMR', () => {
  it('returns the input unchanged when lambda >= 1.0 (no diversification)', () => {
    const scored = [
      { atom: atom('A', 'aaa bbb ccc ddd'), score: 0.9 },
      { atom: atom('B', 'eee fff ggg hhh'), score: 0.5 },
    ];
    expect(applyMMR(scored, 1.0)).toBe(scored);
  });

  it('selects the highest-scoring atom first', () => {
    const scored = [
      { atom: atom('LOW', 'lorem ipsum dolor sit amet'), score: 0.2 },
      { atom: atom('HIGH', 'completely different words here now'), score: 0.95 },
    ];
    const ranked = applyMMR(scored, 0.7);
    expect(ranked[0].atom.frontmatter.id).toBe('HIGH');
  });
});

describe('scoring/length — computeLengthFactors', () => {
  it('returns an empty map when k is 0 (disabled)', () => {
    expect(computeLengthFactors([atom('A', 'a b c')], 0).size).toBe(0);
  });

  it('returns an empty map for an empty atom list', () => {
    expect(computeLengthFactors([], 0.5).size).toBe(0);
  });

  it('penalizes above-average-length atoms (factor < 1) and leaves short ones at 1.0', () => {
    const short = atom('SHORT', 'one two');
    const long = atom('LONG', Array.from({ length: 40 }, (_, i) => `w${i}`).join(' '));
    const factors = computeLengthFactors([short, long], 0.5);
    expect(factors.get('SHORT')).toBe(1.0);
    expect(factors.get('LONG')!).toBeLessThan(1.0);
  });
});

describe('scoring/graph-boost — applyGraphBoost', () => {
  it('lifts a neighbor of a high-scoring atom (undirected)', () => {
    const scores = new Map<string, number>([['A', 1.0]]);
    applyGraphBoost(scores, [{ source_id: 'A', target_id: 'B' }], 0.15);
    expect(scores.get('B')!).toBeGreaterThan(0);
  });

  it('is a no-op when boost is 0', () => {
    const scores = new Map<string, number>([['A', 1.0]]);
    applyGraphBoost(scores, [{ source_id: 'A', target_id: 'B' }], 0);
    expect(scores.has('B')).toBe(false);
    expect(scores.get('A')).toBe(1.0);
  });
});
