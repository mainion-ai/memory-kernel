/**
 * Smoke tests for CLI --json output.
 * Verifies that JSON-flag commands emit valid, parseable JSON and that
 * error paths also produce structured JSON when --json is active.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initMemoryDir, createAtom, reindex, closeAllIndexes } from '../src/index.js';

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
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-cli-json-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('CLI --json output', () => {

  it('status --json returns valid JSON with expected keys', () => {
    createAtom({ memoryDir: testDir, type: 'fact', slug: 'test', body: 'hello', agent_id: 'test', session_id: 'test' });
    const { stdout, exitCode } = mk('status', '-d', testDir, '--json');
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json).toHaveProperty('atom_count');
    expect(json).toHaveProperty('event_count');
    expect(json).toHaveProperty('by_type');
    expect(json).toHaveProperty('by_status');
    expect(json).toHaveProperty('index');
    expect(json.atom_count).toBe(1);
  });

  it('remember --json returns valid JSON with atom id', () => {
    const { stdout, exitCode } = mk('remember', '-d', testDir, '-t', 'fact', '--json', 'test fact body');
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json).toHaveProperty('id');
    expect(json).toHaveProperty('type', 'fact');
    expect(json).toHaveProperty('status');
    expect(json).toHaveProperty('embedded');
    expect(json).toHaveProperty('embedding_warning');
  });

  it('reflect --json returns valid JSON', () => {
    createAtom({ memoryDir: testDir, type: 'fact', slug: 'test', body: 'hello', agent_id: 'test', session_id: 'test' });
    const { stdout, exitCode } = mk('reflect', '-d', testDir, '--json');
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json).toHaveProperty('deduped');
    expect(json).toHaveProperty('expired');
    expect(json).toHaveProperty('promoted');
  });

  it('doctor --json returns healthy status', () => {
    createAtom({ memoryDir: testDir, type: 'fact', slug: 'test', body: 'hello', agent_id: 'test', session_id: 'test' });
    const { stdout, exitCode } = mk('doctor', '-d', testDir, '--json');
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json).toHaveProperty('healthy', true);
    expect(json).toHaveProperty('issue_count', 0);
    expect(json).toHaveProperty('issues');
  });

  it('recall --json returns valid JSON bundle', () => {
    createAtom({ memoryDir: testDir, type: 'fact', slug: 'test', body: 'recall test body', agent_id: 'test', session_id: 'test' });
    reindex(testDir);
    const { stdout, exitCode } = mk('recall', '-d', testDir, '--json');
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json).toHaveProperty('token_estimate');
    expect(json).toHaveProperty('atoms');
  });

  it('gc --json returns valid JSON', () => {
    const { stdout, exitCode } = mk('gc', '-d', testDir, '--json');
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json).toHaveProperty('expired');
    expect(json).toHaveProperty('archived');
  });

  it('episodes --json returns valid JSON array', () => {
    const { stdout, exitCode } = mk('episodes', '-d', testDir, '--json');
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(Array.isArray(json)).toBe(true);
  });
});

describe('CLI --json error paths', () => {

  it('status --json with missing dir returns JSON error', () => {
    const { stdout, exitCode } = mk('status', '-d', '/nonexistent/dir', '--json');
    expect(exitCode).toBe(1);
    const json = parseJson(stdout);
    expect(json).toHaveProperty('error');
    expect(json.error).toContain('not found');
  });

  it('recall --json with missing dir returns JSON error', () => {
    const { stdout, exitCode } = mk('recall', '-d', '/nonexistent/dir', '--json');
    expect(exitCode).toBe(1);
    const json = parseJson(stdout);
    expect(json).toHaveProperty('error');
  });

  it('remember --json with missing dir returns JSON error', () => {
    const { stdout, exitCode } = mk('remember', '-d', '/nonexistent/dir', '-t', 'fact', '--json', 'test');
    expect(exitCode).toBe(1);
    const json = parseJson(stdout);
    expect(json).toHaveProperty('error');
  });

  it('doctor --json with missing dir returns JSON error', () => {
    const { stdout, exitCode } = mk('doctor', '-d', '/nonexistent/dir', '--json');
    expect(exitCode).toBe(1);
    const json = parseJson(stdout);
    expect(json).toHaveProperty('error');
  });

  it('relations --json with missing dir returns JSON error', () => {
    const { stdout, exitCode } = mk('relations', 'some-id', '-d', '/nonexistent/dir', '--json');
    expect(exitCode).toBe(1);
    const json = parseJson(stdout);
    expect(json).toHaveProperty('error');
  });
});
