/**
 * Unit tests for the doctor --fix orchestrator (#157, Phase 1).
 *
 * These tests stay at the orchestrator layer — they assert that runDoctorFix
 * correctly routes around `Check.fix()`, distinguishes dry-run from apply,
 * re-runs affected checks, and maps outcomes to the 0/1/2 exit code per the
 * plan. Real-fs fix behavior lives in doctor-fix-checks.test.ts.
 */

import { describe, it, expect } from 'vitest';

import type {
  Check,
  CheckResult,
  DoctorContext,
  FixOpts,
  FixOutcome,
} from '../src/doctor/types.js';
import { runDoctorFix } from '../src/doctor/run.js';

function ctx(overrides: Partial<DoctorContext> = {}): DoctorContext {
  return {
    memoryDir: '/tmp/fake-doctor-fix',
    kernelVersion: '1.24.3',
    skipCategories: new Set(),
    env: {},
    ...overrides,
  };
}

/**
 * Build a fake check whose run() returns a deterministic CheckResult on each
 * invocation and whose fix() (if provided) returns a deterministic FixOutcome.
 * Records call counts so we can assert re-run behavior.
 */
function fakeCheck(opts: {
  name: string;
  runResults: CheckResult[]; // emitted in order, last value sticks
  fix?: (ctx: DoctorContext, result: CheckResult, opts: FixOpts) => FixOutcome | Promise<FixOutcome>;
  category?: CheckResult['category'];
  severity?: CheckResult['severity'];
}): Check & { runCalls: number; fixCalls: Array<{ dryRun: boolean }> } {
  let runIdx = 0;
  const fixCalls: Array<{ dryRun: boolean }> = [];
  const check: Check & { runCalls: number; fixCalls: typeof fixCalls } = {
    name: opts.name,
    category: opts.category ?? 'memory',
    defaultSeverity: opts.severity ?? 'warn',
    runCalls: 0,
    fixCalls,
    run() {
      check.runCalls += 1;
      const r = opts.runResults[Math.min(runIdx, opts.runResults.length - 1)];
      runIdx += 1;
      return r;
    },
    ...(opts.fix
      ? {
          fix(c, r, o) {
            fixCalls.push({ dryRun: o.dryRun });
            return opts.fix!(c, r, o);
          },
        }
      : {}),
  };
  return check;
}

function ok(name: string, severity: CheckResult['severity'] = 'warn'): CheckResult {
  return { name, category: 'memory', severity, ok: true, issues: [] };
}

function bad(name: string, issues: string[], severity: CheckResult['severity'] = 'warn'): CheckResult {
  return { name, category: 'memory', severity, ok: false, issues };
}

describe('runDoctorFix — dry-run mode', () => {
  it('passes dryRun: true to each fix() invocation', async () => {
    const c = fakeCheck({
      name: 'store-schema',
      runResults: [bad('store-schema', ['stale version'])],
      fix: () => ({ applied: ['would reindex'], remaining: [] }),
    });
    await runDoctorFix(ctx(), { dryRun: true }, [c]);
    expect(c.fixCalls).toEqual([{ dryRun: true }]);
  });

  it('does NOT re-run checks after dry-run fixes (no writes happened)', async () => {
    const c = fakeCheck({
      name: 'store-schema',
      runResults: [bad('store-schema', ['stale version'])],
      fix: () => ({ applied: ['would reindex'], remaining: [] }),
    });
    await runDoctorFix(ctx(), { dryRun: true }, [c]);
    expect(c.runCalls).toBe(1);
  });

  it('marks fixResults with dryRun: true', async () => {
    const c = fakeCheck({
      name: 'store-permissions',
      runResults: [bad('store-permissions', ['mode 644'])],
      fix: () => ({ applied: ['would chmod /x'], remaining: [] }),
    });
    const out = await runDoctorFix(ctx(), { dryRun: true }, [c]);
    expect(out.fixResults).toHaveLength(1);
    expect(out.fixResults[0]).toMatchObject({
      name: 'store-permissions',
      dryRun: true,
      applied: ['would chmod /x'],
    });
  });

  it('dry-run never escalates exit code beyond a plain doctor run', async () => {
    // A fix that would throw if called shouldn't be called — dry-run delegates
    // to the check, which is responsible for not writing. We assert exit
    // matches the plain-doctor exit (1 for warn-only, 2 for error-severity).
    const warnCheck = fakeCheck({
      name: 'render-config',
      runResults: [bad('render-config', ['missing'], 'warn')],
      fix: () => ({ applied: ['would write defaults'], remaining: [] }),
    });
    const out = await runDoctorFix(ctx(), { dryRun: true }, [warnCheck]);
    // Without --fix, the same store returns 1 (warn). Dry-run must also be 1.
    expect(out.exitCode).toBe(1);
  });
});

describe('runDoctorFix — apply mode', () => {
  it('passes dryRun: false to each fix() invocation', async () => {
    const c = fakeCheck({
      name: 'store-schema',
      runResults: [bad('store-schema', ['stale version']), ok('store-schema')],
      fix: () => ({ applied: ['reindexed'], remaining: [] }),
    });
    await runDoctorFix(ctx(), { dryRun: false }, [c]);
    expect(c.fixCalls).toEqual([{ dryRun: false }]);
  });

  it('re-runs affected checks after applying fixes', async () => {
    const c = fakeCheck({
      name: 'store-schema',
      runResults: [bad('store-schema', ['stale version']), ok('store-schema')],
      fix: () => ({ applied: ['reindexed'], remaining: [] }),
    });
    const out = await runDoctorFix(ctx(), { dryRun: false }, [c]);
    expect(c.runCalls).toBe(2);
    // The post-fix results reflect the second (ok) run.
    expect(out.results[0].ok).toBe(true);
  });

  it('does NOT re-run unaffected checks (those without fixes or with no issues)', async () => {
    const fixable = fakeCheck({
      name: 'store-schema',
      runResults: [bad('store-schema', ['stale version']), ok('store-schema')],
      fix: () => ({ applied: ['reindexed'], remaining: [] }),
    });
    const passthrough = fakeCheck({
      name: 'schema',
      runResults: [ok('schema')],
    });
    await runDoctorFix(ctx(), { dryRun: false }, [fixable, passthrough]);
    expect(fixable.runCalls).toBe(2);
    expect(passthrough.runCalls).toBe(1);
  });

  it('exits 0 when every fixable issue was resolved post-fix', async () => {
    const c = fakeCheck({
      name: 'store-schema',
      runResults: [bad('store-schema', ['stale']), ok('store-schema')],
      fix: () => ({ applied: ['reindexed'], remaining: [] }),
    });
    const out = await runDoctorFix(ctx(), { dryRun: false }, [c]);
    expect(out.exitCode).toBe(0);
  });

  it('exits 1 when fixes applied but non-fixable issues remain', async () => {
    const fixable = fakeCheck({
      name: 'store-permissions',
      runResults: [bad('store-permissions', ['mode 644'], 'error'), ok('store-permissions', 'error')],
      fix: () => ({ applied: ['chmodded'], remaining: [] }),
    });
    const unfixable = fakeCheck({
      // no fix() — Check.fix is undefined
      name: 'broken-links',
      runResults: [bad('broken-links', ['dangling link'], 'warn')],
    });
    const out = await runDoctorFix(ctx(), { dryRun: false }, [fixable, unfixable]);
    expect(out.exitCode).toBe(1);
  });

  it('exits 2 when a fix throws', async () => {
    const c = fakeCheck({
      name: 'store-schema',
      runResults: [bad('store-schema', ['stale'])],
      fix: () => {
        throw new Error('reindex blew up');
      },
    });
    const out = await runDoctorFix(ctx(), { dryRun: false }, [c]);
    expect(out.exitCode).toBe(2);
    expect(out.fixResults[0].errors?.[0]).toContain('reindex blew up');
  });

  it('exits 2 when an unfixable error-severity issue persists', async () => {
    // No fix() at all, error severity, still bad post-run.
    const unfixable = fakeCheck({
      name: 'schema',
      runResults: [bad('schema', ['enum drift'], 'error')],
    });
    const out = await runDoctorFix(ctx(), { dryRun: false }, [unfixable]);
    expect(out.exitCode).toBe(2);
  });

  it('is idempotent on a healthy store (exit 0, empty applied lists)', async () => {
    const c = fakeCheck({
      name: 'store-schema',
      runResults: [ok('store-schema')],
      fix: () => ({ applied: ['should not be called'], remaining: [] }),
    });
    const out = await runDoctorFix(ctx(), { dryRun: false }, [c]);
    expect(out.exitCode).toBe(0);
    expect(c.fixCalls).toEqual([]); // nothing to fix
    expect(out.fixResults).toEqual([]);
  });
});

describe('runDoctorFix — JSON contract surfaces', () => {
  it('exposes initialResults (pre-fix) separately from results (post-fix)', async () => {
    const c = fakeCheck({
      name: 'store-schema',
      runResults: [bad('store-schema', ['stale']), ok('store-schema')],
      fix: () => ({ applied: ['reindexed'], remaining: [] }),
    });
    const out = await runDoctorFix(ctx(), { dryRun: false }, [c]);
    expect(out.initialResults[0].ok).toBe(false);
    expect(out.results[0].ok).toBe(true);
  });
});
