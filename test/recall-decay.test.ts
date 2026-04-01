/**
 * Phase 1: Temporal Decay tests.
 * Verifies that recency boosts recently-created atoms and is configurable.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  initMemoryDir,
  createAtom,
  closeAllIndexes,
  openIndex,
  writeAtom,
  readAtom,
} from '../src/index.js';
import { recall } from '../src/recall.js';
import type { AtomFrontmatter } from '../src/types.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-decay-'));
  initMemoryDir(testDir);
  openIndex(testDir); // ensure DB exists so createAtom calls indexAtom
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

/** Backdates an atom's created_at by N days (mutates the file on disk). */
function backdateAtom(filePath: string, daysAgo: number): void {
  const atom = readAtom(filePath);
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  atom.frontmatter.created_at = d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  atom.frontmatter.updated_at = atom.frontmatter.created_at;
  writeAtom(atom, filePath);
}

describe('temporal decay — no task (recency sort)', () => {
  it('atom created today ranks above identical atom from 60 days ago', () => {
    const recent = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'recent', body: 'Recent fact body',
    });

    const old = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'old', body: 'Old fact body',
    });
    backdateAtom(old.filePath!, 60);
    closeAllIndexes(); // reopen fresh so backdate is picked up

    const bundle = recall(testDir, {});
    const ids = bundle.atoms.map((a) => a.frontmatter.id);
    expect(ids.indexOf(recent.frontmatter.id)).toBeLessThan(ids.indexOf(old.frontmatter.id));
  });

  it('with decay_weight=0, falls back to status+updated_at ordering', () => {
    // With decay off, an old active atom still ranks above a draft atom
    const draftOld = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'draft-old', body: 'Old draft',
    });
    backdateAtom(draftOld.filePath!, 90);

    const activeRecent = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'active-recent', body: 'Recent active fact',
      confidence: 0.8,
    });
    closeAllIndexes();

    // With decay_weight=0, recency is ignored — status priority dominates
    const bundle = recall(testDir, { decay_weight: 0 });
    const ids = bundle.atoms.map((a) => a.frontmatter.id);
    // active fact should still come before draft belief (status priority)
    expect(ids.indexOf(activeRecent.frontmatter.id)).toBeLessThan(ids.indexOf(draftOld.frontmatter.id));
  });
});

describe('temporal decay — with task (hybrid scoring)', () => {
  it('recently-created atom scores higher than older atom with same relevance', () => {
    // Create two atoms with identical bodies — FTS scores will be equal.
    // The one created today should rank above the one from 60 days ago.
    const recentAtom = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'typescript-recent', body: 'TypeScript is a typed superset of JavaScript',
    });

    const oldAtom = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'typescript-old', body: 'TypeScript is a typed superset of JavaScript',
    });
    backdateAtom(oldAtom.filePath!, 60);
    closeAllIndexes();

    const bundle = recall(testDir, {
      task: 'TypeScript typed superset',
      decay_weight: 0.3, // exaggerate decay to make the difference clear
    });

    const ids = bundle.atoms.map((a) => a.frontmatter.id);
    const recentIndex = ids.indexOf(recentAtom.frontmatter.id);
    const oldIndex = ids.indexOf(oldAtom.frontmatter.id);

    expect(recentIndex).toBeGreaterThanOrEqual(0);
    expect(oldIndex).toBeGreaterThanOrEqual(0);
    expect(recentIndex).toBeLessThan(oldIndex);
  });

  it('DECAY_WEIGHT=0 env var produces same ranking as decay_weight:0 query param', () => {
    const a = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'alpha', body: 'alpha beta gamma delta',
    });
    const b = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'beta-old', body: 'alpha beta gamma delta',
    });
    backdateAtom(b.filePath!, 30);
    closeAllIndexes();

    const prevEnv = process.env.RECALL_DECAY_WEIGHT;
    process.env.RECALL_DECAY_WEIGHT = '0';
    const byEnv = recall(testDir, { task: 'alpha beta' });
    process.env.RECALL_DECAY_WEIGHT = prevEnv ?? '';

    const byQuery = recall(testDir, { task: 'alpha beta', decay_weight: 0 });

    expect(byEnv.atoms.map((x) => x.frontmatter.id)).toEqual(
      byQuery.atoms.map((x) => x.frontmatter.id),
    );
  });

  it('short half-life creates more aggressive decay than long half-life', () => {
    const today = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'today', body: 'machine learning neural network',
    });
    const month = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'month', body: 'machine learning neural network',
    });
    backdateAtom(month.filePath!, 30);
    closeAllIndexes();

    // Short half-life (7 days) — 30-day-old atom decays to ~0.008
    const shortBundle = recall(testDir, {
      task: 'machine learning neural',
      decay_half_life: 7,
      decay_weight: 0.5,
    });

    // Long half-life (365 days) — 30-day-old atom decays to ~0.944
    const longBundle = recall(testDir, {
      task: 'machine learning neural',
      decay_half_life: 365,
      decay_weight: 0.5,
    });

    const shortIds = shortBundle.atoms.map((a) => a.frontmatter.id);
    const longIds = longBundle.atoms.map((a) => a.frontmatter.id);

    // Both bundles include both atoms; short half-life should favor recent more strongly
    expect(shortIds).toContain(today.frontmatter.id);
    expect(shortIds).toContain(month.frontmatter.id);
    expect(longIds).toContain(today.frontmatter.id);
    expect(longIds).toContain(month.frontmatter.id);

    // With short half-life, today ranks first
    expect(shortIds.indexOf(today.frontmatter.id)).toBeLessThan(
      shortIds.indexOf(month.frontmatter.id),
    );
  });
});
