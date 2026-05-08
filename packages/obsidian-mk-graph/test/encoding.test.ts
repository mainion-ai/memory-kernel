import { describe, it, expect } from 'vitest';
import {
  nodeColor,
  nodeSize,
  nodeBorderColor,
  nodeOpacity,
  edgeColor,
  edgeWidth,
  edgeDash,
  edgeOpacity,
} from '../src/encoding.js';
import type { ParsedAtom, ParsedRelation } from '../src/atom-parser.js';

function makeAtom(overrides: Partial<ParsedAtom> = {}): ParsedAtom {
  return {
    id: 'FACT-2026-04-29-X-aa00',
    type: 'fact',
    status: 'active',
    classification: 'TEAM',
    confidence: 1.0,
    createdAt: '2026-04-29T10:00:00Z',
    updatedAt: '2026-04-29T10:00:00Z',
    ttlDays: null,
    tags: [],
    relations: [],
    body: '',
    ...overrides,
  };
}

describe('node encoding', () => {
  it('nodeColor returns the type palette hex, falls back on unknown', () => {
    expect(nodeColor(makeAtom({ type: 'fact' }))).toBe('#27AE60');
    expect(nodeColor(makeAtom({ type: 'belief' }))).toBe('#4A90D9');
    expect(nodeColor(makeAtom({ type: 'unknown_type' }))).toBe('#95A5A6');
  });

  it('nodeSize floors at 4px and grows logarithmically', () => {
    expect(nodeSize(0)).toBeCloseTo(4, 5); // log10(1) = 0 -> 4
    expect(nodeSize(9)).toBeCloseTo(10, 5); // log10(10) = 1 -> 4 + 6
    expect(nodeSize(99)).toBeCloseTo(16, 5); // log10(100) = 2 -> 4 + 12
  });

  it('nodeBorderColor returns classification color, defaults to TEAM blue', () => {
    expect(nodeBorderColor(makeAtom({ classification: 'PUBLIC' }))).toBe('#27AE60');
    expect(nodeBorderColor(makeAtom({ classification: 'SECRET' }))).toBe('#C0392B');
    expect(nodeBorderColor(makeAtom({ classification: 'WEIRD' }))).toBe('#3498DB');
  });

  it('nodeOpacity applies status mapping; expired returns 0', () => {
    expect(nodeOpacity(makeAtom({ status: 'active' }))).toBe(1.0);
    expect(nodeOpacity(makeAtom({ status: 'rejected' }))).toBe(0.4);
    expect(nodeOpacity(makeAtom({ status: 'expired' }))).toBe(0.0);
    expect(nodeOpacity(makeAtom({ status: 'unknown_status' }))).toBe(1.0);
  });

  it('nodeSize collapses non-finite inputs to the 4px floor', () => {
    expect(nodeSize(NaN)).toBeCloseTo(4, 5);
    expect(nodeSize(Infinity)).toBeCloseTo(4, 5);
    expect(nodeSize(-Infinity)).toBeCloseTo(4, 5);
    expect(nodeSize(-1)).toBeCloseTo(4, 5); // negative also clamped to 0
  });
});

describe('edge encoding', () => {
  function makeRel(overrides: Partial<ParsedRelation> = {}): ParsedRelation {
    return { target: 'FACT-x', type: 'related', ...overrides };
  }

  it('edgeColor returns relation-type palette, falls back grey', () => {
    expect(edgeColor(makeRel({ type: 'supports' }))).toBe('#2ECC71');
    expect(edgeColor(makeRel({ type: 'contradicts' }))).toBe('#C0392B');
    expect(edgeColor(makeRel({ type: 'unknown_rel' }))).toBe('#7F8C8D');
  });

  it('edgeWidth uses relation.weight when set, else type default, clamped [0.5, 8]', () => {
    // Explicit weight wins over type default
    expect(edgeWidth(makeRel({ type: 'related', weight: 1.0 }))).toBeCloseTo(3.0, 5);
    // Type default from constitution preset: contradicts = 0.3 -> width = 1 + 2*0.3 = 1.6
    expect(edgeWidth(makeRel({ type: 'contradicts' }))).toBeCloseTo(1.6, 5);
    // Type default for `extends` = 1.5 -> width = 1 + 2*1.5 = 4.0
    expect(edgeWidth(makeRel({ type: 'extends' }))).toBeCloseTo(4.0, 5);
    // weight = 0 still produces width 1.0 (above clamp floor)
    expect(edgeWidth(makeRel({ type: 'related', weight: 0 }))).toBe(1.0);
    // Clamp ceiling
    expect(edgeWidth(makeRel({ type: 'related', weight: 100 }))).toBe(8);
    // Clamp floor
    expect(edgeWidth(makeRel({ type: 'related', weight: -10 }))).toBe(0.5);
    // Unknown relation type without explicit weight uses fallback 0.3 -> width = 1.6
    expect(edgeWidth(makeRel({ type: 'unknown_rel' }))).toBeCloseTo(1.6, 5);
  });

  it('edgeDash returns the source pattern, falls back solid', () => {
    expect(edgeDash(makeRel({ source: 'manual' }))).toEqual([]);
    expect(edgeDash(makeRel({ source: 'extracted' }))).toEqual([8, 4]);
    expect(edgeDash(makeRel({ source: 'enriched' }))).toEqual([1, 5]);
    expect(edgeDash(makeRel())).toEqual([]); // undefined -> solid
  });

  it('edgeWidth halves for source: unknown so it renders thinner than manual', () => {
    // Same weight, only source differs — unknown should be half the width.
    const manual = edgeWidth(makeRel({ type: 'related', weight: 1.0, source: 'manual' }));
    const unknown = edgeWidth(makeRel({ type: 'related', weight: 1.0, source: 'unknown' }));
    expect(unknown).toBeCloseTo(manual * 0.5, 5);
    // Floor still applies — very small weight + unknown halving clamps at 0.5.
    expect(edgeWidth(makeRel({ type: 'related', weight: 0, source: 'unknown' }))).toBe(0.5);
  });

  it('edgeOpacity floors at 0.3, scales by confidence', () => {
    expect(edgeOpacity(makeRel({ confidence: 1.0 }))).toBeCloseTo(1.0, 5);
    expect(edgeOpacity(makeRel({ confidence: 0.5 }))).toBeCloseTo(0.65, 5);
    expect(edgeOpacity(makeRel({ confidence: 0 }))).toBeCloseTo(0.3, 5);
    expect(edgeOpacity(makeRel())).toBeCloseTo(1.0, 5); // undefined -> 1.0
  });

  it('edgeWidth falls back when weight is non-finite', () => {
    // NaN weight → fallback (0.3) → width = 1.6
    expect(edgeWidth(makeRel({ type: 'related', weight: NaN }))).toBeCloseTo(1.6, 5);
    expect(edgeWidth(makeRel({ type: 'related', weight: Infinity }))).toBeCloseTo(1.6, 5);
  });

  it('edgeOpacity falls back to 1.0 when confidence is non-finite', () => {
    expect(edgeOpacity(makeRel({ confidence: NaN }))).toBeCloseTo(1.0, 5);
    expect(edgeOpacity(makeRel({ confidence: Infinity }))).toBeCloseTo(1.0, 5);
  });

  it('edgeDash returns [] for the known `unknown` source', () => {
    expect(edgeDash(makeRel({ source: 'unknown' }))).toEqual([]);
  });
});
