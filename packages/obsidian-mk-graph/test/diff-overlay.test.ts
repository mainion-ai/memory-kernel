import { describe, it, expect } from 'vitest';
import {
  DIFF_COLORS,
  diffNodeColor,
  diffNodeOpacity,
  diffEdgeColor,
} from '../src/diff-overlay.js';

describe('diffNodeColor', () => {
  it('returns the added color for added atoms', () => {
    expect(diffNodeColor('added', '#fallback')).toBe(DIFF_COLORS.added);
  });

  it('returns the removed color for removed atoms', () => {
    expect(diffNodeColor('removed', '#fallback')).toBe(DIFF_COLORS.removed);
  });

  it('returns the mutated color for mutated atoms', () => {
    expect(diffNodeColor('mutated', '#fallback')).toBe(DIFF_COLORS.mutated);
  });

  it('returns the fallback (F2 type color) for unchanged atoms', () => {
    expect(diffNodeColor('unchanged', '#fallback')).toBe('#fallback');
  });
});

describe('diffNodeOpacity', () => {
  it('removed atoms render as ghosts (low opacity)', () => {
    expect(diffNodeOpacity('removed', 1.0)).toBeLessThan(0.5);
  });

  it('added/mutated/unchanged keep the F2 opacity', () => {
    expect(diffNodeOpacity('added', 1.0)).toBe(1.0);
    expect(diffNodeOpacity('mutated', 0.5)).toBe(0.5);
    expect(diffNodeOpacity('unchanged', 0.7)).toBe(0.7);
  });
});

describe('diffEdgeColor', () => {
  it('uses the source node tag if it is non-unchanged', () => {
    expect(diffEdgeColor('added', 'unchanged', '#f2')).toBe(DIFF_COLORS.added);
    expect(diffEdgeColor('removed', 'unchanged', '#f2')).toBe(DIFF_COLORS.removed);
  });

  it('uses the target tag when source is unchanged', () => {
    expect(diffEdgeColor('unchanged', 'mutated', '#f2')).toBe(DIFF_COLORS.mutated);
  });

  it('falls back to F2 edge color when both endpoints are unchanged', () => {
    expect(diffEdgeColor('unchanged', 'unchanged', '#f2')).toBe('#f2');
  });
});
