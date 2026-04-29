import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

import { initMemoryDir, createAtom, closeAllIndexes } from '../src/index.js';
import { wanderFromAtoms } from '../src/wander.js';
import type { Atom } from '../src/types.js';

const MK_BIN = path.resolve('dist/cli/mk.js');

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-wander-asof-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('wanderFromAtoms', () => {
  it('runs spreading activation against a pre-built atom list', () => {
    const a = createAtom({
      memoryDir: testDir, agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'a', body: 'a',
      scope: { tags: ['shared-tag'] },
    });
    const b = createAtom({
      memoryDir: testDir, agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'b', body: 'b',
      scope: { tags: ['shared-tag'] },
    });
    const atoms: Atom[] = [a, b];

    const result = wanderFromAtoms(atoms, {
      memoryDir: testDir,
      seeds: [a.frontmatter.id],
      steps: 2,
    });

    expect(result.activated.length).toBeGreaterThanOrEqual(1);
    expect(result.seeds_used).toContain(a.frontmatter.id);
  });

  it('returns empty result when atom list is empty', () => {
    const result = wanderFromAtoms([], { memoryDir: testDir, seeds: ['MISSING'] });
    expect(result.activated).toEqual([]);
    expect(result.collisions).toEqual([]);
  });
});

describe('mk wander --as-of', () => {
  it('returns identical results across runs (determinism)', () => {
    if (!fs.existsSync(MK_BIN)) return;

    // Build a small history
    createAtom({ memoryDir: testDir, agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'history-1', body: 'one', scope: { tags: ['t'] } });
    createAtom({ memoryDir: testDir, agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'history-2', body: 'two', scope: { tags: ['t'] } });

    const asOf = new Date(Date.now() + 60_000).toISOString(); // future, includes all events

    const out1 = execFileSync('node', [MK_BIN, 'wander', '-d', testDir, '--as-of', asOf, '--json', '--steps', '2'], { encoding: 'utf-8' });
    const out2 = execFileSync('node', [MK_BIN, 'wander', '-d', testDir, '--as-of', asOf, '--json', '--steps', '2'], { encoding: 'utf-8' });

    const r1 = JSON.parse(out1);
    const r2 = JSON.parse(out2);

    // duration_ms varies; everything else must match
    delete r1.duration_ms;
    delete r2.duration_ms;
    expect(r1).toEqual(r2);
  });

  it('excludes atoms not yet created at the as-of timestamp', () => {
    if (!fs.existsSync(MK_BIN)) return;

    // Atoms created now
    createAtom({ memoryDir: testDir, agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'modern', body: 'modern' });

    // Use an as-of time that's BEFORE the events.ndjson file's first event
    const ancient = '2020-01-01T00:00:00Z';
    const out = execFileSync('node', [MK_BIN, 'wander', '-d', testDir, '--as-of', ancient, '--json'], { encoding: 'utf-8' });
    const r = JSON.parse(out);

    expect(r.activated).toEqual([]);
  });
});
