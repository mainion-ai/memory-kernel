/**
 * Tests for mk lint — semantic health checking.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  initMemoryDir,
  createAtom,
  reindex,
  closeAllIndexes,
  addRelation,
  writeAtom,
} from '../src/index.js';
import { lintMemoryStore } from '../src/lint.js';

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

function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

const RETAIN_OPTS = { agent_id: 'test', session_id: 'test-session' };

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-lint-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

/** Create an atom, then overwrite its file with modified frontmatter. */
function createAndPatch(
  opts: Parameters<typeof createAtom>[0],
  patch: Partial<import('../src/types.js').AtomFrontmatter>,
) {
  const atom = createAtom(opts);
  Object.assign(atom.frontmatter, patch);
  writeAtom(atom, atom.filePath!);
  return atom;
}

describe('lintMemoryStore()', () => {
  it('empty store produces no findings', () => {
    const result = lintMemoryStore(testDir);
    expect(result.findings).toHaveLength(0);
    expect(result.summary.total).toBe(0);
    expect(result.summary.warnings).toBe(0);
    expect(result.summary.info).toBe(0);
  });

  it('detects active contradictions', () => {
    const a = createAndPatch(
      { ...RETAIN_OPTS, memoryDir: testDir, type: 'belief', slug: 'alpha', body: '## Alpha\nSomething is true.', confidence: 0.8 },
      { status: 'active' },
    );
    const b = createAndPatch(
      { ...RETAIN_OPTS, memoryDir: testDir, type: 'belief', slug: 'beta', body: '## Beta\nSomething is false.', confidence: 0.8 },
      { status: 'active' },
    );

    reindex(testDir);
    addRelation(testDir, a.frontmatter.id, b.frontmatter.id, 'contradicts');

    const result = lintMemoryStore(testDir);
    const contradictions = result.findings.filter((f) => f.category === 'contradiction');
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0].severity).toBe('warning');
    expect(contradictions[0].atom_ids).toContain(a.frontmatter.id);
    expect(contradictions[0].atom_ids).toContain(b.frontmatter.id);
  });

  it('does not flag contradiction when one atom is archived', () => {
    const a = createAndPatch(
      { ...RETAIN_OPTS, memoryDir: testDir, type: 'belief', slug: 'gamma', body: '## Gamma\nA claim.', confidence: 0.8 },
      { status: 'active' },
    );
    const b = createAndPatch(
      { ...RETAIN_OPTS, memoryDir: testDir, type: 'belief', slug: 'delta', body: '## Delta\nA counterclaim.', confidence: 0.8 },
      { status: 'archived' },
    );

    reindex(testDir);
    addRelation(testDir, a.frontmatter.id, b.frontmatter.id, 'contradicts');

    const result = lintMemoryStore(testDir);
    const contradictions = result.findings.filter((f) => f.category === 'contradiction');
    expect(contradictions).toHaveLength(0);
  });

  it('detects stale facts', () => {
    createAndPatch(
      { ...RETAIN_OPTS, memoryDir: testDir, type: 'fact', slug: 'old-fact', body: '## Old fact\nThis is old.' },
      { status: 'active', updated_at: daysAgo(100), created_at: daysAgo(100) },
    );

    // Clear the events file so no recent events exist for this atom
    fs.writeFileSync(path.join(testDir, 'events.ndjson'), '');

    reindex(testDir);
    const result = lintMemoryStore(testDir);
    const stale = result.findings.filter((f) => f.category === 'stale');
    expect(stale).toHaveLength(1);
    expect(stale[0].severity).toBe('warning');
  });

  it('does not flag recent facts as stale', () => {
    createAndPatch(
      { ...RETAIN_OPTS, memoryDir: testDir, type: 'fact', slug: 'fresh-fact', body: '## Fresh fact\nThis is recent.' },
      { status: 'active', updated_at: daysAgo(30) },
    );

    reindex(testDir);
    const result = lintMemoryStore(testDir);
    const stale = result.findings.filter((f) => f.category === 'stale');
    expect(stale).toHaveLength(0);
  });

  it('detects orphaned atoms', () => {
    createAndPatch(
      { ...RETAIN_OPTS, memoryDir: testDir, type: 'belief', slug: 'lonely', body: '## Lonely belief\nNo connections.', confidence: 0.7 },
      { status: 'active' },
    );

    reindex(testDir);
    const result = lintMemoryStore(testDir);
    const orphans = result.findings.filter((f) => f.category === 'orphan');
    expect(orphans).toHaveLength(1);
    expect(orphans[0].severity).toBe('info');
  });

  it('does not flag entity_summary as orphan', () => {
    createAndPatch(
      { ...RETAIN_OPTS, memoryDir: testDir, type: 'entity_summary', slug: 'some-entity', body: '## Entity\nStandalone entity summary.' },
      { status: 'active' },
    );

    reindex(testDir);
    const result = lintMemoryStore(testDir);
    const orphans = result.findings.filter((f) => f.category === 'orphan');
    expect(orphans).toHaveLength(0);
  });

  it('detects confidence drift', () => {
    createAndPatch(
      { ...RETAIN_OPTS, memoryDir: testDir, type: 'belief', slug: 'low-conf', body: '## Low confidence belief\nUncertain.', confidence: 0.4 },
      { status: 'active', updated_at: daysAgo(45) },
    );

    reindex(testDir);
    const result = lintMemoryStore(testDir);
    const drift = result.findings.filter((f) => f.category === 'confidence_drift');
    expect(drift).toHaveLength(1);
    expect(drift[0].severity).toBe('info');
    expect(drift[0].message).toContain('0.4');
  });

  it('detects TTL warnings', () => {
    createAndPatch(
      { ...RETAIN_OPTS, memoryDir: testDir, type: 'belief', slug: 'expiring', body: '## Expiring soon\nAlmost gone.', confidence: 0.6, ttl_days: 5 },
      { status: 'active', created_at: daysAgo(2) },
    );

    reindex(testDir);
    const result = lintMemoryStore(testDir);
    const ttl = result.findings.filter((f) => f.category === 'ttl_warning');
    expect(ttl).toHaveLength(1);
    expect(ttl[0].severity).toBe('warning');
    expect(ttl[0].message).toContain('expires in');
  });

  it('custom stale-days threshold', () => {
    createAndPatch(
      { ...RETAIN_OPTS, memoryDir: testDir, type: 'fact', slug: 'medium-age', body: '## Medium age fact\nSomewhat old.' },
      { status: 'active', updated_at: daysAgo(40), created_at: daysAgo(40) },
    );

    fs.writeFileSync(path.join(testDir, 'events.ndjson'), '');

    reindex(testDir);

    // Default 90 days — not stale
    const r1 = lintMemoryStore(testDir, { staleDays: 90 });
    expect(r1.findings.filter((f) => f.category === 'stale')).toHaveLength(0);

    // Custom 30 days — stale
    const r2 = lintMemoryStore(testDir, { staleDays: 30 });
    expect(r2.findings.filter((f) => f.category === 'stale')).toHaveLength(1);
  });

  it('detects near-duplicates with overlapping tags', () => {
    createAndPatch(
      { ...RETAIN_OPTS, memoryDir: testDir, type: 'fact', slug: 'notation-erasure-first', body: '## Notation erasure in music\nNotation systems erase.', scope: { tags: ['notation', 'erasure', 'music'] } },
      { status: 'active' },
    );
    createAndPatch(
      { ...RETAIN_OPTS, memoryDir: testDir, type: 'fact', slug: 'notation-erasure-second', body: '## Notation erasure in music\nNotation systems erase things.', scope: { tags: ['notation', 'erasure', 'music', 'art'] } },
      { status: 'active' },
    );

    reindex(testDir);
    const result = lintMemoryStore(testDir);
    const dupes = result.findings.filter((f) => f.category === 'duplicate');
    expect(dupes).toHaveLength(1);
    expect(dupes[0].severity).toBe('warning');
    expect(dupes[0].atom_ids).toHaveLength(2);
  });
});

describe('mk lint CLI', () => {
  it('JSON output format matches spec', () => {
    const result = mk('lint', '--dir', testDir, '--json');
    const json = JSON.parse(result.stdout.trim());
    expect(json).toHaveProperty('findings');
    expect(json).toHaveProperty('summary');
    expect(Array.isArray(json.findings)).toBe(true);
    expect(json.summary).toHaveProperty('total');
    expect(json.summary).toHaveProperty('warnings');
    expect(json.summary).toHaveProperty('info');
  });

  it('plain text output includes summary', () => {
    const result = mk('lint', '--dir', testDir);
    expect(result.stdout).toContain('Linting memory store');
  });
});
