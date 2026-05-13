import { describe, it, expect } from 'vitest';
import type { EntityTriple } from '../src/types.js';

describe('EntityTriple type', () => {
  it('accepts a well-formed triple', () => {
    const t: EntityTriple = {
      atom_id: 'FACT-2026-05-13-CAPITAL-abc12',
      subject: 'France',
      predicate: 'has_capital',
      object: 'Paris',
      confidence: 0.95,
      created_at: '2026-05-13T00:00:00Z',
    };
    expect(t.subject).toBe('France');
    expect(t.predicate).toBe('has_capital');
    expect(t.object).toBe('Paris');
  });
});
