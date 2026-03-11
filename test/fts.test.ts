/**
 * FTS5 full-text search + task-aware recall — tests.
 *
 * Covers:
 * - searchFts() basic ranking
 * - searchFts() graceful degradation (null when index absent)
 * - Task-aware recall ordering
 * - Determinism: same query produces identical ordered bundle
 * - Regression: no-task recall uses status-priority order unchanged
 * - Reindex rebuilds FTS; subsequent searchFts returns results
 * - Special chars / injection safety in task query
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  initMemoryDir,
  createAtom,
  recall,
  reindex,
  indexExists,
  searchFts,
  closeAllIndexes,
} from '../src/index.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-fts-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

const base = (dir: string) => ({
  memoryDir: dir,
  agent_id: 'test',
  session_id: 'test-session',
});

// ---------------------------------------------------------------------------
// searchFts() unit tests
// ---------------------------------------------------------------------------

describe('searchFts()', () => {
  it('returns null when index does not exist', () => {
    // No reindex called — index file not created yet
    expect(indexExists(testDir)).toBe(false);
    expect(searchFts(testDir, 'anything')).toBeNull();
  });

  it('returns empty array (not null) when index exists but no matches', () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'unrelated', body: 'Something completely different' });
    reindex(testDir);
    const results = searchFts(testDir, 'pagination cursor offset');
    expect(results).not.toBeNull();
    expect(results).toEqual([]);
  });

  it('returns ranked results for a matching query', () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'pagination', body: '## Pagination\n\nCursor-based pagination for API v2. Offset pagination is deprecated.' });
    createAtom({ ...base(testDir), type: 'fact', slug: 'auth', body: 'Authentication uses JWT tokens.' });
    reindex(testDir);

    const results = searchFts(testDir, 'pagination');
    expect(results).not.toBeNull();
    expect(results!.length).toBeGreaterThanOrEqual(1);
    // Atom IDs use uppercase slug segment (e.g. FACT-...-PAGINATION-...)
    expect(results![0].atom_id.toLowerCase()).toContain('pagination');
  });

  it('returns results with a rank property (BM25 negative number)', () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'test', body: 'Test atom with some searchable content here' });
    reindex(testDir);

    const results = searchFts(testDir, 'searchable content');
    expect(results).not.toBeNull();
    expect(results!.length).toBeGreaterThan(0);
    // BM25 rank in SQLite FTS5 is negative (lower = better match)
    expect(typeof results![0].rank).toBe('number');
    expect(results![0].rank).toBeLessThan(0);
  });

  it('stemming: "paginate" matches atom containing "pagination"', () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'page', body: 'We use cursor-based pagination in all API endpoints.' });
    reindex(testDir);

    const results = searchFts(testDir, 'paginate');
    expect(results).not.toBeNull();
    expect(results!.length).toBeGreaterThan(0);
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      createAtom({ ...base(testDir), type: 'fact', slug: `fact-${i}`, body: `Fact number ${i} about deployment and infrastructure.` });
    }
    reindex(testDir);

    const results3 = searchFts(testDir, 'deployment infrastructure', 3);
    expect(results3).not.toBeNull();
    expect(results3!.length).toBeLessThanOrEqual(3);
  });

  it('does not crash on FTS5 special characters in query (injection safety)', () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'sql', body: 'Database schema and SQL queries.' });
    reindex(testDir);

    // These should all be sanitised safely without throwing
    const dangerous = [
      'DELETE FROM atoms',
      '"quote" AND (parens)',
      'term* OR other',
      'NOT something',
      '   ',   // whitespace-only → returns []
      '"',     // lone quote
    ];

    for (const query of dangerous) {
      expect(() => searchFts(testDir, query)).not.toThrow();
    }
  });

  it('returns [] for whitespace-only query after sanitisation', () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'x', body: 'Any content' });
    reindex(testDir);

    const results = searchFts(testDir, '   ');
    expect(results).not.toBeNull();
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// FTS rebuild via reindex()
// ---------------------------------------------------------------------------

describe('reindex() rebuilds FTS', () => {
  it('subsequent searchFts() returns expected results after reindex', () => {
    createAtom({ ...base(testDir), type: 'decision', slug: 'caching', body: '## Caching Strategy\n\nUse Redis for session caching and rate limiting.' });
    createAtom({ ...base(testDir), type: 'fact', slug: 'db', body: 'PostgreSQL is the primary database.' });

    reindex(testDir);

    // Search for a single distinctive term from the caching atom
    const results = searchFts(testDir, 'redis');
    expect(results).not.toBeNull();
    expect(results!.length).toBeGreaterThan(0);
    // Atom IDs use uppercase slug segment (e.g. DECI-...-CACHING-...)
    expect(results![0].atom_id.toLowerCase()).toContain('caching');
  });

  it('FTS is updated after second reindex following new atoms', () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'first', body: 'Initial fact about microservices.' });
    reindex(testDir);

    // First search — should not find "kubernetes"
    const before = searchFts(testDir, 'kubernetes');
    expect(before).toEqual([]);

    // Add new atom and reindex
    createAtom({ ...base(testDir), type: 'fact', slug: 'k8s', body: 'Kubernetes orchestrates container deployments.' });
    reindex(testDir);

    const after = searchFts(testDir, 'kubernetes');
    expect(after).not.toBeNull();
    expect(after!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Task-aware recall ordering
// ---------------------------------------------------------------------------

describe('recall() with task parameter', () => {
  it('ranks atom containing task keyword above unrelated atoms', () => {
    const paginationAtom = createAtom({ ...base(testDir), type: 'decision', slug: 'pagination', body: 'Cursor-based pagination replaces offset for all API endpoints.' });
    createAtom({ ...base(testDir), type: 'fact', slug: 'auth', body: 'JWT tokens expire after 24 hours.' });
    createAtom({ ...base(testDir), type: 'constraint', slug: 'db', body: 'PostgreSQL version must be 14 or higher.' });

    reindex(testDir);

    // Use a single distinctive term — multi-word phrases require adjacency in FTS5
    const bundle = recall(testDir, { task: 'pagination' });
    expect(bundle.atoms.length).toBeGreaterThanOrEqual(1);
    // The pagination decision should appear first (FTS BM25 ranks it highest)
    expect(bundle.atoms[0].frontmatter.id).toBe(paginationAtom.frontmatter.id);
  });

  it('is deterministic: same query + same store produces identical atom order', () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'rate-limit', body: 'Rate limiting uses sliding window algorithm with Redis.' });
    createAtom({ ...base(testDir), type: 'decision', slug: 'cache', body: 'Cache invalidation uses event-driven approach.' });
    createAtom({ ...base(testDir), type: 'constraint', slug: 'sla', body: 'API SLA target is 99.9% uptime.' });

    reindex(testDir);

    const bundle1 = recall(testDir, { task: 'rate limiting Redis' });
    const bundle2 = recall(testDir, { task: 'rate limiting Redis' });

    expect(bundle1.atoms.map((a) => a.frontmatter.id)).toEqual(
      bundle2.atoms.map((a) => a.frontmatter.id),
    );
  });

  it('without task — ordering falls back to status priority then updated_at', () => {
    // Create atoms with different statuses
    createAtom({ ...base(testDir), type: 'fact', slug: 'active-fact', body: 'Active fact' });
    createAtom({ ...base(testDir), type: 'belief', slug: 'draft-belief', body: 'Draft belief', confidence: 0.5 });

    reindex(testDir);

    const bundle = recall(testDir, {});
    // active atoms should come before draft
    const statuses = bundle.atoms.map((a) => a.frontmatter.status);
    const activeIdx = statuses.indexOf('active');
    const draftIdx = statuses.indexOf('draft');
    if (activeIdx !== -1 && draftIdx !== -1) {
      expect(activeIdx).toBeLessThan(draftIdx);
    }
  });

  it('task with no FTS matches still returns atoms (sorted by status priority)', () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'something', body: 'Something about the system.' });
    reindex(testDir);

    // Task that matches nothing in FTS
    const bundle = recall(testDir, { task: 'xyzzy-nonexistent-topic' });
    // Should still return atoms, just without FTS re-ranking
    expect(bundle.atoms.length).toBeGreaterThanOrEqual(1);
  });

  it('task recall without index falls back to non-ranked results', () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'fallback', body: 'Fallback content for recall without index.' });
    // Intentionally do NOT call reindex — index doesn't exist

    const bundle = recall(testDir, { task: 'fallback content' });
    // Should not throw and should return atoms
    expect(bundle.atoms.length).toBeGreaterThanOrEqual(1);
  });
});
