/**
 * Wander — stress tests.
 *
 * Tests performance with large atom sets and dense tag networks.
 * Verifies that spreading activation scales reasonably.
 *
 * Note: test timeouts are generous because atom creation + reindex
 * is the bottleneck on constrained hardware (RPi). The wander duration
 * assertions are what we're actually testing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  initMemoryDir,
  createAtom,
  reindex,
  closeAllIndexes,
} from '../src/index.js';
import { wander } from '../src/wander.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-wander-stress-'));
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

// Tag pools for generating varied atoms
const DOMAINS = ['philosophy', 'accounting', 'music', 'poetry', 'infra', 'memory', 'design', 'psychology'];
const SUBTAGS = ['notation', 'erasure', 'identity', 'repair', 'tier-1', 'tier-2', 'blue-notes', 'kintsugi', 'drift', 'dmn', 'corrections', 'bas', 'swedish', 'fortnox'];
const TYPES = ['fact', 'belief', 'decision', 'preference', 'open_question'] as const;

function createLargeGraph(dir: string, atomCount: number) {
  for (let i = 0; i < atomCount; i++) {
    // Each atom gets 1-3 tags from mixed pools
    const tagCount = 1 + (i % 3);
    const tags: string[] = [];
    tags.push(DOMAINS[i % DOMAINS.length]);
    if (tagCount >= 2) tags.push(SUBTAGS[i % SUBTAGS.length]);
    if (tagCount >= 3) tags.push(DOMAINS[(i + 3) % DOMAINS.length]);

    createAtom({
      ...base(dir),
      type: TYPES[i % TYPES.length],
      slug: `atom-${i}`,
      body: `Test atom ${i} with tags ${tags.join(', ')}`,
      scope: { tags },
    });
  }
}

describe('wander — stress tests', () => {

  it('100 atoms: wander completes in < 500ms', { timeout: 10000 }, () => {
    createLargeGraph(testDir, 100);
    reindex(testDir);

    const result = wander({
      memoryDir: testDir,
      steps: 5,
      topK: 30,
      threshold: 0.01,
    });

    expect(result.duration_ms).toBeLessThan(500);
    expect(result.activated.length).toBeGreaterThan(0);
    expect(result.steps_taken).toBe(5);
    console.log(`100 atoms: ${result.duration_ms}ms, ${result.activated.length} activated, ${result.collisions.length} collisions`);
  });

  it('200 atoms with dense tags: wander completes in < 1s', { timeout: 15000 }, () => {
    createLargeGraph(testDir, 200);
    reindex(testDir);

    const result = wander({
      memoryDir: testDir,
      steps: 5,
      topK: 30,
      threshold: 0.01,
      maxCollisions: 10,
    });

    expect(result.duration_ms).toBeLessThan(1000);
    expect(result.activated.length).toBeGreaterThan(0);
    expect(result.collisions.length).toBeGreaterThan(0);
    console.log(`200 atoms: ${result.duration_ms}ms, ${result.activated.length} activated, ${result.collisions.length} collisions`);
  });

  it('topK limits keep performance bounded regardless of graph size', { timeout: 15000 }, () => {
    createLargeGraph(testDir, 150);
    reindex(testDir);

    // Run with very small topK — should be fast regardless of graph size
    const result = wander({
      memoryDir: testDir,
      steps: 10,
      topK: 5,
      threshold: 0.001,
    });

    // topK constrains the working set
    expect(result.activated.length).toBeLessThanOrEqual(5);
    expect(result.duration_ms).toBeLessThan(500);
    console.log(`150 atoms, topK=5: ${result.duration_ms}ms, ${result.activated.length} activated`);
  });

  it('collision detection scales with activated set, not total atoms', { timeout: 15000 }, () => {
    createLargeGraph(testDir, 150);
    reindex(testDir);

    // With topK=10, collision detection is O(10^2) = 100 pairs, regardless of total atoms
    const result = wander({
      memoryDir: testDir,
      steps: 3,
      topK: 10,
      threshold: 0.01,
      maxCollisions: 20,
    });

    expect(result.duration_ms).toBeLessThan(500);
    // Collisions should be found in a diverse graph
    expect(result.collisions.length).toBeGreaterThan(0);

    // Verify collision quality
    for (const c of result.collisions) {
      expect(c.dissimilarity).toBeGreaterThan(0.7);
      expect(c.score).toBeGreaterThan(0);
    }
    console.log(`150 atoms, topK=10: ${result.collisions.length} collisions found`);
  });

  it('all-same-tag extreme: performance with fully connected graph', { timeout: 15000 }, () => {

    // All 50 atoms share the same tag — fully connected graph
    for (let i = 0; i < 50; i++) {
      createAtom({
        ...base(testDir),
        type: TYPES[i % TYPES.length],
        slug: `dense-${i}`,
        body: `Dense atom ${i}`,
        scope: { tags: ['shared-tag'] },
      });
    }
    reindex(testDir);

    const result = wander({
      memoryDir: testDir,
      steps: 3,
      topK: 15,
      threshold: 0.01,
    });

    // Should still complete even with fully connected graph
    expect(result.duration_ms).toBeLessThan(500);
    expect(result.activated.length).toBeGreaterThan(0);
    console.log(`50 dense atoms: ${result.duration_ms}ms, ${result.activated.length} activated, ${result.collisions.length} collisions`);
  });
});
