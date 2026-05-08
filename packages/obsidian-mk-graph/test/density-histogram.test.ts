import { describe, it, expect } from 'vitest';
import { computeHistogram, pickBucketUnit } from '../src/density-histogram.js';
import type { PluginEvent } from '../src/event-parser.js';

const ev = (ts: string): PluginEvent => ({
  event_id: ts, timestamp: ts, agent_id: 'a', session_id: 's', action: 'atom_created',
});

describe('pickBucketUnit', () => {
  it('returns "day" for ranges ≤ 60 days', () => {
    expect(pickBucketUnit('2026-04-01T00:00:00Z', '2026-04-15T00:00:00Z')).toBe('day');
  });

  it('returns "week" for ranges 61..365 days', () => {
    expect(pickBucketUnit('2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z')).toBe('week');
  });

  it('returns "month" for ranges > 365 days', () => {
    expect(pickBucketUnit('2024-01-01T00:00:00Z', '2026-01-01T00:00:00Z')).toBe('month');
  });
});

describe('computeHistogram', () => {
  it('returns one bucket per day for a 5-day daily-resolution range', () => {
    const events = [
      ev('2026-04-01T08:00:00Z'),
      ev('2026-04-01T15:00:00Z'),
      ev('2026-04-03T10:00:00Z'),
      ev('2026-04-05T10:00:00Z'),
    ];
    const h = computeHistogram(events, '2026-04-01T00:00:00Z', '2026-04-05T23:59:59Z');
    expect(h.unit).toBe('day');
    expect(h.buckets).toHaveLength(5);
    expect(h.buckets[0].count).toBe(2); // 04-01: two events
    expect(h.buckets[1].count).toBe(0); // 04-02: empty bucket still emitted
    expect(h.buckets[2].count).toBe(1); // 04-03
    expect(h.buckets[3].count).toBe(0);
    expect(h.buckets[4].count).toBe(1); // 04-05
  });

  it('returns an empty buckets array when no events fall in range', () => {
    const events = [ev('2026-01-01T00:00:00Z')];
    const h = computeHistogram(events, '2026-04-01T00:00:00Z', '2026-04-05T00:00:00Z');
    expect(h.buckets.every((b) => b.count === 0)).toBe(true);
  });

  it('skips events outside the range', () => {
    const events = [
      ev('2026-03-31T23:59:59Z'),
      ev('2026-04-01T10:00:00Z'),
      ev('2026-04-06T00:00:00Z'),
    ];
    const h = computeHistogram(events, '2026-04-01T00:00:00Z', '2026-04-05T23:59:59Z');
    const total = h.buckets.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(1);
  });
});
