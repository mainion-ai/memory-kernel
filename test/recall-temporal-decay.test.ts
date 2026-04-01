/**
 * Temporal decay scoring tests.
 *
 * Phase 1 of scoring improvements: atoms get a recency boost that decays
 * exponentially over time, controlled by a half-life parameter.
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
  closeAllIndexes,
} from '../src/index.js';
import { readAtom, writeAtom } from '../src/store.js';
import { temporalDecay } from '../src/recall.js';
import type { Atom } from '../src/types.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-decay-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

/** Backdate an atom's created_at by rewriting its file on disk. */
function backdateAtom(atom: Atom, daysAgo: number): void {
  const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  const filePath = atom.filePath!;
  const current = readAtom(filePath);
  current.frontmatter.created_at = date.toISOString();
  writeAtom(current, filePath);
}

describe('temporalDecay function', () => {
  it('returns 1.0 for an atom created now', () => {
    const now = new Date().toISOString();
    expect(temporalDecay(now, 30)).toBeCloseTo(1.0, 2);
  });

  it('returns ~0.5 at exactly the half-life', () => {
    const halfLifeDays = 30;
    const date = new Date(Date.now() - halfLifeDays * 24 * 60 * 60 * 1000);
    expect(temporalDecay(date.toISOString(), halfLifeDays)).toBeCloseTo(0.5, 2);
  });

  it('returns ~0.25 at twice the half-life', () => {
    const date = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    expect(temporalDecay(date.toISOString(), 30)).toBeCloseTo(0.25, 2);
  });

  it('clamps future-dated atoms to decay=1.0', () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    expect(temporalDecay(future.toISOString(), 30)).toBe(1.0);
  });

  it('aggressive half-life (1 day) creates steep decay', () => {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const decay = temporalDecay(sevenDaysAgo.toISOString(), 1);
    // 2^(-7) = 0.0078125
    expect(decay).toBeCloseTo(0.0078, 2);
  });

  it('flat half-life (365 days) makes decay near-uniform', () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const decay = temporalDecay(thirtyDaysAgo.toISOString(), 365);
    // Should be close to 1.0 (~0.944)
    expect(decay).toBeGreaterThan(0.9);
  });
});

describe('recall with temporal decay (task-aware)', () => {
  it('recent atom scores higher than old atom with same relevance', () => {
    const base = { memoryDir: testDir, agent_id: 'a', session_id: 's' };

    // Create two atoms with the same body (same FTS relevance)
    const recent = createAtom({ ...base, type: 'fact', slug: 'alpha', body: 'The quick brown fox jumps' });
    const old = createAtom({ ...base, type: 'fact', slug: 'beta', body: 'The quick brown fox jumps' });

    // Backdate the old atom to 60 days ago
    backdateAtom(old, 60);

    // Build index for FTS
    reindex(testDir);

    const bundle = recall(testDir, {
      task: 'quick brown fox',
      decay_weight: 0.2,
      decay_half_life: 30,
    });

    expect(bundle.atoms.length).toBe(2);
    // Recent atom should be first (higher score due to decay boost)
    expect(bundle.atoms[0].frontmatter.id).toBe(recent.frontmatter.id);
    expect(bundle.atoms[1].frontmatter.id).toBe(old.frontmatter.id);
  });

  it('decay_weight=0 preserves relevance-only ordering', () => {
    const base = { memoryDir: testDir, agent_id: 'a', session_id: 's' };

    // Create atoms with different relevance
    const highRelevance = createAtom({ ...base, type: 'fact', slug: 'direct', body: 'Database connection pooling strategies' });
    const lowRelevance = createAtom({ ...base, type: 'fact', slug: 'tangent', body: 'Something about weather patterns' });

    // Backdate the high-relevance atom so it would be penalized by decay
    backdateAtom(highRelevance, 90);

    reindex(testDir);

    const bundle = recall(testDir, {
      task: 'database connection pooling',
      decay_weight: 0, // No decay influence
    });

    expect(bundle.atoms.length).toBe(2);
    // High-relevance atom should still be first despite being old
    expect(bundle.atoms[0].frontmatter.id).toBe(highRelevance.frontmatter.id);
  });

  it('aggressive half-life strongly penalizes old atoms', () => {
    const base = { memoryDir: testDir, agent_id: 'a', session_id: 's' };

    const recent = createAtom({ ...base, type: 'fact', slug: 'new', body: 'API rate limiting approach' });
    const old = createAtom({ ...base, type: 'fact', slug: 'old', body: 'API rate limiting approach' });

    // 7 days ago with 1-day half-life → decay ~0.008
    backdateAtom(old, 7);

    reindex(testDir);

    const bundle = recall(testDir, {
      task: 'API rate limiting',
      decay_half_life: 1,
      decay_weight: 0.5, // Strong recency influence
    });

    expect(bundle.atoms.length).toBe(2);
    expect(bundle.atoms[0].frontmatter.id).toBe(recent.frontmatter.id);
  });

  it('flat half-life makes ordering dominated by relevance', () => {
    const base = { memoryDir: testDir, agent_id: 'a', session_id: 's' };

    const relevant = createAtom({ ...base, type: 'fact', slug: 'relevant', body: 'Memory garbage collection algorithm design' });
    const tangent = createAtom({ ...base, type: 'fact', slug: 'tangent', body: 'Weather forecast accuracy improvements' });

    // Make the relevant one old — but with 365-day half-life, decay is minimal
    backdateAtom(relevant, 60);

    reindex(testDir);

    const bundle = recall(testDir, {
      task: 'garbage collection algorithm',
      decay_half_life: 365,
      decay_weight: 0.2,
    });

    expect(bundle.atoms.length).toBe(2);
    // Relevance should dominate since decay is near-flat
    expect(bundle.atoms[0].frontmatter.id).toBe(relevant.frontmatter.id);
  });
});

describe('recall with temporal decay (no task)', () => {
  it('newer atom sorts before older atom in same status tier', () => {
    const base = { memoryDir: testDir, agent_id: 'a', session_id: 's' };

    const recent = createAtom({ ...base, type: 'fact', slug: 'recent', body: 'Recent fact' });
    const old = createAtom({ ...base, type: 'fact', slug: 'old', body: 'Old fact' });

    // Backdate old atom
    backdateAtom(old, 60);

    const bundle = recall(testDir, {
      decay_half_life: 30,
    });

    // Both are active (same status priority), recent should come first
    const ids = bundle.atoms.map((a) => a.frontmatter.id);
    const recentIdx = ids.indexOf(recent.frontmatter.id);
    const oldIdx = ids.indexOf(old.frontmatter.id);

    expect(recentIdx).toBeLessThan(oldIdx);
  });

  it('status priority still takes precedence over recency', () => {
    const base = { memoryDir: testDir, agent_id: 'a', session_id: 's' };

    // Draft atom created today
    const draft = createAtom({ ...base, type: 'belief', slug: 'new-draft', body: 'Draft belief' });
    // Active fact created 60 days ago
    const active = createAtom({ ...base, type: 'fact', slug: 'old-active', body: 'Active fact' });
    backdateAtom(active, 60);

    const bundle = recall(testDir, {});

    const ids = bundle.atoms.map((a) => a.frontmatter.id);
    const activeIdx = ids.indexOf(active.frontmatter.id);
    const draftIdx = ids.indexOf(draft.frontmatter.id);

    // Active status (priority 0) should come before draft (priority 1)
    expect(activeIdx).toBeLessThan(draftIdx);
  });
});
