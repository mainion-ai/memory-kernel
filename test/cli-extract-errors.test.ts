/**
 * #358 — branch/error-path coverage for `mk extract`.
 *
 * The subprocess e2e suites mostly hit happy paths; `src/cli/extract.ts`'s
 * validation branches (which all fire BEFORE the LLM is spawned) were the
 * largest honest gap. These cases exercise every pre-flight error branch with
 * no LLM involved — both the plain (`✗ …`, exit 1) and `--json`
 * (`{"error": …}`, exit 1) contracts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initMemoryDir } from '../src/index.js';

const CLI = path.resolve('dist/cli/mk.js');

let testDir: string;
let logFile: string;

function mk(...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      encoding: 'utf-8',
      timeout: 15000,
      env: { ...process.env, NODE_NO_WARNINGS: '1', HOME: testDir, USERPROFILE: testDir },
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: any) {
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', exitCode: err.status ?? 1 };
  }
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-extract-err-'));
  initMemoryDir(testDir);
  logFile = path.join(testDir, 'log.txt');
  fs.writeFileSync(logFile, 'user: hello\nassistant: hi\n');
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('mk extract — pre-flight error branches (no LLM)', () => {
  it('log file not found → exit 1, plain message', () => {
    const { stderr, exitCode } = mk('extract', path.join(testDir, 'nope.txt'), '-d', testDir);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Log file not found');
  });

  it('log file not found → exit 1, JSON error contract', () => {
    const { stdout, exitCode } = mk('extract', path.join(testDir, 'nope.txt'), '-d', testDir, '--json');
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout.trim()).error).toMatch(/Log file not found/);
  });

  it('memory directory not found → exit 1', () => {
    const { stderr, exitCode } = mk('extract', logFile, '-d', path.join(testDir, 'no-such-store'));
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Memory directory not found');
  });

  it('--max-atoms must be a positive integer (0 rejected)', () => {
    const { stdout, exitCode } = mk('extract', logFile, '-d', testDir, '--max-atoms', '0', '--json');
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout.trim()).error).toMatch(/--max-atoms must be a positive integer/);
  });

  it('--max-atoms must be a positive integer (non-numeric rejected)', () => {
    const { stderr, exitCode } = mk('extract', logFile, '-d', testDir, '--max-atoms', 'abc');
    expect(exitCode).toBe(1);
    expect(stderr).toContain('--max-atoms must be a positive integer');
  });

  it('--skip-lines must be a non-negative integer (negative rejected)', () => {
    const { stderr, exitCode } = mk('extract', logFile, '-d', testDir, '--skip-lines', '-1');
    expect(exitCode).toBe(1);
    expect(stderr).toContain('--skip-lines must be a non-negative integer');
  });

  it('--max-input-chars must be a positive integer (0 rejected)', () => {
    const { stdout, exitCode } = mk('extract', logFile, '-d', testDir, '--max-input-chars', '0', '--json');
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout.trim()).error).toMatch(/--max-input-chars must be a positive integer/);
  });

  it('--max-input-chars must be a positive integer (non-integer rejected)', () => {
    const { stderr, exitCode } = mk('extract', logFile, '-d', testDir, '--max-input-chars', '1.5');
    expect(exitCode).toBe(1);
    expect(stderr).toContain('--max-input-chars must be a positive integer');
  });
});
