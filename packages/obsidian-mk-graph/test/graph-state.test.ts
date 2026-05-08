import { describe, it, expect, vi } from 'vitest';
import { GraphState } from '../src/graph-state.js';
import type { ParsedAtom } from '../src/atom-parser.js';

function atom(id: string, relTargets: string[] = []): ParsedAtom {
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
    relations: relTargets.map((t) => ({ target: t, type: 'related' })),
    body: '',
  };
}

describe('GraphState', () => {
  it('starts empty', () => {
    const s = new GraphState();
    expect(s.atoms.size).toBe(0);
    expect(s.outbound('A')).toEqual([]);
  });

  it('replace() loads atoms and indexes outbound relations', () => {
    const s = new GraphState();
    s.replace([atom('A', ['B']), atom('B', [])]);
    expect(s.atoms.size).toBe(2);
    expect(s.atoms.get('A')!.id).toBe('A');
    expect(s.outbound('A')).toHaveLength(1);
    expect(s.outbound('A')[0].target).toBe('B');
    expect(s.outbound('B')).toEqual([]);
  });

  it('replace() drops atoms not in the new set', () => {
    const s = new GraphState();
    s.replace([atom('A'), atom('B')]);
    s.replace([atom('B')]);
    expect(s.atoms.has('A')).toBe(false);
    expect(s.atoms.has('B')).toBe(true);
  });

  it('subscribe() fires on every replace()', () => {
    const s = new GraphState();
    const fn = vi.fn();
    s.subscribe(fn);
    s.replace([atom('A')]);
    s.replace([atom('B')]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('subscribe() returns an unsubscribe handle', () => {
    const s = new GraphState();
    const fn = vi.fn();
    const off = s.subscribe(fn);
    s.replace([atom('A')]);
    off();
    s.replace([atom('B')]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('toGraphData() returns nodes + links arrays for force-graph', () => {
    const s = new GraphState();
    s.replace([atom('A', ['B']), atom('B')]);
    const data = s.toGraphData();
    expect(data.nodes.map((n) => n.id).sort()).toEqual(['A', 'B']);
    expect(data.links).toHaveLength(1);
    expect(data.links[0].source).toBe('A');
    expect(data.links[0].target).toBe('B');
  });

  it('toGraphData() drops links to unknown targets', () => {
    const s = new GraphState();
    s.replace([atom('A', ['MISSING'])]);
    const data = s.toGraphData();
    expect(data.links).toHaveLength(0);
  });

  it('outbound() returns [] for an unknown id even after populate', () => {
    const s = new GraphState();
    s.replace([atom('A', ['B']), atom('B')]);
    expect(s.outbound('C')).toEqual([]);
  });

  it('subscribe() fires every registered subscriber', () => {
    const s = new GraphState();
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    s.subscribe(fn1);
    s.subscribe(fn2);
    s.replace([atom('A')]);
    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it('toGraphData() carries relation metadata onto links', () => {
    const s = new GraphState();
    const aWithRichRel: ParsedAtom = {
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
        {
          target: 'B',
          type: 'extends',
          confidence: 0.85,
          weight: 1.6,
          source: 'manual',
        },
      ],
      body: '',
    };
    s.replace([aWithRichRel, atom('B')]);
    const data = s.toGraphData();
    expect(data.links).toHaveLength(1);
    expect(data.links[0]).toEqual({
      source: 'A',
      target: 'B',
      type: 'extends',
      confidence: 0.85,
      weight: 1.6,
      source_kind: 'manual', // NOT 'source' — provenance is renamed
    });
  });
});

describe('GraphState — filter-panel helpers', () => {
  it('getAvailableTags returns the sorted unique tag set across all atoms', () => {
    const s = new GraphState();
    s.replace([
      { ...atom('A'), tags: ['fixture', 'fact'] },
      { ...atom('B'), tags: ['fixture', 'belief'] },
      { ...atom('C'), tags: [] },
      { ...atom('D'), tags: ['fact'] },
    ]);
    expect(s.getAvailableTags()).toEqual(['belief', 'fact', 'fixture']);
  });

  it('getAvailableTags returns [] when the state has no atoms', () => {
    const s = new GraphState();
    expect(s.getAvailableTags()).toEqual([]);
  });

  it('getReferencedIds returns the set of atom ids that any other atom links to', () => {
    const s = new GraphState();
    s.replace([
      atom('A', ['B']),       // A → B
      atom('B', ['C']),       // B → C
      atom('C'),
      atom('D'),              // truly orphan
    ]);
    const ref = s.getReferencedIds();
    expect(ref.has('B')).toBe(true);
    expect(ref.has('C')).toBe(true);
    expect(ref.has('A')).toBe(false);
    expect(ref.has('D')).toBe(false);
  });
});
