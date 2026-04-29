import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

import { initMemoryDir, createAtom, updateAtom, closeAllIndexes } from '../src/index.js';
import { initIsolatedBase } from '../src/isolation.js';
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

  it('includes atoms in their pre-update form when an update happened after the as-of timestamp', () => {
    if (!fs.existsSync(MK_BIN)) return;

    // T1: create A. T2: as-of timestamp. T3: update A.
    // wander --as-of T2 must include A in its T1 form, not drop it.
    const a = createAtom({
      memoryDir: testDir, agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'pre-update', body: 'pre-update body',
      scope: { tags: ['snapshot-tag'] },
    });
    // Capture asOf BEFORE the update so the update lands strictly after.
    // normalizeTimestamp() truncates to second precision (src/format.ts), so the
    // gap between asOf and the post-update event must cross a full second boundary
    // for the comparison to be meaningful. We use 1.1s slack to absorb scheduler
    // jitter on slow CI runners.
    const asOf = new Date(Date.now() + 1100).toISOString();
    const waitUntil = Date.now() + 1300;
    while (Date.now() < waitUntil) { /* spin briefly */ }

    // Re-write the atom with new body — produces an atom_updated event after asOf.
    updateAtom({
      memoryDir: testDir, agent_id: 'a', session_id: 's',
      filePath: a.filePath!,
      updates: {},
      body: 'POST-UPDATE body that should NOT be visible at as-of',
    });

    const out = execFileSync(
      'node',
      [MK_BIN, 'wander', '-d', testDir, '--as-of', asOf, '--json', '--seed', a.frontmatter.id, '--steps', '1'],
      { encoding: 'utf-8' },
    );
    const r = JSON.parse(out);

    // The seed must have been resolved — i.e. atom A is present in the as-of graph.
    expect(r.seeds_used).toContain(a.frontmatter.id);
  });

  it('includes shared-namespace atoms when --as-of is used in isolated mode', () => {
    if (!fs.existsSync(MK_BIN)) return;

    // Set up isolated layout via the canonical helper.
    initIsolatedBase(testDir, 'a1');
    const sharedDir = path.join(testDir, 'shared');

    // One atom in shared namespace, none in agent namespace.
    const sharedAtom = createAtom({
      memoryDir: sharedDir, agent_id: 'sys', session_id: 's',
      type: 'fact', slug: 'shared-only', body: 'shared content',
      scope: { tags: ['shared-tag'] },
    });

    const asOf = new Date(Date.now() + 60_000).toISOString();
    const out = execFileSync(
      'node',
      [MK_BIN, '-a', 'a1', 'wander', '-d', testDir, '--as-of', asOf, '--json', '--seed', sharedAtom.frontmatter.id, '--steps', '1'],
      { encoding: 'utf-8' },
    );
    const r = JSON.parse(out);

    expect(r.seeds_used).toContain(sharedAtom.frontmatter.id);
  });
});
