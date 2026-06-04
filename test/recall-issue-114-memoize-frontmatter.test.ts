/**
 * Issue #114: memoize JSON.stringify(frontmatter) for token counting.
 *
 * `JSON.stringify(atom.frontmatter)` was being called repeatedly per atom
 * (once in `atomTokens()` inside `budget.ts`, once in the `recall()` final
 * reduce). For large filtered sets this becomes a hot path. Memoizing via a
 * WeakMap keyed by the frontmatter reference is safe (frontmatter objects
 * are immutable once read) and avoids redundant work.
 *
 * This file serves as a regression guard: token counts must be stable
 * across repeated calls, and the public output must not change.
 */

import { describe, it, expect } from 'vitest';
import { selectAtomsWithReservations, frontmatterJson, estimateTokens } from '../src/budget.js';
import type { Atom, AtomType } from '../src/types.js';

function makeAtom(id: string, type: AtomType, body: string, updatedAt: string): Atom {
  return {
    frontmatter: {
      id,
      type,
      status: 'active',
      confidence: 0.8,
      created_at: updatedAt,
      updated_at: updatedAt,
      ttl_days: null,
    },
    body,
  };
}

describe('frontmatter JSON memoization (issue #114)', () => {
  it('frontmatterJson returns the same string for the same frontmatter reference', () => {
    const atom = makeAtom('FACT-2026-05-20-A-1', 'fact', 'alpha', '2026-05-20T00:00:00Z');
    const a = frontmatterJson(atom.frontmatter);
    const b = frontmatterJson(atom.frontmatter);
    expect(a).toBe(b);
    expect(a).toBe(JSON.stringify(atom.frontmatter));
  });

  it('frontmatterJson returns identical content for distinct frontmatter objects with same shape', () => {
    const fm1 = makeAtom('FACT-X-1', 'fact', 'x', '2026-05-20T00:00:00Z').frontmatter;
    const fm2 = makeAtom('FACT-X-1', 'fact', 'x', '2026-05-20T00:00:00Z').frontmatter;
    expect(frontmatterJson(fm1)).toBe(frontmatterJson(fm2));
  });

  it('selectAtomsWithReservations produces stable output across repeated calls', () => {
    // Regression guard: caching JSON.stringify must not change selection results.
    const atoms = [
      makeAtom('FACT-2026-05-20-A-1', 'fact', 'a'.repeat(100), '2026-05-20T00:00:00Z'),
      makeAtom('FACT-2026-05-20-B-1', 'fact', 'b'.repeat(100), '2026-05-19T00:00:00Z'),
      makeAtom('FACT-2026-05-20-C-1', 'fact', 'c'.repeat(100), '2026-05-18T00:00:00Z'),
    ];
    const out1 = selectAtomsWithReservations(atoms, 200, {}, { mode: 'recency' });
    const out2 = selectAtomsWithReservations(atoms, 200, {}, { mode: 'recency' });
    expect(out1.map((a) => a.frontmatter.id)).toEqual(out2.map((a) => a.frontmatter.id));
  });

  it('estimateTokens for atom body + frontmatter is consistent across calls', () => {
    const atom = makeAtom('FACT-2026-05-20-A-1', 'fact', 'hello world', '2026-05-20T00:00:00Z');
    const t1 = estimateTokens(atom.body + frontmatterJson(atom.frontmatter));
    const t2 = estimateTokens(atom.body + frontmatterJson(atom.frontmatter));
    expect(t1).toBe(t2);
  });
});
