import { describe, it, expect } from 'vitest';
import { applyLayout, type LayoutKind } from '../src/layout.js';
import type { GraphNode } from '../src/graph-state.js';

const node = (id: string, type: string, createdAt: string): GraphNode => ({
  id, type, status: 'active', classification: 'TEAM',
  confidence: 1, createdAt, updatedAt: createdAt, ttlDays: null,
  tags: [], relations: [], body: '',
});

describe('applyLayout', () => {
  const nodes = [
    node('A', 'fact', '2026-04-05T10:00:00Z'),
    node('B', 'belief', '2026-04-15T10:00:00Z'),
  ];

  it('force layout clears any pinned positions', () => {
    nodes[0].fx = 100; nodes[0].fy = 100;
    applyLayout(nodes as GraphNode[], { kind: 'force', width: 800, height: 600, fromIso: '', toIso: '' });
    expect(nodes[0].fx).toBeUndefined();
    expect(nodes[0].fy).toBeUndefined();
  });

  it('timeline layout pins fx/fy on every node', () => {
    applyLayout(nodes as GraphNode[], {
      kind: 'timeline',
      width: 800, height: 600,
      fromIso: '2026-04-01T00:00:00Z', toIso: '2026-04-30T00:00:00Z',
    });
    for (const n of nodes) {
      expect(typeof n.fx).toBe('number');
      expect(typeof n.fy).toBe('number');
    }
  });

  it('passes width/height through to timeline layout', () => {
    applyLayout(nodes as GraphNode[], {
      kind: 'timeline',
      width: 800, height: 600,
      fromIso: '2026-04-01T00:00:00Z', toIso: '2026-04-30T00:00:00Z',
    });
    for (const n of nodes) {
      expect(n.fx!).toBeGreaterThanOrEqual(0);
      expect(n.fx!).toBeLessThanOrEqual(800);
      expect(n.fy!).toBeGreaterThanOrEqual(0);
      expect(n.fy!).toBeLessThanOrEqual(600);
    }
  });
});

describe('LayoutKind type', () => {
  it('accepts force and timeline strings (compile-time check via cast)', () => {
    const kinds: LayoutKind[] = ['force', 'timeline'];
    expect(kinds).toHaveLength(2);
  });
});
