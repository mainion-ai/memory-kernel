/**
 * Differential recall test: ensure indexed recall and file-scan recall return the same set.
 *
 * Motivation:
 * - Live reports: "index shows atoms exist but mk_recall returns empty"
 * - We want to detect divergence between:
 *   (a) recall() using optional SQLite index
 *   (b) recall() fallback that scans files
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { initMemoryDir, createAtom, recall, reindex, closeAllIndexes } from '../../src/index.js';
import type { RetainOptions, RecallQuery } from '../../src/index.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-recall-parity-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('recall parity: index vs file scan', () => {
  it('returns the same atoms (set equality) after building index', () => {
    const base: RetainOptions = { memoryDir: testDir, agent_id: 'a', session_id: 's' };
    createAtom({ ...base, type: 'fact', slug: 'alpha', body: 'Alpha' });
    createAtom({ ...base, type: 'fact', slug: 'beta', body: 'Beta' });
    createAtom({ ...base, type: 'decision', slug: 'dec', body: 'Decision' });

    const query: RecallQuery = { types: ['fact'] };

    // 1) No index yet → file scan
    const scan = recall(testDir, query);
    const scanIds = (scan.atoms ?? []).map((a) => a.frontmatter.id).sort();

    // 2) Build index → indexed recall
    reindex(testDir);
    const idx = recall(testDir, query);
    const idxIds = (idx.atoms ?? []).map((a) => a.frontmatter.id).sort();

    expect(idxIds).toEqual(scanIds);
    expect(idxIds.length).toBe(2);
  });

  it('classification exclusions are consistent between scan and index', () => {
    const base: RetainOptions = { memoryDir: testDir, agent_id: 'a', session_id: 's' };

    createAtom({ ...base, type: 'preference', slug: 'team', body: 'Team-visible', classification: 'TEAM' });
    createAtom({ ...base, type: 'preference', slug: 'personal', body: 'Personal-only', classification: 'PERSONAL' });

    const query: RecallQuery = { types: ['preference'] };

    const scan = recall(testDir, query);
    const scanBodies = (scan.atoms ?? []).map((a) => a.body).join('\n');
    expect(scanBodies).toContain('Team-visible');
    expect(scanBodies).not.toContain('Personal-only');

    reindex(testDir);
    const idx = recall(testDir, query);
    const idxBodies = (idx.atoms ?? []).map((a) => a.body).join('\n');
    expect(idxBodies).toContain('Team-visible');
    expect(idxBodies).not.toContain('Personal-only');
  });

  it('explicit status filter retrieves superseded atoms in both scan and index paths', () => {
    const base: RetainOptions = { memoryDir: testDir, agent_id: 'a', session_id: 's' };

    createAtom({ ...base, type: 'fact', slug: 'live', body: 'Live atom', status: 'active' });
    createAtom({ ...base, type: 'fact', slug: 'old', body: 'Old atom', status: 'superseded' });

    // Default query — superseded excluded in both paths
    const defaultQuery: RecallQuery = { types: ['fact'] };

    const scanDefault = recall(testDir, defaultQuery);
    const scanDefaultIds = (scanDefault.atoms ?? []).map((a) => a.frontmatter.id).sort();
    expect(scanDefaultIds.length).toBe(1);
    expect((scanDefault.atoms ?? [])[0].body).toContain('Live');

    reindex(testDir);
    const idxDefault = recall(testDir, defaultQuery);
    const idxDefaultIds = (idxDefault.atoms ?? []).map((a) => a.frontmatter.id).sort();
    expect(idxDefaultIds).toEqual(scanDefaultIds);

    // Explicit status filter — superseded returned by both paths
    const explicitQuery: RecallQuery = { types: ['fact'], statuses: ['superseded'] };

    const idxExplicit = recall(testDir, explicitQuery);
    const idxExplicitIds = (idxExplicit.atoms ?? []).map((a) => a.frontmatter.id).sort();
    expect(idxExplicitIds.length).toBe(1);
    expect((idxExplicit.atoms ?? [])[0].body).toContain('Old');

    // Drop index to force file-scan path
    closeAllIndexes();
    fs.rmSync(path.join(testDir, '.memory-index.db'), { force: true });

    const scanExplicit = recall(testDir, explicitQuery);
    const scanExplicitIds = (scanExplicit.atoms ?? []).map((a) => a.frontmatter.id).sort();
    expect(scanExplicitIds).toEqual(idxExplicitIds);
  });
});
