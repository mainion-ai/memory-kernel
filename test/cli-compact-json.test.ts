/**
 * Tests for mk compact --json output.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initMemoryDir, createAtom, closeAllIndexes } from '../src/index.js';

const CLI = path.resolve('dist/cli/mk.js');

let testDir: string;

function mk(...args: string[]): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      encoding: 'utf-8',
      timeout: 15000,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return { stdout: err.stdout ?? '', exitCode: err.status ?? 1 };
  }
}

function parseJson(stdout: string): any {
  return JSON.parse(stdout.trim());
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-compact-json-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('mk compact --json', () => {

  it('returns valid JSON with expected keys on fresh store', () => {
    const { stdout, exitCode } = mk('compact', '-d', testDir, '--json');
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json).toHaveProperty('events_before');
    expect(json).toHaveProperty('events_after');
    expect(json).toHaveProperty('removed');
    expect(json.removed).toBe(0);
  });

  it('returns JSON with all fields after compacting events', () => {
    // Create an atom then mutate it to produce compactable intermediate events
    const id = createAtom({ memoryDir: testDir, type: 'fact', slug: 'compact-test', body: 'v1', agent_id: 'test', session_id: 'test' });
    // Overwrite body to generate a second mutation event
    createAtom({ memoryDir: testDir, type: 'fact', slug: 'compact-test', body: 'v2', agent_id: 'test', session_id: 'test' });

    const { stdout, exitCode } = mk('compact', '-d', testDir, '--json');
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json).toHaveProperty('events_before');
    expect(json).toHaveProperty('events_after');
    expect(json).toHaveProperty('removed');
    expect(json.events_before).toBeGreaterThanOrEqual(json.events_after);
  });

  it('returns JSON error for nonexistent directory', () => {
    const { stdout, exitCode } = mk('compact', '-d', '/nonexistent/dir', '--json');
    expect(exitCode).toBe(1);
    const json = parseJson(stdout);
    expect(json).toHaveProperty('error');
    expect(json.error).toContain('not found');
  });

  it('human-readable output is unchanged without --json', () => {
    const { stdout, exitCode } = mk('compact', '-d', testDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('✓');
    // Should not be valid JSON
    expect(() => JSON.parse(stdout.trim())).toThrow();
  });
});
