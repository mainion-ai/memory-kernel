/**
 * End-to-end tests for `mk doctor` after the #140 orchestrator refactor.
 *
 * Spawns the real dist/cli/mk.js to confirm exit-code semantics and the new
 * --skip flag wiring. The existing test/cli-json.test.ts covers backward-
 * compat JSON shape; these cover the 0/1/2 exit-code spec and --skip.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { initMemoryDir, createAtom, reindex, closeAllIndexes } from '../src/index.js';

const CLI = path.resolve('dist/cli/mk.js');

let testDir: string;

interface Run {
  stdout: string;
  stderr: string;
  status: number;
}

function mk(args: string[], extraEnv: Record<string, string> = {}): Run {
  const r = spawnSync('node', [CLI, ...args], {
    encoding: 'utf-8',
    timeout: 15000,
    env: { ...process.env, NODE_NO_WARNINGS: '1', MK_CRONTAB_FILE: '/dev/null', ...extraEnv },
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 1 };
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-doctor-e2e-'));
  initMemoryDir(testDir);
  reindex(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('mk doctor exit codes', () => {
  it('exits 0 when memory is healthy', () => {
    createAtom({ memoryDir: testDir, type: 'fact', slug: 'hello', body: 'hi', agent_id: 'a', session_id: 's' });
    reindex(testDir);
    const { status } = mk(['doctor', '-d', testDir]);
    expect(status).toBe(0);
  });

  it('exits 2 when the memory dir is missing (hard error)', () => {
    const { stdout, status } = mk(['doctor', '-d', '/definitely/not/here', '--json']);
    expect(status).toBe(2);
    const json = JSON.parse(stdout);
    expect(json).toHaveProperty('error');
  });

  it('exits 1 when there are warn-severity issues', () => {
    // Active conflict atom triggers the conflicts check (warn severity).
    createAtom({
      memoryDir: testDir,
      type: 'conflict',
      slug: 'kettle-issue',
      body: 'kettle vs teapot',
      agent_id: 'a',
      session_id: 's',
    });
    reindex(testDir);
    const { status, stdout } = mk(['doctor', '-d', testDir]);
    expect(status).toBe(1);
    expect(stdout).toContain('[WARN] active-conflicts');
  });
});

describe('mk doctor --json shape', () => {
  it('returns the backward-compatible top-level fields + new checks array', () => {
    const { stdout, status } = mk(['doctor', '-d', testDir, '--json']);
    expect(status).toBe(0);
    const json = JSON.parse(stdout);
    expect(json).toHaveProperty('healthy', true);
    expect(json).toHaveProperty('issue_count', 0);
    expect(Array.isArray(json.issues)).toBe(true);
    expect(Array.isArray(json.checks)).toBe(true);
    expect(json.checks.length).toBeGreaterThanOrEqual(3);
    const names = json.checks.map((c: { name: string }) => c.name);
    expect(names).toContain('atom-schema');
    expect(names).toContain('broken-links');
    expect(names).toContain('active-conflicts');
  });
});

describe('mk doctor --skip', () => {
  it('marks wrapper-drift as skipped when --skip wrappers is passed', () => {
    const { stdout, status } = mk(['doctor', '-d', testDir, '--json', '--skip', 'wrappers']);
    expect(status).toBe(0);
    const json = JSON.parse(stdout);
    const wrapperResult = json.checks.find((c: { name: string }) => c.name === 'wrapper-drift');
    expect(wrapperResult).toBeDefined();
    expect(wrapperResult.skipped).toBeDefined();
    expect(wrapperResult.skipped.reason).toContain('wrappers');
  });

  it('marks store-* checks as skipped when --skip store is passed', () => {
    const { stdout } = mk(['doctor', '-d', testDir, '--json', '--skip', 'store']);
    const json = JSON.parse(stdout);
    for (const name of ['store-schema', 'store-permissions', 'render-config']) {
      const r = json.checks.find((c: { name: string }) => c.name === name);
      expect(r.skipped, `${name} should be skipped`).toBeDefined();
    }
  });

  it('accepts comma-separated --skip values', () => {
    const { stdout } = mk(['doctor', '-d', testDir, '--json', '--skip', 'store,wrappers']);
    const json = JSON.parse(stdout);
    expect(
      json.checks.find((c: { name: string }) => c.name === 'store-schema').skipped,
    ).toBeDefined();
    expect(
      json.checks.find((c: { name: string }) => c.name === 'wrapper-drift').skipped,
    ).toBeDefined();
  });
});

// --- #157 --fix / --dry-run scenarios ---

describe('mk doctor --fix', () => {
  it('exits 0 after fixing all fixable issues (stale index user_version)', () => {
    closeAllIndexes();
    const dbPath = path.join(testDir, '.memory-index.db');
    const db = new Database(dbPath);
    db.pragma('user_version = 6');
    db.close();

    // Verify pre-fix: plain doctor exits 1.
    const pre = mk(['doctor', '-d', testDir]);
    expect(pre.status).toBe(1);

    const { stdout, status } = mk(['doctor', '-d', testDir, '--fix']);
    expect(status).toBe(0);
    expect(stdout).toContain('[FIXED] store-schema');
  });

  it('exits 1 when fixes applied but unfixable issues remain', () => {
    // Unfixable: active conflict (warn) — conflictsCheck has no fix().
    createAtom({
      memoryDir: testDir,
      type: 'conflict',
      slug: 'kettle-issue',
      body: 'kettle vs teapot',
      agent_id: 'a',
      session_id: 's',
    });
    closeAllIndexes();
    // Force stale user_version AFTER creating the conflict atom — otherwise
    // the createAtom() call reopens the index and migrates back to current.
    const dbPath = path.join(testDir, '.memory-index.db');
    const db = new Database(dbPath);
    db.pragma('user_version = 6');
    db.close();

    const { status, stdout } = mk(['doctor', '-d', testDir, '--fix']);
    expect(status).toBe(1);
    expect(stdout).toContain('[FIXED] store-schema');
    expect(stdout).toContain('[WARN] active-conflicts');
  });

  it('--dry-run shows would-fix output without writing', () => {
    closeAllIndexes();
    const dbPath = path.join(testDir, '.memory-index.db');
    const db = new Database(dbPath);
    db.pragma('user_version = 6');
    db.close();

    const { stdout, status } = mk(['doctor', '-d', testDir, '--fix', '--dry-run']);
    // Dry-run mirrors plain-doctor exit (1 for warn).
    expect(status).toBe(1);
    expect(stdout).toContain('[WOULD FIX] store-schema');

    // Confirm no write happened.
    const after = new Database(dbPath, { readonly: true });
    const v = after.pragma('user_version', { simple: true }) as number;
    after.close();
    expect(v).toBe(6);
  });

  it('--fix --json includes a fixes[] array with dry_run flag and preserves the existing top-level shape', () => {
    closeAllIndexes();
    const dbPath = path.join(testDir, '.memory-index.db');
    const db = new Database(dbPath);
    db.pragma('user_version = 6');
    db.close();

    const { stdout, status } = mk(['doctor', '-d', testDir, '--fix', '--json']);
    expect(status).toBe(0);
    const json = JSON.parse(stdout);

    // Backward-compat top-level fields.
    expect(json).toHaveProperty('healthy');
    expect(json).toHaveProperty('issue_count');
    expect(Array.isArray(json.issues)).toBe(true);
    expect(Array.isArray(json.checks)).toBe(true);
    // New field.
    expect(Array.isArray(json.fixes)).toBe(true);
    const storeFix = json.fixes.find((f: { name: string }) => f.name === 'store-schema');
    expect(storeFix).toBeDefined();
    expect(storeFix.dry_run).toBe(false);
    expect(storeFix.applied.length).toBeGreaterThan(0);
  });

  it('--fix --dry-run --json marks each fix with dry_run: true', () => {
    closeAllIndexes();
    const dbPath = path.join(testDir, '.memory-index.db');
    const db = new Database(dbPath);
    db.pragma('user_version = 6');
    db.close();

    const { stdout } = mk(['doctor', '-d', testDir, '--fix', '--dry-run', '--json']);
    const json = JSON.parse(stdout);
    const storeFix = json.fixes.find((f: { name: string }) => f.name === 'store-schema');
    expect(storeFix.dry_run).toBe(true);
    expect(storeFix.applied[0]).toMatch(/would/i);
  });
});

describe('mk doctor --dry-run (without --fix)', () => {
  it('soft-warns on stderr and behaves like plain doctor', () => {
    const { stderr, status } = mk(['doctor', '-d', testDir, '--dry-run']);
    expect(status).toBe(0); // healthy store
    expect(stderr).toMatch(/--dry-run has no effect without --fix/);
  });

  it('does NOT emit the soft-warn under --json', () => {
    const { stderr } = mk(['doctor', '-d', testDir, '--dry-run', '--json']);
    expect(stderr).not.toMatch(/--dry-run has no effect/);
  });
});
