/**
 * SQLite index — tests.
 * Verifies index creation, rebuild, query filtering, and recall integration.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  initMemoryDir,
  createAtom,
  recall,
  listAtoms,
  reindex,
  indexExists,
  indexStats,
  queryIndex,
} from '../src/index.js';
import { indexAtom, removeFromIndex } from '../src/index-db.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-idx-'));
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

const base = (dir: string) => ({
  memoryDir: dir,
  agent_id: 'test',
  session_id: 'test-session',
});

describe('SQLite index', () => {
  it('should create index on reindex', () => {
    initMemoryDir(testDir);
    expect(indexExists(testDir)).toBe(false);

    const result = reindex(testDir);
    expect(result.indexed).toBe(0);
    expect(result.timeMs).toBeGreaterThanOrEqual(0);
    expect(indexExists(testDir)).toBe(true);
  });

  it('should index all atoms on reindex', () => {
    initMemoryDir(testDir);

    createAtom({ ...base(testDir), type: 'fact', slug: 'a', body: 'Fact A' });
    createAtom({ ...base(testDir), type: 'belief', slug: 'b', body: 'Belief B' });
    createAtom({ ...base(testDir), type: 'decision', slug: 'c', body: 'Decision C' });

    const result = reindex(testDir);
    expect(result.indexed).toBe(3);

    const stats = indexStats(testDir);
    expect(stats).not.toBeNull();
    expect(stats!.atoms).toBe(3);
  });

  it('should query by type', () => {
    initMemoryDir(testDir);

    createAtom({ ...base(testDir), type: 'fact', slug: 'f1', body: 'Fact 1' });
    createAtom({ ...base(testDir), type: 'belief', slug: 'b1', body: 'Belief 1' });
    createAtom({ ...base(testDir), type: 'fact', slug: 'f2', body: 'Fact 2' });

    reindex(testDir);

    const results = queryIndex(testDir, { types: ['fact'] });
    expect(results).not.toBeNull();
    expect(results!.length).toBe(2);
    expect(results!.every((r) => r.type === 'fact')).toBe(true);
  });

  it('should query by status', () => {
    initMemoryDir(testDir);

    createAtom({ ...base(testDir), type: 'fact', slug: 'active-one', body: 'Active' });
    // Beliefs default to draft status
    createAtom({ ...base(testDir), type: 'belief', slug: 'draft-one', body: 'Draft' });

    reindex(testDir);

    const results = queryIndex(testDir, { statuses: ['draft'] });
    expect(results).not.toBeNull();
    expect(results!.length).toBe(1);
    expect(results![0].status).toBe('draft');
  });

  it('should query by tags', () => {
    initMemoryDir(testDir);

    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'tagged',
      body: 'Tagged fact',
      scope: { tags: ['infra', 'pi'] },
    });
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'untagged',
      body: 'Untagged fact',
    });

    reindex(testDir);

    const results = queryIndex(testDir, { tags: ['infra'] });
    expect(results).not.toBeNull();
    expect(results!.length).toBe(1);
    expect(results![0].atom_id.toLowerCase()).toContain('tagged');
  });

  it('should query by paths with prefix matching', () => {
    initMemoryDir(testDir);

    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'scoped',
      body: 'Scoped fact',
      scope: { paths: ['/projects/memory-kernel'] },
    });
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'other-scope',
      body: 'Other scope',
      scope: { paths: ['/projects/sandbox'] },
    });
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'no-scope',
      body: 'No scope — matches everything',
    });

    reindex(testDir);

    const results = queryIndex(testDir, { paths: ['/projects/memory-kernel'] });
    expect(results).not.toBeNull();
    // Should get the scoped match + the unscoped atom (unscoped matches everything)
    expect(results!.length).toBe(2);
  });

  it('should exclude archived and expired by default', () => {
    initMemoryDir(testDir);

    createAtom({ ...base(testDir), type: 'fact', slug: 'active', body: 'Active' });
    createAtom({ ...base(testDir), type: 'fact', slug: 'archived', body: 'Archived' });

    // Manually mark one as archived in the index
    reindex(testDir);
    const atoms = listAtoms(testDir);
    const archivedAtom = atoms.find((a) => a.frontmatter.id.toLowerCase().includes('archived'))!;
    expect(archivedAtom).toBeDefined();
    archivedAtom.frontmatter.status = 'archived';
    indexAtom(testDir, archivedAtom);

    const results = queryIndex(testDir);
    expect(results).not.toBeNull();
    expect(results!.length).toBe(1);
    expect(results![0].atom_id.toLowerCase()).toContain('active');
  });

  it('should return null when no index exists', () => {
    initMemoryDir(testDir);
    const results = queryIndex(testDir);
    expect(results).toBeNull();
  });

  it('should handle indexAtom upsert', () => {
    initMemoryDir(testDir);
    reindex(testDir);

    const atom = createAtom({ ...base(testDir), type: 'fact', slug: 'new', body: 'New fact' });
    indexAtom(testDir, atom);

    const stats = indexStats(testDir);
    expect(stats!.atoms).toBe(1);

    // Upsert same atom
    atom.body = 'Updated fact';
    indexAtom(testDir, atom);

    const stats2 = indexStats(testDir);
    expect(stats2!.atoms).toBe(1); // Still 1, not 2
  });

  it('should handle removeFromIndex', () => {
    initMemoryDir(testDir);

    const atom = createAtom({ ...base(testDir), type: 'fact', slug: 'removable', body: 'To be removed' });
    reindex(testDir);

    expect(indexStats(testDir)!.atoms).toBe(1);
    removeFromIndex(testDir, atom.frontmatter.id);
    expect(indexStats(testDir)!.atoms).toBe(0);
  });

  it('should sort by status priority then updated_at', () => {
    initMemoryDir(testDir);

    // Create atoms with slight delay to get different timestamps
    createAtom({ ...base(testDir), type: 'fact', slug: 'fact-first', body: 'First fact' });
    createAtom({ ...base(testDir), type: 'belief', slug: 'belief-draft', body: 'Draft belief' });
    createAtom({ ...base(testDir), type: 'fact', slug: 'fact-second', body: 'Second fact' });

    reindex(testDir);

    const results = queryIndex(testDir);
    expect(results).not.toBeNull();
    expect(results!.length).toBe(3);
    // Active atoms (facts) should come before draft (belief)
    expect(results![0].status).toBe('active');
    expect(results![1].status).toBe('active');
    expect(results![2].status).toBe('draft');
  });

  it('recall should use index when available', () => {
    initMemoryDir(testDir);

    createAtom({ ...base(testDir), type: 'fact', slug: 'f1', body: 'Fact for recall' });
    createAtom({ ...base(testDir), type: 'belief', slug: 'b1', body: 'Belief for recall' });
    createAtom({ ...base(testDir), type: 'decision', slug: 'd1', body: 'Decision for recall' });

    // Build index
    reindex(testDir);

    // Recall with type filter — should use index
    const bundle = recall(testDir, { types: ['fact'] });
    expect(bundle.atoms.length).toBe(1);
    expect(bundle.atoms[0].frontmatter.type).toBe('fact');
  });

  it('recall should work without index (fallback)', () => {
    initMemoryDir(testDir);

    createAtom({ ...base(testDir), type: 'fact', slug: 'f1', body: 'Fact without index' });
    createAtom({ ...base(testDir), type: 'belief', slug: 'b1', body: 'Belief without index' });

    // No reindex — recall falls back to file scan
    const bundle = recall(testDir, { types: ['fact'] });
    expect(bundle.atoms.length).toBe(1);
    expect(bundle.atoms[0].frontmatter.type).toBe('fact');
  });

  it('should index tags in stats', () => {
    initMemoryDir(testDir);

    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'multi-tag',
      body: 'Multi-tagged',
      scope: { tags: ['alpha', 'beta', 'gamma'] },
    });

    reindex(testDir);

    const stats = indexStats(testDir);
    expect(stats!.tags).toBe(3);
  });
});
