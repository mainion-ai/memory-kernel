import { describe, it, expect } from 'vitest';

// NOTE: tests in this repo import src via .js extension intentionally.
// The project is ESM and source files use Node16-style .js specifiers.
import * as mk from '../../src/index.js';

describe('public API exports', () => {
  it('exports ATOM_TYPES (runtime) for downstream schema builders', () => {
    // The OpenClaw plugin uses ATOM_TYPES at runtime when constructing JSON schemas.
    // If this export is missing, integrations will fail at import-time.
    expect(Array.isArray((mk as any).ATOM_TYPES)).toBe(true);
    expect((mk as any).ATOM_TYPES.length).toBeGreaterThan(5);
    expect((mk as any).ATOM_TYPES).toContain('fact');
    expect((mk as any).ATOM_TYPES).toContain('preference');
  });

  it('exports CLASSIFICATIONS (runtime) for policy-aware clients', () => {
    expect(Array.isArray((mk as any).CLASSIFICATIONS)).toBe(true);
    expect((mk as any).CLASSIFICATIONS).toEqual(expect.arrayContaining(['PUBLIC', 'TEAM', 'PERSONAL', 'SECRET']));
  });
});
