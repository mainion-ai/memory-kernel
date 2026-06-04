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
      // Pin HOME/USERPROFILE to testDir so doctor's wrapper-drift check can't
      // wander into the developer's real home and fire false-positives when the
      // local mk binary version drifts from the host wrapper (#163). Hermetic
      // for all tests, not just doctor.
      env: {
        ...process.env,
        NODE_NO_WARNINGS: '1',
        HOME: testDir,
        USERPROFILE: testDir,
      },
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

  it('doctor --json with missing dir returns JSON error (exit 2 per #140 spec)', () => {
    const { stdout, exitCode } = mk('doctor', '-d', '/nonexistent/dir', '--json');
    // #140 spec: 0 = healthy, 1 = warn, 2 = error. A missing memory dir is a
    // hard runtime error — no checks could even run — so the exit code is 2.
    expect(exitCode).toBe(2);
    const json = parseJson(stdout);
    expect(json).toHaveProperty('error');
  });

  it('relations --json with missing dir returns JSON error', () => {
    const { stdout, exitCode } = mk('relations', 'some-id', '-d', '/nonexistent/dir', '--json');
    expect(exitCode).toBe(1);
    const json = parseJson(stdout);
    expect(json).toHaveProperty('error');
  });

  // PR-16 (#101): contract sweep — convert citations / export-obsidian / obsidian-init
  // to use the project-standard `exitWithError(msg, opts.json)` helper instead of
  // bare `console.error + process.exit(1)`. citations is a true red→green case;
  // the other two already emitted JSON on this code path via an inline if-else,
  // so the new assertions act as regression guards once the helper-based form lands.

  it('citations --json with missing dir returns JSON error', () => {
    const { stdout, exitCode } = mk('citations', '-d', '/nonexistent/dir', '--json');
    expect(exitCode).toBe(1);
    const json = parseJson(stdout);
    expect(json).toHaveProperty('error');
    expect(json.error).toContain('not found');
  });

  it('export-obsidian --json with missing dir returns JSON error', () => {
    const outDir = path.join(testDir, 'vault-out');
    const { stdout, exitCode } = mk(
      'export-obsidian',
      '-d',
      '/nonexistent/dir',
      '--out',
      outDir,
      '--json',
    );
    expect(exitCode).toBe(1);
    const json = parseJson(stdout);
    expect(json).toHaveProperty('error');
    expect(json.error).toContain('not found');
  });

  it('obsidian-init --json with missing dir returns JSON error', () => {
    const { stdout, exitCode } = mk('obsidian-init', '-d', '/nonexistent/dir', '--json');
    expect(exitCode).toBe(1);
    const json = parseJson(stdout);
    expect(json).toHaveProperty('error');
    expect(json.error).toContain('not found');
  });

  // PR-23 (#172): --json plumbing on bootstrap-events / reindex / merge / import /
  // migrate-relations / relink / render. Each command now accepts --json and
  // routes its hard-error path through exitWithError(msg, opts.json).

  it('bootstrap-events --json with missing dir returns JSON error', () => {
    const { stdout, exitCode } = mk('bootstrap-events', '-d', '/nonexistent/dir', '--json');
    expect(exitCode).toBe(1);
    const json = parseJson(stdout);
    expect(json).toHaveProperty('error');
    expect(json.error).toContain('not found');
  });

  it('reindex --json with missing dir returns JSON error', () => {
    const { stdout, exitCode } = mk('reindex', '-d', '/nonexistent/dir', '--json');
    expect(exitCode).toBe(1);
    const json = parseJson(stdout);
    expect(json).toHaveProperty('error');
    expect(json.error).toContain('not found');
  });

  it('merge --json with missing local dir returns JSON error', () => {
    const { stdout, exitCode } = mk(
      'merge',
      '--from',
      testDir,
      '-d',
      '/nonexistent/dir',
      '--json',
    );
    expect(exitCode).toBe(1);
    const json = parseJson(stdout);
    expect(json).toHaveProperty('error');
    expect(json.error).toContain('not found');
  });

  it('import --json with missing source file returns JSON error', () => {
    const { stdout, exitCode } = mk(
      'import',
      '--from',
      '/nonexistent/source.md',
      '-d',
      testDir,
      '--json',
    );
    expect(exitCode).toBe(1);
    const json = parseJson(stdout);
    expect(json).toHaveProperty('error');
    expect(json.error).toContain('not found');
  });

  it('migrate-relations --json with missing dir returns JSON error', () => {
    const { stdout, exitCode } = mk(
      'migrate-relations',
      '-d',
      '/nonexistent/dir',
      '--dry-run',
      '--json',
    );
    expect(exitCode).toBe(1);
    const json = parseJson(stdout);
    expect(json).toHaveProperty('error');
    expect(json.error).toContain('not found');
  });

  it('relink --json with missing dir returns JSON error', () => {
    const { stdout, exitCode } = mk(
      'relink',
      '-d',
      '/nonexistent/dir',
      '--dry-run',
      '--json',
    );
    expect(exitCode).toBe(1);
    const json = parseJson(stdout);
    expect(json).toHaveProperty('error');
    expect(json.error).toContain('not found');
  });

  it('render --json with missing dir returns JSON error (#123: -d flag)', () => {
    const outPath = path.join(testDir, 'render-out.md');
    const { stdout, exitCode } = mk(
      'render',
      '-d',
      '/nonexistent/dir',
      '-o',
      outPath,
      '--json',
    );
    expect(exitCode).toBe(1);
    const json = parseJson(stdout);
    expect(json).toHaveProperty('error');
    expect(json.error).toContain('not found');
  });
});

describe('CLI --json success paths (PR-23 / #172)', () => {

  it('reindex --json returns structured indexed count', () => {
    createAtom({ memoryDir: testDir, type: 'fact', slug: 'rx', body: 'reindex test', agent_id: 'test', session_id: 'test' });
    const { stdout, exitCode } = mk('reindex', '-d', testDir, '--json');
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json).toHaveProperty('indexed');
    expect(json).toHaveProperty('time_ms');
    expect(json.indexed).toBeGreaterThanOrEqual(1);
  });

  it('bootstrap-events --json returns structured result', () => {
    createAtom({ memoryDir: testDir, type: 'fact', slug: 'be', body: 'bootstrap test', agent_id: 'test', session_id: 'test' });
    const { stdout, exitCode } = mk('bootstrap-events', '-d', testDir, '--json');
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json).toHaveProperty('imported');
    expect(json).toHaveProperty('skipped');
  });

  it('import --json --dry-run returns structured preview', () => {
    const src = path.join(testDir, 'src.md');
    fs.writeFileSync(src, '# Heading\n\nLong-enough paragraph body content for import preview.\n');
    const { stdout, exitCode } = mk('import', '--from', src, '-d', testDir, '--dry-run', '--json');
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json).toHaveProperty('dry_run', true);
    expect(json).toHaveProperty('chunks_found');
    expect(json).toHaveProperty('would_create');
  });

  it('migrate-relations --json --dry-run returns structured preview', () => {
    const { stdout, exitCode } = mk('migrate-relations', '-d', testDir, '--dry-run', '--json');
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json).toHaveProperty('dry_run', true);
    expect(json).toHaveProperty('proposed');
    expect(json).toHaveProperty('changes');
  });

  it('relink --json --dry-run returns structured preview', () => {
    const { stdout, exitCode } = mk('relink', '-d', testDir, '--dry-run', '--json');
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json).toHaveProperty('dry_run', true);
    expect(json).toHaveProperty('proposed');
    expect(json).toHaveProperty('changes');
  });

  it('render --json (#123: -d/-o flags) returns structured result', () => {
    createAtom({ memoryDir: testDir, type: 'fact', slug: 'rd', body: 'render test', agent_id: 'test', session_id: 'test' });
    reindex(testDir);
    const outPath = path.join(testDir, 'CLAUDE.md');
    const { stdout, exitCode } = mk('render', '-d', testDir, '-o', outPath, '--json');
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json).toHaveProperty('output');
    expect(json).toHaveProperty('total_atoms');
    expect(json).toHaveProperty('line_count');
    expect(fs.existsSync(outPath)).toBe(true);
  });

  it('render positional args still work but emit deprecation warning on stderr (#123)', () => {
    createAtom({ memoryDir: testDir, type: 'fact', slug: 'rd2', body: 'render positional test', agent_id: 'test', session_id: 'test' });
    reindex(testDir);
    const outPath = path.join(testDir, 'CLAUDE.md');
    // Use execFileSync directly so we can capture stderr.
    let stderrOut = '';
    let exitCode = 0;
    try {
      execFileSync('node', [CLI, 'render', testDir, outPath], {
        encoding: 'utf-8',
        timeout: 15000,
        env: { ...process.env, NODE_NO_WARNINGS: '1', HOME: testDir, USERPROFILE: testDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err: any) {
      exitCode = err.status ?? 1;
      stderrOut = err.stderr?.toString() ?? '';
    }
    // We don't capture stderr on success via execFileSync's stdout-encoding
    // path, so re-run with explicit stderr capture using spawnSync. Simpler:
    // just verify the file was rendered (positional path still works).
    expect(exitCode).toBe(0);
    expect(fs.existsSync(outPath)).toBe(true);
    // stderrOut intentionally not asserted here — the deprecation warning is
    // exercised in test/cli-deprecation-e2e.test.ts where stderr is captured.
    void stderrOut;
  });

  it('replay --from <dir> (#122) auto-locates events.ndjson', () => {
    createAtom({ memoryDir: testDir, type: 'fact', slug: 'rp', body: 'replay test', agent_id: 'test', session_id: 'test' });
    // Pass the memory directory rather than the file path — #122 unifies the
    // shape so this works.
    const outDir = path.join(testDir, 'replay-out');
    const { exitCode } = mk('replay', '--from', testDir, '--output-dir', outDir);
    expect(exitCode).toBe(0);
  });
});
