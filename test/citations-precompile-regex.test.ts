import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  initMemoryDir, createAtom, reindex, closeAllIndexes,
  extractCitations, indexCitations,
} from '../src/index.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-cite-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('citations regex precompile', () => {
  it('indexCitations: same byType counts and topCited as before', () => {
    const bodies = [
      'This atom cites pagination-cursor and pagination-offset.',
      'pagination-cursor approach.',
      'pagination-offset approach.',
      'auth-token-rotation note.',
      'pagination-cursor and auth-token-rotation interplay.',
    ];
    const slugs = ['main', 'pagination-cursor', 'pagination-offset',
      'auth-token-rotation', 'interplay'];
    for (let i = 0; i < 5; i++) {
      createAtom({
        memoryDir: testDir, agent_id: 't', session_id: 't',
        type: 'fact', slug: slugs[i], body: bodies[i],
      });
    }
    reindex(testDir);

    const r = indexCitations(testDir);
    expect({
      byType: r.byType,
      uniqueTargets: r.uniqueTargets,
      total: r.total,
      topCitedCount: r.topCited.length,
    }).toMatchSnapshot();
  });

  it('extractCitations: same entries returned (functional equivalence)', () => {
    const ids: string[] = [];
    const bodies = [
      'Discuss pagination-cursor handling.',
      'pagination-cursor and pagination-offset, again pagination-cursor.',
      'auth-token-rotation triggers.',
    ];
    const slugs = ['discuss-cursor', 'pagination-cursor', 'auth-token-rotation'];
    for (let i = 0; i < 3; i++) {
      const a = createAtom({
        memoryDir: testDir, agent_id: 't', session_id: 't',
        type: 'fact', slug: slugs[i], body: bodies[i],
      });
      ids.push(a.frontmatter.id);
    }
    reindex(testDir);
    const c = extractCitations(testDir);
    const sorted = c
      .map(e => ({
        sourceIdx: ids.indexOf(e.sourceId),
        targetIdx: ids.indexOf(e.targetId),
        count: e.count,
        type: e.type,
      }))
      .sort((a, b) => a.sourceIdx - b.sourceIdx || a.targetIdx - b.targetIdx);
    expect(sorted).toMatchSnapshot();
  });

  it('matches concept names case-insensitively in source bodies', () => {
    // Guards the removal of `body.toLowerCase()`: the `i` flag on the
    // compiled regex must continue to handle case folding on its own.
    const target = createAtom({
      memoryDir: testDir, agent_id: 't', session_id: 't',
      type: 'fact', slug: 'pagination-cursor', body: 'Defines the pattern.',
    });
    const source = createAtom({
      memoryDir: testDir, agent_id: 't', session_id: 't',
      type: 'fact', slug: 'shouty', body: 'This cites PAGINATION-CURSOR loudly.',
    });
    reindex(testDir);

    const c = extractCitations(testDir);
    const hit = c.find(e => e.sourceId === source.frontmatter.id
                         && e.targetId === target.frontmatter.id);
    expect(hit).toBeDefined();
    expect(hit!.count).toBeGreaterThanOrEqual(1);
    expect(hit!.type).toBe('concept_name');
  });
});
