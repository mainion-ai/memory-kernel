import { describe, it, expect } from 'vitest';
import { hexToRgba } from '../src/color.js';

describe('hexToRgba', () => {
  it('expands 6-digit hex into rgba with given alpha', () => {
    expect(hexToRgba('#27AE60', 1.0)).toBe('rgba(39, 174, 96, 1)');
    expect(hexToRgba('#27AE60', 0.5)).toBe('rgba(39, 174, 96, 0.5)');
  });

  it('expands 3-digit hex by doubling each nibble', () => {
    expect(hexToRgba('#FFF', 0.3)).toBe('rgba(255, 255, 255, 0.3)');
    expect(hexToRgba('#000', 1)).toBe('rgba(0, 0, 0, 1)');
  });

  it('is case-insensitive', () => {
    expect(hexToRgba('#fff', 0.3)).toBe('rgba(255, 255, 255, 0.3)');
    expect(hexToRgba('#aabbcc', 1)).toBe('rgba(170, 187, 204, 1)');
  });

  it('returns the input unchanged when it does not match a hex pattern', () => {
    expect(hexToRgba('rgba(0,0,0,1)', 0.5)).toBe('rgba(0,0,0,1)');
    expect(hexToRgba('not-a-color', 0.5)).toBe('not-a-color');
    expect(hexToRgba('', 1)).toBe('');
    expect(hexToRgba('#GGG', 1)).toBe('#GGG');
    expect(hexToRgba('#1234', 1)).toBe('#1234');
  });
});
