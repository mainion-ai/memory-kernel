/**
 * End-to-end tests for `mk observe` CLI argument validation (#244).
 *
 * Spawns the real dist/cli/mk.js to confirm the `--mode` flag is validated
 * before any LLM call. The success path needs a live `claude`/Ollama backend,
 * so it's covered by the mocked-spawn unit tests in test/observe.test.ts; here
 * we only assert the fast-fail validation branch.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initMemoryDir, closeAllIndexes } from '../src/index.js';

const CLI = path.resolve('dist/cli/mk.js');

let testDir: string;
let logFile: string;

function mk(args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync('node', [CLI, ...args], {
    encoding: 'utf-8',
    timeout: 15000,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 1 };
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-observe-e2e-'));
  initMemoryDir(testDir);
  // Mode validation runs after the log-exists + dir-exists pre-checks, so both
  // must be real for the --mode branch to be reached.
  logFile = path.join(testDir, 'session.log');
  fs.writeFileSync(logFile, 'a conversation log with more than fifty characters of content here.');
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('mk observe --mode validation', () => {
  it('exits non-zero with a clear message on an unknown --mode', () => {
    const { status, stderr } = mk(['observe', logFile, '-d', testDir, '--mode', 'bogus']);
    expect(status).toBe(1);
    expect(stderr).toContain('--mode must be one of');
    expect(stderr).toContain('conversation');
    expect(stderr).toContain('document');
  });

  it('emits a JSON error envelope on an unknown --mode with --json', () => {
    const { status, stdout } = mk(['observe', logFile, '-d', testDir, '--mode', 'bogus', '--json']);
    expect(status).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.error).toContain('--mode must be one of');
  });
});
