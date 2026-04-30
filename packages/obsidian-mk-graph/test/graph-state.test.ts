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
});
