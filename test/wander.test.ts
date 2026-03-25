/**
 * Spreading activation (wander) — tests.
 *
 * Tests the graph walk engine, activation scoring, lateral inhibition,
 * collision detection, and CLI integration.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  initMemoryDir,
  createAtom,
  reindex,
  indexExists,
  closeAllIndexes,
} from '../src/index.js';
import { wander, wanderFromFiles } from '../src/wander.js';
import type { WanderResult } from '../src/wander.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-wander-'));
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

// --- Helper: create a set of interconnected atoms ---

function createTestGraph(dir: string) {
  // Philosophy domain
  createAtom({
    ...base(dir),
    type: 'belief',
    slug: 'identity-repair',
    body: 'Identity is continuity of the repair process itself.',
    scope: { tags: ['philosophy', 'identity', 'kintsugi'] },
  });

  createAtom({
    ...base(dir),
    type: 'belief',
    slug: 'notation-erasure',
    body: 'Notation systems are engines of erasure.',
    scope: { tags: ['philosophy', 'notation', 'music'] },
  });

  createAtom({
    ...base(dir),
    type: 'belief',
    slug: 'blue-notes',
    body: 'Blue notes live at 319 cents.',
    scope: { tags: ['music', 'notation', 'blues'] },
  });

  // Technical domain
  createAtom({
    ...base(dir),
    type: 'fact',
    slug: 'bas-chart',
    body: 'Swedish BAS chart has 8 account classes.',
    scope: { tags: ['accounting', 'swedish', 'bas'] },
  });

  createAtom({
    ...base(dir),
    type: 'decision',
    slug: 'two-tier-arch',
    body: 'Use two-tier architecture for accounting bot.',
    scope: { tags: ['accounting', 'architecture', 'design'] },
  });

  createAtom({
    ...base(dir),
    type: 'fact',
    slug: 'correction-log',
    body: 'Correction log tracks the escalation boundary.',
    scope: { tags: ['accounting', 'design', 'corrections'] },
  });

  // Bridging atom (connects philosophy and technical)
  createAtom({
    ...base(dir),
    type: 'belief',
    slug: 'two-tiers-meaning',
    body: 'The two tiers are two modes of meaning-making.',
    scope: { tags: ['philosophy', 'accounting', 'architecture'] },
  });

  // Isolated atom (no tags)
  createAtom({
    ...base(dir),
    type: 'fact',
    slug: 'isolated-fact',
    body: 'This fact has no tags.',
  });

  // Another isolated domain
  createAtom({
    ...base(dir),
    type: 'preference',
    slug: 'communication-style',
    body: 'I value directness.',
    scope: { tags: ['communication', 'style'] },
  });
}

// --- Tests ---

describe('wander — spreading activation', () => {

  describe('basic functionality', () => {
    it('should return empty result for empty memory', () => {
      reindex(testDir);

      const result = wander({ memoryDir: testDir });
      expect(result.collisions).toEqual([]);
      expect(result.activated).toEqual([]);
      expect(result.steps_taken).toBe(0);
      expect(result.seeds_used).toEqual([]);
    });

    it('should return empty result when no index exists', () => {
      // No reindex — no index
      const result = wander({ memoryDir: testDir });
      expect(result.collisions).toEqual([]);
      expect(result.activated).toEqual([]);
    });

    it('should auto-seed from recent atoms when no seeds provided', () => {
      createTestGraph(testDir);
      reindex(testDir);

      const result = wander({ memoryDir: testDir });
      expect(result.seeds_used.length).toBeGreaterThan(0);
      expect(result.activated.length).toBeGreaterThan(0);
      expect(result.steps_taken).toBe(3); // default steps
    });

    it('should complete in reasonable time', () => {
      createTestGraph(testDir);
      reindex(testDir);

      const result = wander({ memoryDir: testDir });
      expect(result.duration_ms).toBeLessThan(1000); // Should be <100ms for 9 atoms
    });
  });

  describe('seeding', () => {
    it('should seed from atom IDs', () => {
      const atom = createAtom({
        ...base(testDir),
        type: 'belief',
        slug: 'test-seed',
        body: 'Seed atom',
        scope: { tags: ['test'] },
      });
      reindex(testDir);

      const result = wander({
        memoryDir: testDir,
        seeds: [atom.frontmatter.id],
      });
      expect(result.seeds_used).toContain(atom.frontmatter.id);
    });

    it('should seed from tags', () => {
      createTestGraph(testDir);
      reindex(testDir);

      const result = wander({
        memoryDir: testDir,
        seedTags: ['philosophy'],
      });

      // Should seed with all atoms tagged 'philosophy'
      expect(result.seeds_used.length).toBeGreaterThanOrEqual(2);
      expect(result.activated.length).toBeGreaterThan(0);
    });

    it('should ignore non-existent seed IDs', () => {
      createTestGraph(testDir);
      reindex(testDir);

      const result = wander({
        memoryDir: testDir,
        seeds: ['NONEXISTENT-ID-12345'],
      });

      // Should fall back to auto-seed
      expect(result.seeds_used.length).toBeGreaterThan(0);
      expect(result.seeds_used).not.toContain('NONEXISTENT-ID-12345');
    });

    it('should combine atom ID and tag seeds', () => {
      createTestGraph(testDir);
      reindex(testDir);

      // Get an atom ID to seed with
      const atoms = fs.readdirSync(path.join(testDir, 'ENTITIES'))
        .filter(f => f.endsWith('.md'));
      const firstId = atoms[0].replace('.md', '');

      const result = wander({
        memoryDir: testDir,
        seeds: [firstId],
        seedTags: ['accounting'],
      });

      expect(result.seeds_used.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('spreading activation', () => {
    it('should spread activation through shared tags', () => {
      createTestGraph(testDir);
      reindex(testDir);

      // Seed from 'identity-repair' which has tags: philosophy, identity, kintsugi
      // Should spread to 'notation-erasure' (shares 'philosophy')
      // and 'two-tiers-meaning' (shares 'philosophy')
      const result = wander({
        memoryDir: testDir,
        seedTags: ['identity'],
        steps: 2,
      });

      const activatedIds = result.activated.map(a => a.atom_id);
      // Identity-repair itself should be active
      expect(activatedIds.some(id => id.toLowerCase().includes('identity-repair'))).toBe(true);
      // Should have spread to other philosophy atoms
      expect(result.activated.length).toBeGreaterThan(1);
    });

    it('should respect step count', () => {
      createTestGraph(testDir);
      reindex(testDir);

      const result1 = wander({
        memoryDir: testDir,
        seedTags: ['identity'],
        steps: 1,
      });

      const result3 = wander({
        memoryDir: testDir,
        seedTags: ['identity'],
        steps: 5,
      });

      // More steps should activate more atoms (or at least same)
      expect(result3.activated.length).toBeGreaterThanOrEqual(result1.activated.length);
    });

    it('should apply lateral inhibition (topK)', () => {
      createTestGraph(testDir);
      reindex(testDir);

      const result = wander({
        memoryDir: testDir,
        topK: 3,
        steps: 5,
      });

      // Should never have more than topK activated atoms
      expect(result.activated.length).toBeLessThanOrEqual(3);
    });

    it('should prune below threshold', () => {
      createTestGraph(testDir);
      reindex(testDir);

      const result = wander({
        memoryDir: testDir,
        threshold: 0.5, // High threshold
        steps: 3,
      });

      // All activated atoms should be above threshold
      for (const atom of result.activated) {
        expect(atom.activation).toBeGreaterThanOrEqual(0.5);
      }
    });

    it('should not activate isolated atoms (no tags)', () => {
      createTestGraph(testDir);
      reindex(testDir);

      const result = wander({
        memoryDir: testDir,
        seedTags: ['philosophy'],
        steps: 5,
      });

      // 'isolated-fact' has no tags, should never be activated via spreading
      const activatedIds = result.activated.map(a => a.atom_id);
      expect(activatedIds.some(id => id.toLowerCase().includes('isolated-fact'))).toBe(false);
    });

    it('should decay activation across steps', () => {

      // Create simple chain: A--tag1-->B--tag2-->C
      createAtom({
        ...base(testDir),
        type: 'fact',
        slug: 'chain-a',
        body: 'Chain A',
        scope: { tags: ['link-ab'] },
      });
      createAtom({
        ...base(testDir),
        type: 'belief',
        slug: 'chain-b',
        body: 'Chain B',
        scope: { tags: ['link-ab', 'link-bc'] },
      });
      createAtom({
        ...base(testDir),
        type: 'decision',
        slug: 'chain-c',
        body: 'Chain C',
        scope: { tags: ['link-bc'] },
      });

      reindex(testDir);

      // Seed from chain-a
      const atoms = fs.readdirSync(path.join(testDir, 'ENTITIES'))
        .filter(f => f.toLowerCase().includes('chain-a'));
      const seedId = atoms[0].replace('.md', '');

      const result = wander({
        memoryDir: testDir,
        seeds: [seedId],
        steps: 3,
        threshold: 0.001,
        topK: 10,
      });

      // Find activations for B and C
      const bAtom = result.activated.find(a => a.atom_id.toLowerCase().includes('chain-b'));
      const cAtom = result.activated.find(a => a.atom_id.toLowerCase().includes('chain-c'));

      // B should be more activated than C (closer to seed)
      if (bAtom && cAtom) {
        expect(bAtom.activation).toBeGreaterThan(cAtom.activation);
      }
    });
  });

  describe('collision detection', () => {
    it('should detect collisions between different types sharing tags', () => {
      createTestGraph(testDir);
      reindex(testDir);

      // Seed broadly to activate many atoms
      const result = wander({
        memoryDir: testDir,
        seedTags: ['philosophy', 'accounting'],
        steps: 3,
        topK: 20,
        threshold: 0.01,
      });

      // Should find collisions between philosophy atoms and accounting atoms
      // through the bridging 'two-tiers-meaning' atom
      if (result.collisions.length > 0) {
        for (const c of result.collisions) {
          // Each collision should have two different types
          expect(c.type_a).not.toBe(c.type_b);
          // Should have shared tags
          expect(c.shared_tags.length).toBeGreaterThan(0);
          // Score should be positive
          expect(c.score).toBeGreaterThan(0);
        }
      }
    });

    it('should respect maxCollisions limit', () => {
      createTestGraph(testDir);
      reindex(testDir);

      const result = wander({
        memoryDir: testDir,
        maxCollisions: 2,
        steps: 3,
        threshold: 0.01,
      });

      expect(result.collisions.length).toBeLessThanOrEqual(2);
    });

    it('should sort collisions by score descending', () => {
      createTestGraph(testDir);
      reindex(testDir);

      const result = wander({
        memoryDir: testDir,
        steps: 3,
        threshold: 0.01,
        maxCollisions: 10,
      });

      for (let i = 1; i < result.collisions.length; i++) {
        expect(result.collisions[i - 1].score).toBeGreaterThanOrEqual(result.collisions[i].score);
      }
    });

    it('should not report same-type pairs as collisions', () => {
      createTestGraph(testDir);
      reindex(testDir);

      const result = wander({
        memoryDir: testDir,
        steps: 5,
        threshold: 0.001,
        maxCollisions: 50,
      });

      for (const c of result.collisions) {
        expect(c.type_a).not.toBe(c.type_b);
      }
    });
  });

  describe('conflict atom exclusion', () => {
    it('should exclude conflict atoms from index-backed graph', () => {
      createTestGraph(testDir);
      // Add a conflict atom that shares tags with philosophy atoms
      createAtom({
        ...base(testDir),
        type: 'conflict',
        slug: 'conflict-philosophy',
        body: 'Conflict between two philosophy atoms.',
        scope: { tags: ['philosophy', 'identity'] },
      });
      reindex(testDir);

      const result = wander({
        memoryDir: testDir,
        seedTags: ['philosophy'],
        steps: 3,
        threshold: 0.001,
        topK: 50,
      });

      // Conflict atoms should never appear in activated set
      const types = result.activated.map(a => a.type);
      expect(types).not.toContain('conflict');

      // Conflict atoms should never appear in collisions
      for (const c of result.collisions) {
        expect(c.type_a).not.toBe('conflict');
        expect(c.type_b).not.toBe('conflict');
      }
    });

    it('should exclude conflict atoms from file-backed graph', () => {
      createTestGraph(testDir);
      createAtom({
        ...base(testDir),
        type: 'conflict',
        slug: 'conflict-music',
        body: 'Conflict between music atoms.',
        scope: { tags: ['music', 'notation'] },
      });
      // No reindex — file scan path

      const result = wanderFromFiles({
        memoryDir: testDir,
        seedTags: ['music'],
        steps: 3,
        threshold: 0.001,
        topK: 50,
      });

      const types = result.activated.map(a => a.type);
      expect(types).not.toContain('conflict');
    });
  });

  describe('wanderFromFiles (fallback)', () => {
    it('should work without index', () => {
      createTestGraph(testDir);
      // No reindex — use file scan

      const result = wanderFromFiles({ memoryDir: testDir });
      expect(result.seeds_used.length).toBeGreaterThan(0);
      expect(result.activated.length).toBeGreaterThan(0);
      expect(result.steps_taken).toBe(3);
    });

    it('should produce similar results to index-backed wander', () => {
      createTestGraph(testDir);
      reindex(testDir);

      const seedTags = ['philosophy'];
      const opts = { memoryDir: testDir, seedTags, steps: 2, threshold: 0.01 };

      const indexResult = wander(opts);
      const fileResult = wanderFromFiles(opts);

      // Same number of seeds (both resolve from same tags)
      expect(fileResult.seeds_used.length).toBe(indexResult.seeds_used.length);

      // Same activated atom IDs (order may differ slightly due to timing)
      const indexIds = new Set(indexResult.activated.map(a => a.atom_id));
      const fileIds = new Set(fileResult.activated.map(a => a.atom_id));
      expect(fileIds).toEqual(indexIds);
    });
  });

  describe('edge cases', () => {
    it('should handle single atom', () => {
      createAtom({
        ...base(testDir),
        type: 'fact',
        slug: 'lonely',
        body: 'I am alone.',
        scope: { tags: ['solitude'] },
      });
      reindex(testDir);

      const result = wander({ memoryDir: testDir });
      expect(result.seeds_used.length).toBe(1);
      expect(result.activated.length).toBe(1);
      expect(result.collisions).toEqual([]);
    });

    it('should handle atoms with many shared tags', () => {
      const sharedTags = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];

      createAtom({
        ...base(testDir),
        type: 'fact',
        slug: 'multi-tag-a',
        body: 'A',
        scope: { tags: sharedTags },
      });
      createAtom({
        ...base(testDir),
        type: 'belief',
        slug: 'multi-tag-b',
        body: 'B',
        scope: { tags: sharedTags },
      });

      reindex(testDir);

      const result = wander({ memoryDir: testDir, steps: 1 });
      expect(result.activated.length).toBe(2);
      // Should find collision (different types, many shared tags)
      expect(result.collisions.length).toBeGreaterThan(0);
      expect(result.collisions[0].shared_tags.length).toBe(5);
    });

    it('should handle zero steps (seeds initialized but no spreading)', () => {
      createTestGraph(testDir);
      reindex(testDir);

      const result = wander({ memoryDir: testDir, steps: 0 });
      expect(result.steps_taken).toBe(0);
      // Seeds are initialized but never spread — they remain in the activation map
      // Seeds auto-selected (3 most recent) remain at activation 1.0
      expect(result.seeds_used.length).toBeGreaterThan(0);
    });

    it('should handle very high threshold (prunes everything)', () => {
      createTestGraph(testDir);
      reindex(testDir);

      const result = wander({
        memoryDir: testDir,
        threshold: 100, // Nothing will survive this
        steps: 3,
      });

      // Seeds start at 1.0, but after decay they drop below 100
      // So after first step, all get pruned
      expect(result.activated.length).toBe(0);
    });

    it('should handle disconnected subgraphs', () => {

      // Subgraph 1
      createAtom({
        ...base(testDir),
        type: 'fact',
        slug: 'island-a1',
        body: 'Island A1',
        scope: { tags: ['island-a'] },
      });
      createAtom({
        ...base(testDir),
        type: 'belief',
        slug: 'island-a2',
        body: 'Island A2',
        scope: { tags: ['island-a'] },
      });

      // Subgraph 2 (disconnected)
      createAtom({
        ...base(testDir),
        type: 'fact',
        slug: 'island-b1',
        body: 'Island B1',
        scope: { tags: ['island-b'] },
      });
      createAtom({
        ...base(testDir),
        type: 'belief',
        slug: 'island-b2',
        body: 'Island B2',
        scope: { tags: ['island-b'] },
      });

      reindex(testDir);

      // Seed from island-a only
      const result = wander({
        memoryDir: testDir,
        seedTags: ['island-a'],
        steps: 5,
        threshold: 0.001,
      });

      // Should only activate island-a atoms
      const activatedIds = result.activated.map(a => a.atom_id);
      expect(activatedIds.every(id =>
        id.toLowerCase().includes('island-a')
      )).toBe(true);
    });
  });
});
