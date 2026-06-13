import { describe, it, expect } from 'vitest';
import { summarizeEvalRun, decideCadence, type EvalSnapshot } from '../src/eval-cadence.js';
import type { EvalResult } from '../src/eval.js';

// A minimal EvalResult fixture with categorized query results.
function fixture(results: Array<{ cat?: string; passed: boolean }>): EvalResult {
  return {
    fixture: 'recall',
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    pass_rate: results.length ? results.filter((r) => r.passed).length / results.length : 0,
    threshold: 1,
    top_k: 5,
    embed_used: false,
    ok: false,
    results: results.map((r, i) => ({ task: `q${i}`, cat: r.cat, passed: r.passed, detail: '' })),
  };
}

// Build a snapshot N days before `anchorMs`.
const DAY = 24 * 60 * 60 * 1000;
function snap(daysAgo: number, anchorMs: number, categories: Record<string, number>, overall = 0): EvalSnapshot {
  return { timestamp: new Date(anchorMs - daysAgo * DAY).toISOString(), overall, categories };
}

describe('summarizeEvalRun (#266)', () => {
  it('computes per-category and overall pass rate from a run', () => {
    const fixtures = [fixture([
      { cat: 'identity', passed: true },
      { cat: 'identity', passed: false },
      { cat: 'knowledge', passed: true },
      { cat: 'knowledge', passed: true },
      { passed: false }, // uncategorized
    ])];
    const s = summarizeEvalRun(fixtures, '2026-06-13T00:00:00.000Z');
    expect(s.categories.identity).toBeCloseTo(0.5);
    expect(s.categories.knowledge).toBeCloseTo(1.0);
    expect(s.categories.uncategorized).toBeCloseTo(0.0);
    expect(s.overall).toBeCloseTo(3 / 5);
  });

  it('collapses an empty/whitespace cat to uncategorized (review finding)', () => {
    const s = summarizeEvalRun([fixture([{ cat: '', passed: true }, { cat: '   ', passed: false }])], '2026-06-13T00:00:00.000Z');
    expect(Object.keys(s.categories)).toEqual(['uncategorized']);
    expect(s.categories.uncategorized).toBeCloseTo(0.5);
  });

  it('aggregates across multiple fixtures', () => {
    const s = summarizeEvalRun(
      [fixture([{ cat: 'a', passed: true }]), fixture([{ cat: 'a', passed: false }])],
      '2026-06-13T00:00:00.000Z',
    );
    expect(s.categories.a).toBeCloseTo(0.5);
  });
});

describe('decideCadence (#266)', () => {
  const NOW = Date.parse('2026-06-13T12:00:00.000Z');

  it('fires a drop alert when a category falls > 10pp vs the rolling baseline', () => {
    const history = [
      snap(3, NOW, { identity: 0.9 }),
      snap(2, NOW, { identity: 0.9 }),
      snap(0, NOW, { identity: 0.75 }), // latest: −15pp
    ];
    const r = decideCadence(history, { nowMs: NOW });
    expect(r.fired).toBe(true);
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0]).toMatchObject({ category: 'identity', direction: 'drop' });
    expect(r.alerts[0].delta).toBeCloseTo(-0.15);
  });

  it('fires an improve alert when a category rises > 15pp', () => {
    const history = [
      snap(2, NOW, { knowledge: 0.5 }),
      snap(0, NOW, { knowledge: 0.7 }), // +20pp
    ];
    const r = decideCadence(history, { nowMs: NOW });
    expect(r.fired).toBe(true);
    expect(r.alerts[0].direction).toBe('improve');
  });

  it('stays silent within thresholds (−10pp..+15pp)', () => {
    const history = [
      snap(2, NOW, { identity: 0.8 }),
      snap(0, NOW, { identity: 0.72 }), // −8pp, under the 10pp drop threshold
    ];
    const r = decideCadence(history, { nowMs: NOW });
    expect(r.fired).toBe(false);
    expect(r.alerts).toHaveLength(0);
    expect(r.digest).toContain('identity');
  });

  it('never fires on a first observation (no baseline yet)', () => {
    const r = decideCadence([snap(0, NOW, { identity: 0.0 })], { nowMs: NOW });
    expect(r.fired).toBe(false);
    expect(r.window.baseline_runs).toBe(0);
    expect(r.digest).toContain('no baseline yet');
  });

  it('excludes runs older than the rolling window from the baseline', () => {
    const history = [
      snap(30, NOW, { identity: 0.2 }), // stale — must NOT pull the baseline down
      snap(2, NOW, { identity: 0.9 }),
      snap(0, NOW, { identity: 0.85 }), // −5pp vs the 0.9 in-window baseline → silent
    ];
    const r = decideCadence(history, { nowMs: NOW, baselineDays: 7 });
    expect(r.window.baseline_runs).toBe(1); // only the 2-days-ago run is in-window (latest excluded)
    expect(r.fired).toBe(false);
  });

  it('surfaces a category that vanished from the latest run (digest, no false alert)', () => {
    const history = [
      snap(2, NOW, { identity: 0.9, mesh: 0.8 }),
      snap(0, NOW, { identity: 0.9 }), // mesh removed from the latest fixture
    ];
    const r = decideCadence(history, { nowMs: NOW });
    expect(r.fired).toBe(false); // intentional pruning must not false-fire
    expect(r.digest).toContain('mesh');
    expect(r.digest).toContain('absent from latest run');
  });

  it('empty history → silent, no latest', () => {
    const r = decideCadence([], { nowMs: NOW });
    expect(r.fired).toBe(false);
    expect(r.latest).toBeNull();
  });
});
