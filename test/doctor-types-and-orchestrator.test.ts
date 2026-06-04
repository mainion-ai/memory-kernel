/**
 * Unit tests for the doctor orchestrator + types (#140).
 *
 * Covers the pure pieces: exit-code mapping, --skip parsing, issue-flattening
 * for backward-compat JSON output, and orchestrator behavior with fake
 * checks (so we don't depend on the real file system here).
 */

import { describe, it, expect } from 'vitest';

import {
  exitCodeForResults,
  skipped,
  type Check,
  type CheckResult,
  type DoctorContext,
} from '../src/doctor/types.js';
import {
  runDoctor,
  parseSkipCategories,
  flattenIssues,
} from '../src/doctor/run.js';

function ctx(overrides: Partial<DoctorContext> = {}): DoctorContext {
  return {
    memoryDir: '/tmp/fake',
    kernelVersion: '1.19.4',
    skipCategories: new Set(),
    env: {},
    ...overrides,
  };
}

function fakeCheck(name: string, result: Partial<CheckResult>): Check {
  return {
    name,
    category: result.category ?? 'memory',
    defaultSeverity: result.severity ?? 'warn',
    skipWhen: undefined,
    run() {
      return {
        name,
        category: result.category ?? 'memory',
        severity: result.severity ?? 'warn',
        ok: result.ok ?? true,
        issues: result.issues ?? [],
        ...(result.skipped ? { skipped: result.skipped } : {}),
      };
    },
  };
}

describe('exitCodeForResults', () => {
  it('returns 0 when all checks pass', () => {
    expect(
      exitCodeForResults([
        { name: 'a', category: 'memory', severity: 'warn', ok: true, issues: [] },
      ]),
    ).toBe(0);
  });

  it('returns 1 when only warn-severity checks fail', () => {
    expect(
      exitCodeForResults([
        { name: 'a', category: 'memory', severity: 'warn', ok: false, issues: ['x'] },
      ]),
    ).toBe(1);
  });

  it('returns 2 when any error-severity check fails', () => {
    expect(
      exitCodeForResults([
        { name: 'a', category: 'memory', severity: 'warn', ok: false, issues: ['x'] },
        { name: 'b', category: 'memory', severity: 'error', ok: false, issues: ['y'] },
      ]),
    ).toBe(2);
  });

  it('treats skipped checks as healthy', () => {
    expect(
      exitCodeForResults([
        {
          name: 'a', category: 'memory', severity: 'error', ok: true, issues: [],
          skipped: { reason: 'skip me' },
        },
      ]),
    ).toBe(0);
  });
});

describe('parseSkipCategories', () => {
  it('returns empty set for undefined', () => {
    expect(parseSkipCategories(undefined).size).toBe(0);
  });

  it('parses comma-separated values', () => {
    const set = parseSkipCategories('wrappers,network');
    expect(set.has('wrappers')).toBe(true);
    expect(set.has('network')).toBe(true);
    expect(set.size).toBe(2);
  });

  it('parses space-separated values', () => {
    const set = parseSkipCategories('wrappers store');
    expect(set.has('wrappers')).toBe(true);
    expect(set.has('store')).toBe(true);
  });

  it('is case-insensitive and trims whitespace', () => {
    const set = parseSkipCategories('  Wrappers ,  NETWORK  ');
    expect(set.has('wrappers')).toBe(true);
    expect(set.has('network')).toBe(true);
  });

  it('silently drops unknown values', () => {
    const set = parseSkipCategories('wrappers,bogus');
    expect(set.has('wrappers')).toBe(true);
    expect(set.size).toBe(1);
  });
});

describe('flattenIssues', () => {
  it('returns empty array when all checks pass', () => {
    expect(
      flattenIssues([
        { name: 'a', category: 'memory', severity: 'warn', ok: true, issues: [] },
      ]),
    ).toEqual([]);
  });

  it('skips passed and skipped checks; joins others with name prefix', () => {
    const flat = flattenIssues([
      { name: 'a', category: 'memory', severity: 'error', ok: false, issues: ['bad-thing'] },
      { name: 'b', category: 'memory', severity: 'warn', ok: true, issues: [] },
      {
        name: 'c', category: 'memory', severity: 'warn', ok: true, issues: [],
        skipped: { reason: '--skip foo' },
      },
      { name: 'd', category: 'wrappers', severity: 'warn', ok: false, issues: ['drift-1', 'drift-2'] },
    ]);
    expect(flat).toEqual(['a: bad-thing', 'd: drift-1', 'd: drift-2']);
  });
});

describe('runDoctor', () => {
  it('runs every check in order', async () => {
    const order: string[] = [];
    const checks: Check[] = ['a', 'b', 'c'].map((n) => ({
      name: n,
      category: 'memory',
      defaultSeverity: 'warn',
      run() {
        order.push(n);
        return { name: n, category: 'memory', severity: 'warn', ok: true, issues: [] };
      },
    }));
    const out = await runDoctor(ctx(), checks);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(out.exitCode).toBe(0);
    expect(out.results).toHaveLength(3);
  });

  it('honors skipWhen', async () => {
    const c: Check = {
      name: 'wrap',
      category: 'wrappers',
      defaultSeverity: 'warn',
      skipWhen: ['wrappers'],
      run() {
        throw new Error('should not run');
      },
    };
    const out = await runDoctor(ctx({ skipCategories: new Set(['wrappers']) }), [c]);
    expect(out.results[0].skipped).toBeDefined();
    expect(out.results[0].skipped?.reason).toContain('wrappers');
  });

  it('catches and reports check exceptions as error-severity failures', async () => {
    const c: Check = {
      name: 'boom',
      category: 'memory',
      defaultSeverity: 'warn',
      run() {
        throw new Error('disk on fire');
      },
    };
    const out = await runDoctor(ctx(), [c]);
    expect(out.results[0].ok).toBe(false);
    expect(out.results[0].severity).toBe('error');
    expect(out.results[0].issues[0]).toContain('disk on fire');
    expect(out.exitCode).toBe(2);
  });

  it('propagates exit code from the worst failing check', async () => {
    const out = await runDoctor(ctx(), [
      fakeCheck('warn1', { ok: false, issues: ['x'], severity: 'warn' }),
      fakeCheck('err1', { ok: false, issues: ['y'], severity: 'error' }),
    ]);
    expect(out.exitCode).toBe(2);
  });
});

describe('skipped helper', () => {
  it('builds a CheckResult marked skipped', () => {
    const c: Check = {
      name: 'x',
      category: 'memory',
      defaultSeverity: 'warn',
      run() {
        return { name: 'x', category: 'memory', severity: 'warn', ok: true, issues: [] };
      },
    };
    const result = skipped(c, 'because');
    expect(result.skipped).toEqual({ reason: 'because' });
    expect(result.ok).toBe(true);
    expect(result.name).toBe('x');
  });
});
