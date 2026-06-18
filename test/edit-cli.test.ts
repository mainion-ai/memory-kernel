/**
 * #247 — `mk edit` CLI smoke test. Exercises the real subprocess + the default
 * $EDITOR spawn path (via a fake editor script), which the in-process engine
 * test (test/edit.test.ts, injected runEditor) cannot cover.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initMemoryDir, createAtom, closeAllIndexes } from '../src/index.js';
import { readEvents } from '../src/event-log.js';

const CLI = path.resolve('dist/cli/mk.js');

let testDir: string;
let editorScript: string;

function mk(env: Record<string, string>, ...args: string[]): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      encoding: 'utf-8',
      timeout: 15000,
      env: { ...process.env, NODE_NO_WARNINGS: '1', HOME: testDir, USERPROFILE: testDir, ...env },
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return { stdout: err.stdout ?? '', exitCode: err.status ?? 1 };
  }
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-edit-cli-'));
  initMemoryDir(testDir);
  // A fake $EDITOR that appends a line to the file it's handed.
  editorScript = path.join(testDir, 'fake-editor.sh');
  fs.writeFileSync(editorScript, '#!/bin/sh\nprintf "\\nappended by fake editor\\n" >> "$1"\n');
  fs.chmodSync(editorScript, 0o755);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('mk edit (CLI)', () => {
  it('launches $EDITOR and records a human_edit event on change', () => {
    const id = createAtom({
      memoryDir: testDir,
      agent_id: 'a',
      session_id: 's',
      type: 'fact',
      slug: 'cli-editable',
      body: 'before',
      confidence: 0.8,
      status: 'active',
      ttl_days: null,
    }).frontmatter.id;

    const res = mk({ EDITOR: editorScript }, 'edit', id, '-d', testDir, '--json');
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout.trim());
    expect(out.changed).toBe(true);
    expect(out.lines_added).toBeGreaterThan(0);

    const human = readEvents(testDir).filter((e) => e.action === 'human_edit');
    expect(human).toHaveLength(1);
    expect(human[0].atom_refs).toEqual([id]);
  });

  it('exits with an error for an unknown atom id', () => {
    const res = mk({ EDITOR: editorScript }, 'edit', 'NOPE-1', '-d', testDir, '--json');
    expect(res.exitCode).toBe(1);
    expect(JSON.parse(res.stdout.trim()).error).toMatch(/not found/i);
  });
});
