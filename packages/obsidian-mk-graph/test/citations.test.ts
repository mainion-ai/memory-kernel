import { describe, it, expect } from 'vitest';
import { countIncomingCitations } from '../src/citations.js';
import type { ParsedAtom } from '../src/atom-parser.js';

function atom(id: string, relTargets: string[]): ParsedAtom {
  return {
    id,
    type: 'fact',
    status: 'active',
    classification: 'TEAM',
    confidence: 1.0,
    createdAt: '2026-04-29T10:00:00Z',
    updatedAt: '2026-04-29T10:00:00Z',
    ttlDays: null,
    tags: [],
    relations: relTargets.map((target) => ({ target, type: 'related' })),
    body: '',
  };
}

describe('countIncomingCitations', () => {
  it('counts inbound edges per atom id', () => {
    const atoms: ParsedAtom[] = [
      atom('A', ['B', 'C']),
      atom('B', ['C']),
      atom('C', []),
    ];
    const counts = countIncomingCitations(atoms);
    expect(counts.get('A')).toBeUndefined();
    expect(counts.get('B')).toBe(1);
    expect(counts.get('C')).toBe(2);
  });

  it('returns 0 (undefined) for atoms with no inbound edges', () => {
    const atoms: ParsedAtom[] = [atom('A', []), atom('B', [])];
    const counts = countIncomingCitations(atoms);
    expect(counts.size).toBe(0);
  });

  it('ignores edges that point to non-existent atoms', () => {
    const atoms: ParsedAtom[] = [atom('A', ['MISSING'])];
    const counts = countIncomingCitations(atoms);
    expect(counts.get('MISSING')).toBeUndefined();
  });

  it('does not count self-references', () => {
    const atoms: ParsedAtom[] = [atom('A', ['A', 'B']), atom('B', [])];
    const counts = countIncomingCitations(atoms);
    expect(counts.get('A')).toBeUndefined();
    expect(counts.get('B')).toBe(1);
  });

  it('counts duplicate edges (A→B twice) as 2', () => {
    const atoms: ParsedAtom[] = [
      {
        id: 'A',
        type: 'fact',
        status: 'active',
        classification: 'TEAM',
        confidence: 1.0,
        createdAt: '2026-04-29T10:00:00Z',
        updatedAt: '2026-04-29T10:00:00Z',
        ttlDays: null,
        tags: [],
        relations: [
          { target: 'B', type: 'extends' },
          { target: 'B', type: 'supports' },
        ],
        body: '',
      },
      atom('B', []),
    ];
    const counts = countIncomingCitations(atoms);
    expect(counts.get('B')).toBe(2);
  });

  it('returns an empty map for an empty input array', () => {
    const counts = countIncomingCitations([]);
    expect(counts.size).toBe(0);
  });
});
