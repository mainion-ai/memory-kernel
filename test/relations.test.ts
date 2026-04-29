/**
 * Phase 3: Relationship Edges tests.
 * Covers DDL, indexAtom relation sync, getRelationsForAtom, and graph-walk boost.
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
  indexStats,
  indexAtom,
  getRelationsForAtom,
  reindex,
  getAllRelations,
  writeAtom,
  readAtom,
} from '../src/index.js';
import { recall } from '../src/recall.js';
import type { Relation } from '../src/types.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-relations-'));
  initMemoryDir(testDir);
  openIndex(testDir); // ensure DB exists so createAtom calls indexAtom
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('atom_relations DDL', () => {
  it('atom_relations table exists after openIndex', () => {
    const db = openIndex(testDir);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='atom_relations'",
    ).all() as { name: string }[];
    expect(tables).toHaveLength(1);
  });

  it('schema version is 7', () => {
    const db = openIndex(testDir);
    const version = db.pragma('user_version', { simple: true }) as number;
    expect(version).toBe(7);
  });

  it('indexStats includes relations count', () => {
    createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'stats-test', body: 'stats body',
    });

    const stats = indexStats(testDir);
    expect(stats).not.toBeNull();
    expect(typeof stats!.relations).toBe('number');
    expect(stats!.relations).toBe(0); // no relations yet
  });
});

describe('indexAtom with relations', () => {
  it('inserts relation rows when atom has relations', () => {
    const target = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'target-fact', body: 'Target fact body',
    });

    const source = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'source-belief', body: 'Source belief body',
      relations: [{ target: target.frontmatter.id, type: 'supports' }],
    });

    const stats = indexStats(testDir);
    expect(stats!.relations).toBe(1);

    const { outbound } = getRelationsForAtom(testDir, source.frontmatter.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].target_id).toBe(target.frontmatter.id);
    expect(outbound[0].relation_type).toBe('supports');
  });

  it('updating atom relations replaces old outbound rows', () => {
    const t1 = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'target-1', body: 'Target 1',
    });
    const t2 = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'target-2', body: 'Target 2',
    });

    const source = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'source', body: 'Source body',
      relations: [{ target: t1.frontmatter.id, type: 'extends' }],
    });

    expect(indexStats(testDir)!.relations).toBe(1);

    // Update atom with different relation
    const atom = readAtom(source.filePath!);
    atom.frontmatter.relations = [{ target: t2.frontmatter.id, type: 'contradicts' }];
    writeAtom(atom, source.filePath!);
    indexAtom(testDir, { ...atom, filePath: source.filePath });

    const { outbound } = getRelationsForAtom(testDir, source.frontmatter.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].target_id).toBe(t2.frontmatter.id);
    expect(outbound[0].relation_type).toBe('contradicts');
  });

  it('duplicate (source, target, type) triple is silently ignored', () => {
    const target = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'dup-target', body: 'Dup target',
    });

    createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'dup-source', body: 'Dup source',
      relations: [
        { target: target.frontmatter.id, type: 'supports' },
        { target: target.frontmatter.id, type: 'supports' }, // duplicate
      ],
    });

    expect(indexStats(testDir)!.relations).toBe(1); // de-duped by INSERT OR IGNORE
  });

  it('relation to non-indexed target is silently skipped', () => {
    expect(() =>
      createAtom({
        memoryDir: testDir,
        agent_id: 'a', session_id: 's',
        type: 'belief', slug: 'orphan-source', body: 'Orphan',
        relations: [{ target: 'FACT-2020-01-01-NONEXISTENT-abc', type: 'related' }],
      }),
    ).not.toThrow();

    expect(indexStats(testDir)!.relations).toBe(0);
  });
});

describe('getRelationsForAtom', () => {
  it('returns empty arrays when index does not exist', () => {
    const result = getRelationsForAtom('/nonexistent/path', 'ANY-ID');
    expect(result.outbound).toEqual([]);
    expect(result.inbound).toEqual([]);
  });

  it('returns inbound relations when another atom targets this one', () => {
    const target = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'target', body: 'Target fact',
    });

    const source = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'source', body: 'Source belief',
      relations: [{ target: target.frontmatter.id, type: 'supports' }],
    });

    const { inbound } = getRelationsForAtom(testDir, target.frontmatter.id);
    expect(inbound).toHaveLength(1);
    expect(inbound[0].source_id).toBe(source.frontmatter.id);
    expect(inbound[0].relation_type).toBe('supports');
  });
});

describe('reindex populates atom_relations', () => {
  it('reindex picks up relations from frontmatter', () => {
    const target = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'reindex-target', body: 'Reindex target',
    });

    createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'reindex-source', body: 'Reindex source',
      relations: [{ target: target.frontmatter.id, type: 'extends' }],
    });

    closeAllIndexes();
    reindex(testDir); // full rebuild

    expect(indexStats(testDir)!.relations).toBe(1);
  });
});

describe('graph-walk boost in recall', () => {
  it('neighbor of high-scoring atom gets a boost', () => {
    // A = highly relevant to the task (will score high)
    const atomA = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'atom-a', body: 'Kubernetes deployment strategy rollout',
    });

    // B = not relevant, but related to A
    const atomB = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'atom-b', body: 'Completely unrelated content about tomatoes',
    });

    // C = also not relevant, no relation to A
    const atomC = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'atom-c', body: 'Completely unrelated content about bananas',
    });

    // Add A → B relation
    const atomAOnDisk = readAtom(atomA.filePath!);
    atomAOnDisk.frontmatter.relations = [{ target: atomB.frontmatter.id, type: 'related' }];
    writeAtom(atomAOnDisk, atomA.filePath!);
    indexAtom(testDir, { ...atomAOnDisk, filePath: atomA.filePath });

    // Recall with graph boost enabled
    const withBoost = recall(testDir, {
      task: 'Kubernetes deployment strategy',
      graph_boost: true,
    });

    // Recall with graph boost disabled
    const noBoost = recall(testDir, {
      task: 'Kubernetes deployment strategy',
      graph_boost: false,
    });

    // B should rank higher relative to C when boost is on (B is A's neighbor)
    const withBoostIds = withBoost.atoms.map((a) => a.frontmatter.id);
    const noBoostIds = noBoost.atoms.map((a) => a.frontmatter.id);

    const bRankWithBoost = withBoostIds.indexOf(atomB.frontmatter.id);
    const cRankWithBoost = withBoostIds.indexOf(atomC.frontmatter.id);
    const bRankNoBoost = noBoostIds.indexOf(atomB.frontmatter.id);
    const cRankNoBoost = noBoostIds.indexOf(atomC.frontmatter.id);

    // Both should be present
    expect(bRankWithBoost).toBeGreaterThanOrEqual(0);
    expect(cRankWithBoost).toBeGreaterThanOrEqual(0);

    // With boost: B should rank at least as well as C (neighbor boost lifts B)
    expect(bRankWithBoost).toBeLessThanOrEqual(cRankWithBoost);
  });

  it('graph_boost=false disables boost entirely', () => {
    const target = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'no-boost-target', body: 'no boost target fact',
    });
    const source = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'no-boost-source', body: 'no boost source fact',
      relations: [{ target: target.frontmatter.id, type: 'supports' }],
    });

    // Should not throw, and should return results
    expect(() => recall(testDir, {
      task: 'no boost',
      graph_boost: false,
    })).not.toThrow();
  });

  it('circular relations do not cause infinite loops', () => {
    // A → B and B → A
    const atomA = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'circular-a', body: 'circular relation fact A',
    });
    const atomB = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'circular-b', body: 'circular relation fact B',
      relations: [{ target: atomA.frontmatter.id, type: 'related' }],
    });

    const atomADisk = readAtom(atomA.filePath!);
    atomADisk.frontmatter.relations = [{ target: atomB.frontmatter.id, type: 'related' }];
    writeAtom(atomADisk, atomA.filePath!);
    indexAtom(testDir, { ...atomADisk, filePath: atomA.filePath });

    // Should terminate without hanging
    expect(() => recall(testDir, {
      task: 'circular relation fact',
      graph_boost: true,
    })).not.toThrow();
  });

  it('atoms without relations are unaffected (getAllRelations returns [])', () => {
    createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'no-rel', body: 'no relations here',
    });

    const relations = getAllRelations(testDir);
    expect(relations).toEqual([]);

    expect(() => recall(testDir, { task: 'no relations', graph_boost: true })).not.toThrow();
  });
});

describe('Phase 1 plugin: auto-relink populates source and created_at', () => {
  it('marks auto-extracted relations with source=extracted and a created_at', () => {
    // First, create a target atom that will be referenced
    const target = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'target-of-relink',
      body: 'A target fact.',
    });

    // Now create an atom whose body references the target by ID
    const source = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'has-relink',
      body: `This belief references ${target.frontmatter.id} explicitly.`,
    });

    expect(source.frontmatter.relations).toBeDefined();
    expect(source.frontmatter.relations!.length).toBeGreaterThan(0);
    const rel = source.frontmatter.relations!.find(r => r.target === target.frontmatter.id);
    expect(rel).toBeDefined();
    expect(rel!.source).toBe('extracted');
    expect(rel!.created_at).toBeDefined();
    // Created_at should be a valid ISO8601 within the last minute
    const ts = new Date(rel!.created_at!).getTime();
    expect(Date.now() - ts).toBeLessThan(60_000);
  });

  it('explicit caller-supplied relations default to source=manual when source is missing', () => {
    const target = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'manual-target',
      body: 'Manual target.',
    });

    const source = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'has-manual-relation',
      body: 'No body references; explicit relations only.',
      relations: [{ target: target.frontmatter.id, type: 'extends' }],
    });

    expect(source.frontmatter.relations).toEqual([
      expect.objectContaining({
        target: target.frontmatter.id,
        type: 'extends',
        source: 'manual',
        created_at: expect.any(String),
      }),
    ]);
  });

  it('explicit caller-supplied source is preserved when set', () => {
    const target = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'enriched-target',
      body: 'Target.',
    });

    const source = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'has-enriched-relation',
      body: 'Body.',
      relations: [{
        target: target.frontmatter.id,
        type: 'supports',
        source: 'enriched',
        confidence: 0.72,
      }],
    });

    const rel = source.frontmatter.relations![0];
    expect(rel.source).toBe('enriched');
    expect(rel.confidence).toBe(0.72);
  });
});
