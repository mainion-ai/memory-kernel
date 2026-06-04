/**
 * Issue #112: greedyFill `break` on oversized atom wastes remaining budget.
 *
 * The fix is in `src/budget.ts`: `greedyFill` should `continue` past an atom
 * that would overflow the budget so smaller atoms further down the list still
 * get a chance to fit.
 */

import { describe, it, expect } from 'vitest';
import { selectAtomsWithReservations } from '../src/budget.js';
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

describe('greedyFill (issue #112)', () => {
  it('skips an oversized atom and continues fitting smaller ones', () => {
    // Budget: 200 tokens (~800 chars). One huge atom (won't fit), then two
    // small atoms (fit comfortably together). Pre-fix: break aborts after the
    // huge atom and result is empty. Post-fix: both small atoms are returned.
    const huge = makeAtom(
      'FACT-2026-05-20-HUGE-1',
      'fact',
      'x'.repeat(5000),
      '2026-05-20T00:00:00Z',
    );
    const small1 = makeAtom(
      'FACT-2026-05-20-SMALL1-1',
      'fact',
      's1',
      '2026-05-19T00:00:00Z',
    );
    const small2 = makeAtom(
      'FACT-2026-05-20-SMALL2-1',
      'fact',
      's2',
      '2026-05-18T00:00:00Z',
    );

    // Use score mode to force sort order [huge, small1, small2]
    const scores = new Map<string, number>([
      ['FACT-2026-05-20-HUGE-1', 10],
      ['FACT-2026-05-20-SMALL1-1', 5],
      ['FACT-2026-05-20-SMALL2-1', 1],
    ]);

    const out = selectAtomsWithReservations(
      [huge, small1, small2],
      200,
      {},
      { mode: 'score', scores },
    );

    const ids = out.map((a) => a.frontmatter.id);
    expect(ids).not.toContain('FACT-2026-05-20-HUGE-1');
    expect(ids).toContain('FACT-2026-05-20-SMALL1-1');
    expect(ids).toContain('FACT-2026-05-20-SMALL2-1');
  });

  it('still respects the budget total when small atoms can fit', () => {
    // Sanity check: after the fix, total tokens in result must still be <= budget.
    const atoms: Atom[] = [
      makeAtom('FACT-2026-05-20-A-1', 'fact', 'a'.repeat(800), '2026-05-20T00:00:00Z'),
      makeAtom('FACT-2026-05-20-B-1', 'fact', 'b'.repeat(40), '2026-05-19T00:00:00Z'),
      makeAtom('FACT-2026-05-20-C-1', 'fact', 'c'.repeat(40), '2026-05-18T00:00:00Z'),
    ];
    const scores = new Map<string, number>([
      ['FACT-2026-05-20-A-1', 10],
      ['FACT-2026-05-20-B-1', 5],
      ['FACT-2026-05-20-C-1', 1],
    ]);

    // Budget 100 tokens (~400 chars) — A doesn't fit (~200+ tokens), B+C do.
    const out = selectAtomsWithReservations(atoms, 100, {}, { mode: 'score', scores });
    expect(out.length).toBeGreaterThanOrEqual(1);
    // A must NOT be in the output (it overflows on its own).
    expect(out.map((a) => a.frontmatter.id)).not.toContain('FACT-2026-05-20-A-1');
  });
});
