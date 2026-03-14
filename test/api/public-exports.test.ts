import { describe, it, expect } from 'vitest';

// NOTE: tests in this repo import src via .js extension intentionally.
// The project is ESM and source files use Node16-style .js specifiers.
import { ATOM_TYPES, ATOM_STATUSES, CLASSIFICATIONS } from '../../src/index.js';

describe('public API exports', () => {
  it('exports ATOM_TYPES (runtime) for downstream schema builders', () => {
    // The OpenClaw plugin uses ATOM_TYPES at runtime when constructing JSON schemas.
    // If this export is missing, integrations will fail at import-time.
    expect(Array.isArray(ATOM_TYPES)).toBe(true);
    expect(ATOM_TYPES.length).toBeGreaterThan(5);
    expect(ATOM_TYPES).toContain('fact');
    expect(ATOM_TYPES).toContain('preference');
  });

  it('exports ATOM_STATUSES (runtime) for downstream schema builders', () => {
    expect(Array.isArray(ATOM_STATUSES)).toBe(true);
    expect(ATOM_STATUSES).toContain('active');
    expect(ATOM_STATUSES).toContain('archived');
  });

  it('exports CLASSIFICATIONS (runtime) for policy-aware clients', () => {
    expect(Array.isArray(CLASSIFICATIONS)).toBe(true);
    expect(CLASSIFICATIONS).toEqual(expect.arrayContaining(['PUBLIC', 'TEAM', 'PERSONAL', 'SECRET']));
  });
});
