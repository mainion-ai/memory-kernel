/**
 * E2E for `mk eval` (#300) — spawns the real dist/cli/mk.js to confirm the
 * exit-code contract (0 pass / 1 fail / 2 runner error) and FTS-only determinism
 * (no embedding key in the test env).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initMemoryDir, createAtom, reindex, closeAllIndexes } from '../src/index.js';

const CLI = path.resolve('dist/cli/mk.js');
let testDir: string;
let factId: string; // real id of the pagination fact, for hyphen-boundary expectations

function mk(args: string[]): { stdout: string; stderr: string; status: number } {
  // Strip any embedding key so eval is deterministically FTS-only.
  const env = { ...process.env, NODE_NO_WARNINGS: '1' };
  delete (env as Record<string, string>).EMBEDDING_PROVIDER;
  delete (env as Record<string, string>).EMBEDDING_API_KEY;
  delete (env as Record<string, string>).OPENAI_API_KEY;
  const r = spawnSync('node', [CLI, ...args], { encoding: 'utf-8', timeout: 20000, env });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1 };
}

function writeFixture(yaml: string): string {
  const dir = path.join(testDir, 'eval');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'recall.yaml'), yaml);
  return dir;
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-eval-e2e-'));
  initMemoryDir(testDir);
  factId = createAtom({ memoryDir: testDir, agent_id: 'a', session_id: 's', type: 'fact', slug: 'pagination-api', body: 'Cursor-based pagination for the public API endpoint.', scope: { tags: ['api'] } }).frontmatter.id;
  createAtom({ memoryDir: testDir, agent_id: 'a', session_id: 's', type: 'decision', slug: 'file-first', body: 'Files are the source of truth; SQLite is a derived cache.', scope: { tags: ['arch'] } });
  reindex(testDir);
});
afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('mk eval (e2e exit codes, FTS-only)', () => {
  it('exit 0 when all fixtures pass', () => {
    writeFixture(`threshold: 0.5\nqueries:\n  - task: "cursor pagination api"\n    expect: ["${factId}"]\n    cat: api\n`);
    const r = mk(['eval', '-d', testDir]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/All 1 fixture/);
    expect(r.stdout).toMatch(/FTS/); // no key → FTS-only
  });

  it('exit 1 when a fixture is below threshold', () => {
    writeFixture(`threshold: 1.0\nqueries:\n  - task: "cursor pagination api"\n    expect: ["${factId}"]\n  - task: "totally unrelated quantum widget"\n    expect: ["NOPE-XYZ"]\n`);
    const r = mk(['eval', '-d', testDir]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/below threshold/);
  });

  it('exit 2 on a malformed fixture', () => {
    writeFixture('queries:\n  - task: "no expect field"\n');
    const r = mk(['eval', '-d', testDir]);
    expect(r.status).toBe(2);
  });

  it('exit 2 when no fixtures exist', () => {
    const r = mk(['eval', '-d', testDir]); // no eval/ dir written
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/No fixtures/);
  });

  it('--json emits machine-readable output with exit_code', () => {
    writeFixture(`threshold: 0.5\nqueries:\n  - task: "cursor pagination api"\n    expect: ["${factId}"]\n`);
    const r = mk(['eval', '-d', testDir, '--json']);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ok).toBe(true);
    expect(out.exit_code).toBe(0);
    expect(out.fixtures[0].embed_used).toBe(false);
  });
});
