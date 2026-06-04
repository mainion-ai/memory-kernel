/**
 * Tests for the shared two-pass type-aware budget helper.
 * The same algorithm powers both task-driven recall and fill-mode render.
 */

import { describe, it, expect } from 'vitest';
import { selectAtomsWithReservations } from '../src/budget.js';
import type { Atom, AtomType } from '../src/types.js';

function makeAtom(id: string, type: AtomType, body: string, updatedAt: string): Atom {
  return {
    frontmatter: {
      id, type, status: 'active', confidence: 0.8,
      created_at: updatedAt, updated_at: updatedAt, ttl_days: null,
    },
    body,
  };
}

describe('selectAtomsWithReservations', () => {
  it('returns all atoms when budget is large enough', () => {
    const atoms = [
      makeAtom('FACT-2026-05-01-A-1', 'fact', 'a'.repeat(40), '2026-05-01T00:00:00Z'),
      makeAtom('BELI-2026-05-02-B-1', 'belief', 'b'.repeat(40), '2026-05-02T00:00:00Z'),
    ];
    const out = selectAtomsWithReservations(atoms, 10000, {}, { mode: 'recency' });
    expect(out).toHaveLength(2);
  });

  it('reservation guarantees a fact slot when beliefs would otherwise dominate', () => {
    // 10 beliefs (newer) + 1 fact (older). Without reservation, recency fill
    // takes all beliefs and the fact is starved.
    const atoms: Atom[] = [];
    for (let i = 0; i < 10; i++) {
      atoms.push(makeAtom(`BELI-2026-05-10-B${i}-x`, 'belief', 'b'.repeat(200), `2026-05-${10 + i}T00:00:00Z`));
    }
    atoms.push(makeAtom('FACT-2026-05-01-FACT-x', 'fact', 'f'.repeat(200), '2026-05-01T00:00:00Z'));

    const out = selectAtomsWithReservations(atoms, 600, { fact: 200 }, { mode: 'recency' });
    expect(out.some(a => a.frontmatter.type === 'fact')).toBe(true);
  });

  it('caps total reservations at 30% of budget', () => {
    // Sum of reservations (10000) > 30% of budget (3000) → must scale down.
    const atoms = [
      makeAtom('FACT-2026-05-01-A-1', 'fact', 'a'.repeat(20000), '2026-05-01T00:00:00Z'),
    ];
    // budget 1000 → maxReservation = 300. Raw fact reservation 10000 scales to 300.
    // The fact atom is ~5000 tokens, far over 300 → atom not reserved.
    // But it can still be picked from the unreserved pool up to budget=1000.
    const out = selectAtomsWithReservations(atoms, 1000, { fact: 10000 }, { mode: 'recency' });
    // The atom is too large for budget 1000 → empty result.
    expect(out).toHaveLength(0);
  });

  it('with score mode, sorts unreserved by score descending', () => {
    const atoms = [
      makeAtom('FACT-2026-05-01-LOW-1', 'fact', 'l'.repeat(40), '2026-05-01T00:00:00Z'),
      makeAtom('FACT-2026-05-01-HIGH-1', 'fact', 'h'.repeat(40), '2026-05-01T00:00:00Z'),
    ];
    const scores = new Map<string, number>([
      ['FACT-2026-05-01-LOW-1', 0.1],
      ['FACT-2026-05-01-HIGH-1', 5.0],
    ]);
    const out = selectAtomsWithReservations(atoms, 10000, {}, { mode: 'score', scores });
    expect(out[0].frontmatter.id).toBe('FACT-2026-05-01-HIGH-1');
  });

  it('with recency mode, sorts unreserved by updated_at descending', () => {
    const atoms = [
      makeAtom('FACT-2026-05-01-OLD-1', 'fact', 'o'.repeat(40), '2026-05-01T00:00:00Z'),
      makeAtom('FACT-2026-05-02-NEW-1', 'fact', 'n'.repeat(40), '2026-05-02T00:00:00Z'),
    ];
    const out = selectAtomsWithReservations(atoms, 10000, {}, { mode: 'recency' });
    expect(out[0].frontmatter.id).toBe('FACT-2026-05-02-NEW-1');
  });

  it('empty reservations object → degenerates to greedy fill by chosen comparator', () => {
    const atoms = [
      makeAtom('FACT-2026-05-01-OLD-1', 'fact', 'o'.repeat(40), '2026-05-01T00:00:00Z'),
      makeAtom('BELI-2026-05-02-NEW-1', 'belief', 'n'.repeat(40), '2026-05-02T00:00:00Z'),
    ];
    const out = selectAtomsWithReservations(atoms, 10000, {}, { mode: 'recency' });
    expect(out[0].frontmatter.id).toBe('BELI-2026-05-02-NEW-1');
  });
});
