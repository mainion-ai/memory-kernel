/**
 * End-to-end smoke tests for #141 deprecation + degenerate-output stderr
 * warnings. Spawns the real `dist/cli/mk.js` so we exercise the actual argv
 * rewrite + commander parse path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initMemoryDir, createAtom, reindex, closeAllIndexes } from '../src/index.js';

const CLI = path.resolve('dist/cli/mk.js');

let testDir: string;
let outFile: string;

function mk(args: string[], extraEnv: Record<string, string> = {}): {
  stdout: string;
  stderr: string;
  status: number;
} {
  const result = spawnSync('node', [CLI, ...args], {
    encoding: 'utf-8',
    timeout: 15000,
    env: { ...process.env, NODE_NO_WARNINGS: '1', ...extraEnv },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  };
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-cli-dep-'));
  outFile = path.join(testDir, 'CLAUDE.md');
  initMemoryDir(testDir);
  reindex(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('mk render --fill (removed flag, #141)', () => {
  it('exits 0, prints warning to stderr, and produces output despite --fill being gone', () => {
    createAtom({
      memoryDir: testDir,
      type: 'fact',
      slug: 'hello',
      body: 'hello world',
      agent_id: 'test',
      session_id: 'test',
    });
    reindex(testDir);

    const { stdout, stderr, status } = mk(['render', testDir, outFile, '--fill']);

    expect(status).toBe(0);
    expect(stderr).toContain('mk: warning:');
    expect(stderr).toContain('--fill has been removed');
    // Render still produced a CLAUDE.md with the atom in it.
    expect(fs.existsSync(outFile)).toBe(true);
    expect(stdout).toContain('Rendered 1 atoms');
  });

  it('MK_NO_DEPRECATION_WARNINGS=1 silences the warning but keeps the command working', () => {
    createAtom({
      memoryDir: testDir,
      type: 'fact',
      slug: 'hello',
      body: 'hello',
      agent_id: 'test',
      session_id: 'test',
    });
    reindex(testDir);

    const { stderr, status } = mk(
      ['render', testDir, outFile, '--fill'],
      { MK_NO_DEPRECATION_WARNINGS: '1' },
    );
    expect(status).toBe(0);
    expect(stderr).not.toContain('--fill has been removed');
  });
});

describe('mk render degenerate output (#141B)', () => {
  it('warns on 0 atoms', () => {
    // Empty memory dir — no atoms created.
    const { stdout, stderr, status } = mk(['render', testDir, outFile]);

    expect(status).toBe(0);
    expect(stdout).toContain('Rendered 0 atoms');
    expect(stderr).toContain('mk: warning:');
    expect(stderr).toContain('0 atoms');
  });

  it('does not warn on healthy multi-type output', () => {
    for (let i = 0; i < 3; i += 1) {
      createAtom({
        memoryDir: testDir,
        type: 'fact',
        slug: `fact-${i}`,
        body: 'f',
        agent_id: 'test',
        session_id: 'test',
      });
      createAtom({
        memoryDir: testDir,
        type: 'belief',
        slug: `belief-${i}`,
        body: 'b',
        agent_id: 'test',
        session_id: 'test',
      });
    }
    reindex(testDir);

    const { stderr, status } = mk(['render', testDir, outFile]);
    expect(status).toBe(0);
    expect(stderr).not.toContain('mk: warning:');
  });
});
