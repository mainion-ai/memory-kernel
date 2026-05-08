import { describe, it, expect } from 'vitest';
import { diffStates, type DiffSet } from '../src/diff-state.js';
import type { ParsedAtom } from '../src/atom-parser.js';

const atom = (id: string, updatedAt: string): ParsedAtom => ({
  id,
  type: 'fact',
  status: 'active',
  classification: 'TEAM',
  confidence: 1,
  createdAt: '2026-04-01T10:00:00Z',
  updatedAt,
  ttlDays: null,
  tags: [],
  relations: [],
  body: '',
});

const m = (...atoms: ParsedAtom[]) => new Map(atoms.map((a) => [a.id, a]));

describe('diffStates', () => {
  it('detects added atoms (in next, not prev)', () => {
    const d = diffStates(m(), m(atom('A', '2026-04-01T10:00:00Z')));
    expect([...d.added]).toEqual(['A']);
    expect([...d.removed]).toEqual([]);
    expect([...d.mutated]).toEqual([]);
  });

  it('detects removed atoms (in prev, not next)', () => {
    const d = diffStates(m(atom('A', '2026-04-01T10:00:00Z')), m());
    expect([...d.removed]).toEqual(['A']);
    expect([...d.added]).toEqual([]);
  });

  it('detects mutated atoms (same id, different updated_at)', () => {
    const d = diffStates(
      m(atom('A', '2026-04-01T10:00:00Z')),
      m(atom('A', '2026-04-02T10:00:00Z')),
    );
    expect([...d.mutated]).toEqual(['A']);
  });

  it('does not flag unchanged atoms (same id, same updated_at)', () => {
    const d = diffStates(
      m(atom('A', '2026-04-01T10:00:00Z')),
      m(atom('A', '2026-04-01T10:00:00Z')),
    );
    expect([...d.added]).toEqual([]);
    expect([...d.removed]).toEqual([]);
    expect([...d.mutated]).toEqual([]);
  });

  it('handles a mix in one diff', () => {
    const d = diffStates(
      m(atom('A', '2026-04-01T10:00:00Z'), atom('B', '2026-04-01T10:00:00Z'), atom('C', '2026-04-01T10:00:00Z')),
      m(atom('A', '2026-04-01T10:00:00Z'), atom('B', '2026-04-02T10:00:00Z'), atom('D', '2026-04-03T10:00:00Z')),
    );
    expect([...d.added].sort()).toEqual(['D']);
    expect([...d.removed].sort()).toEqual(['C']);
    expect([...d.mutated].sort()).toEqual(['B']);
  });

  it('classify(id) returns the right tag', () => {
    const d: DiffSet = diffStates(
      m(atom('REM', '2026-04-01T10:00:00Z'), atom('MUT', '2026-04-01T10:00:00Z')),
      m(atom('ADD', '2026-04-01T10:00:00Z'), atom('MUT', '2026-04-02T10:00:00Z')),
    );
    expect(d.classify('ADD')).toBe('added');
    expect(d.classify('REM')).toBe('removed');
    expect(d.classify('MUT')).toBe('mutated');
    expect(d.classify('UNKNOWN')).toBe('unchanged');
  });
});
