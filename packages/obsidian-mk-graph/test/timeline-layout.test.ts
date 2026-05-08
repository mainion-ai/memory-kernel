import { describe, it, expect } from 'vitest';
import { computeTimelinePositions } from '../src/timeline-layout.js';
import type { ParsedAtom } from '../src/atom-parser.js';

const atom = (id: string, type: string, createdAt: string): ParsedAtom => ({
  id, type, status: 'active', classification: 'TEAM',
  confidence: 1, createdAt, updatedAt: createdAt, ttlDays: null,
  tags: [], relations: [], body: '',
});

describe('computeTimelinePositions', () => {
  const opts = { width: 1000, height: 600, fromIso: '2026-04-01T00:00:00Z', toIso: '2026-04-30T23:59:59Z' };

  it('places atoms in monotonically increasing X by created_at', () => {
    const atoms = [
      atom('A', 'fact', '2026-04-05T10:00:00Z'),
      atom('B', 'fact', '2026-04-15T10:00:00Z'),
      atom('C', 'fact', '2026-04-25T10:00:00Z'),
    ];
    const pos = computeTimelinePositions(atoms, opts);
    const xa = pos.get('A')!.x;
    const xb = pos.get('B')!.x;
    const xc = pos.get('C')!.x;
    expect(xa).toBeLessThan(xb);
    expect(xb).toBeLessThan(xc);
  });

  it('stratifies Y by atom type — fact band ≠ conflict band', () => {
    const atoms = [
      atom('F', 'fact', '2026-04-10T10:00:00Z'),
      atom('C', 'conflict', '2026-04-10T10:00:00Z'),
    ];
    const pos = computeTimelinePositions(atoms, opts);
    expect(pos.get('F')!.y).not.toBe(pos.get('C')!.y);
  });

  it('clamps X to [margin, width-margin]', () => {
    const atoms = [
      atom('EARLY', 'fact', '2025-01-01T10:00:00Z'), // outside range
      atom('LATE', 'fact', '2027-01-01T10:00:00Z'),  // outside range
      atom('MID', 'fact', '2026-04-15T10:00:00Z'),
    ];
    const pos = computeTimelinePositions(atoms, opts);
    expect(pos.get('EARLY')!.x).toBeGreaterThanOrEqual(0);
    expect(pos.get('LATE')!.x).toBeLessThanOrEqual(opts.width);
  });

  it('is deterministic — same input → identical output', () => {
    const atoms = [
      atom('A', 'fact', '2026-04-05T10:00:00Z'),
      atom('B', 'belief', '2026-04-15T10:00:00Z'),
      atom('C', 'decision', '2026-04-25T10:00:00Z'),
    ];
    const a = computeTimelinePositions(atoms, opts);
    const b = computeTimelinePositions(atoms, opts);
    for (const id of ['A', 'B', 'C']) {
      expect(a.get(id)).toEqual(b.get(id));
    }
  });

  it('returns empty map for empty atom array', () => {
    expect(computeTimelinePositions([], opts).size).toBe(0);
  });

  it('places unknown-type atoms in the fallback band (last row)', () => {
    const atoms = [
      atom('F', 'fact', '2026-04-15T10:00:00Z'),
      atom('U', 'made_up_type', '2026-04-15T10:00:00Z'),
    ];
    const pos = computeTimelinePositions(atoms, opts);
    expect(pos.get('U')!.y).toBeGreaterThan(pos.get('F')!.y);
  });
});
