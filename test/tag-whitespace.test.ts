/**
 * Tag-whitespace hygiene (#262, absorbs #264): the `tag-format` doctor check
 * and `mk remember`'s write-time warning, both via the shared isValidTag.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { initMemoryDir, createAtom, closeAllIndexes } from '../src/index.js';
import { isValidTag } from '../src/format.js';
import { tagFormatCheck } from '../src/doctor/checks/tag-format.js';
import type { DoctorContext } from '../src/doctor/types.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/cli/mk.js');
let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-tag-ws-'));
  initMemoryDir(testDir);
});
afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

function ctx(): DoctorContext {
  return { memoryDir: testDir, kernelVersion: '1.33.2', skipCategories: new Set(), env: {} };
}

describe('isValidTag (#262)', () => {
  it('accepts single tokens, rejects whitespace/empty', () => {
    expect(isValidTag('peer-review')).toBe(true);
    expect(isValidTag('N-version')).toBe(true);
    expect(isValidTag('AIRE peer-review')).toBe(false);
    expect(isValidTag('two words')).toBe(false);
    expect(isValidTag('tab\there')).toBe(false);
    expect(isValidTag('')).toBe(false);
  });
});

describe('tag-format doctor check (#262)', () => {
  it('flags an atom with a whitespace tag', () => {
    createAtom({
      memoryDir: testDir, agent_id: 'a', session_id: 's', type: 'fact', slug: 'bad',
      body: 'x', scope: { tags: ['AIRE peer-review N-version'] },
    });
    const r = tagFormatCheck.run(ctx()) as { ok: boolean; severity: string; issues: string[] };
    expect(r.ok).toBe(false);
    expect(r.severity).toBe('warn');
    expect(r.issues.join(' ')).toContain('tag contains whitespace');
    expect(r.issues.join(' ')).toContain('AIRE peer-review N-version');
  });

  it('passes a store with well-formed tags', () => {
    createAtom({
      memoryDir: testDir, agent_id: 'a', session_id: 's', type: 'fact', slug: 'good',
      body: 'x', scope: { tags: ['AIRE', 'peer-review', 'N-version'] },
    });
    const r = tagFormatCheck.run(ctx()) as { ok: boolean };
    expect(r.ok).toBe(true);
  });

  it('passes an atom with no tags', () => {
    createAtom({ memoryDir: testDir, agent_id: 'a', session_id: 's', type: 'fact', slug: 'notags', body: 'x' });
    const r = tagFormatCheck.run(ctx()) as { ok: boolean };
    expect(r.ok).toBe(true);
  });
});

describe('mk remember tag-whitespace warning (#262, absorbs #264)', () => {
  const remember = (...tagArgs: string[]) =>
    spawnSync('node', [CLI, 'remember', 'a body', '-d', testDir, '-t', 'fact', '--tags', ...tagArgs], { encoding: 'utf8' });

  it('warns to stderr (non-fatal) when a quoted --tags value contains whitespace', () => {
    const r = remember('foo bar baz'); // one whitespace-containing token
    expect(r.status).toBe(0); // non-fatal — atom still written
    expect(r.stdout).toContain('Created');
    expect(r.stderr).toContain('whitespace');
  });

  it('does NOT warn when --tags are separate clean tokens', () => {
    const r = remember('foo', 'bar', 'baz'); // three clean args
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('whitespace');
  });

  it('does NOT warn on a comma-list (normalizeTags splits it cleanly) — agrees with doctor (#262 review)', () => {
    const r = remember('foo, bar, baz'); // comma+space → normalizeTags → [foo,bar,baz]
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('whitespace');
  });
});
