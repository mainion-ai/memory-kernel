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

import { initMemoryDir, createAtom, recall, reindex } from '../../src/index.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-recall-parity-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('recall parity: index vs file scan', () => {
  it('returns the same atoms (set equality) after building index', () => {
    const base = { memoryDir: testDir, agent_id: 'a', session_id: 's' };
    createAtom({ ...base, type: 'fact', slug: 'alpha', body: 'Alpha' } as any);
    createAtom({ ...base, type: 'fact', slug: 'beta', body: 'Beta' } as any);
    createAtom({ ...base, type: 'decision', slug: 'dec', body: 'Decision' } as any);

    // 1) No index yet → file scan
    const scan = recall(testDir, { types: ['fact'] } as any);
    const scanIds = (scan.atoms ?? []).map((a) => a.frontmatter.id).sort();

    // 2) Build index → indexed recall
    reindex(testDir);
    const idx = recall(testDir, { types: ['fact'] } as any);
    const idxIds = (idx.atoms ?? []).map((a) => a.frontmatter.id).sort();

    expect(idxIds).toEqual(scanIds);
    expect(idxIds.length).toBe(2);
  });

  it('classification exclusions are consistent between scan and index', () => {
    const base = { memoryDir: testDir, agent_id: 'a', session_id: 's' };

    createAtom({ ...base, type: 'preference', slug: 'team', body: 'Team-visible', classification: 'TEAM' } as any);
    createAtom({
      ...base,
      type: 'preference',
      slug: 'personal',
      body: 'Personal-only',
      classification: 'PERSONAL',
    } as any);

    const scan = recall(testDir, { types: ['preference'] } as any);
    const scanBodies = (scan.atoms ?? []).map((a) => a.body).join('\n');
    expect(scanBodies).toContain('Team-visible');
    expect(scanBodies).not.toContain('Personal-only');

    reindex(testDir);
    const idx = recall(testDir, { types: ['preference'] } as any);
    const idxBodies = (idx.atoms ?? []).map((a) => a.body).join('\n');
    expect(idxBodies).toContain('Team-visible');
    expect(idxBodies).not.toContain('Personal-only');
  });
});
