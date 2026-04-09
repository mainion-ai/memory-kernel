/**
 * Tests for mk closure — operational closure metrics.
 *
 * Tests the closure() function directly and the CLI --json output.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  initMemoryDir,
  createAtom,
  reindex,
  closeAllIndexes,
  addRelation,
} from '../src/index.js';
import { closure } from '../src/closure.js';

const CLI = path.resolve('dist/cli/mk.js');

let testDir: string;

function mk(...args: string[]): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      encoding: 'utf-8',
      timeout: 15000,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return { stdout: err.stdout ?? '', exitCode: err.status ?? 1 };
  }
}

function parseJson(stdout: string): any {
  return JSON.parse(stdout.trim());
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-closure-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('closure()', () => {
  it('returns zero metrics for empty store', () => {
    const result = closure(testDir);
    expect(result.atom_count).toBe(0);
    expect(result.belief_count).toBe(0);
    expect(result.closure_index).toBe(0);
    expect(result.phase).toBe('early');
    expect(result.predictions).toHaveLength(3);
  });

  it('counts beliefs and computes belief_pct', () => {
    createAtom({ memoryDir: testDir, type: 'belief', slug: 'test-belief-1', body: 'A belief', agent_id: 'test', session_id: 'test' });
    createAtom({ memoryDir: testDir, type: 'belief', slug: 'test-belief-2', body: 'Another belief', agent_id: 'test', session_id: 'test' });
    createAtom({ memoryDir: testDir, type: 'fact', slug: 'test-fact-1', body: 'A fact', agent_id: 'test', session_id: 'test' });

    const result = closure(testDir);
    expect(result.atom_count).toBe(3);
    expect(result.belief_count).toBe(2);
    expect(result.belief_pct).toBeCloseTo(66.67, 1);
    expect(result.by_type).toHaveProperty('belief', 2);
    expect(result.by_type).toHaveProperty('fact', 1);
  });

  it('computes avg_relations from index', () => {
    // Build the index first so createAtom can index each atom
    reindex(testDir);
    const a1 = createAtom({ memoryDir: testDir, type: 'belief', slug: 'b1', body: 'Belief one', agent_id: 'test', session_id: 'test' });
    const a2 = createAtom({ memoryDir: testDir, type: 'belief', slug: 'b2', body: 'Belief two', agent_id: 'test', session_id: 'test' });
    const a3 = createAtom({ memoryDir: testDir, type: 'fact', slug: 'f1', body: 'Fact one', agent_id: 'test', session_id: 'test' });

    addRelation(testDir, a1.frontmatter.id, a2.frontmatter.id, 'extends');
    addRelation(testDir, a2.frontmatter.id, a3.frontmatter.id, 'related');

    const result = closure(testDir);
    expect(result.avg_relations).toBeCloseTo(0.67, 1);
    expect(result.relation_types).toHaveProperty('extends', 1);
    expect(result.relation_types).toHaveProperty('related', 1);
  });

  it('detects early phase for small stores', () => {
    for (let i = 0; i < 5; i++) {
      createAtom({ memoryDir: testDir, type: 'belief', slug: `b${i}`, body: `Belief ${i}`, agent_id: 'test', session_id: 'test' });
    }
    const result = closure(testDir);
    expect(result.phase).toBe('early');
  });

  it('detects type-composition phase when belief_pct < 60', () => {
    // Create 12 facts and 10 beliefs = 22 atoms, belief_pct ~45%
    for (let i = 0; i < 12; i++) {
      createAtom({ memoryDir: testDir, type: 'fact', slug: `f${i}`, body: `Fact ${i}`, agent_id: 'test', session_id: 'test' });
    }
    for (let i = 0; i < 10; i++) {
      createAtom({ memoryDir: testDir, type: 'belief', slug: `b${i}`, body: `Belief ${i}`, agent_id: 'test', session_id: 'test' });
    }
    const result = closure(testDir);
    expect(result.phase).toBe('type-composition');
  });

  it('detects entanglement phase when belief_pct >= 60 and atoms >= 20', () => {
    // Create 5 facts and 16 beliefs = 21 atoms, belief_pct ~76%
    for (let i = 0; i < 5; i++) {
      createAtom({ memoryDir: testDir, type: 'fact', slug: `f${i}`, body: `Fact ${i}`, agent_id: 'test', session_id: 'test' });
    }
    for (let i = 0; i < 16; i++) {
      createAtom({ memoryDir: testDir, type: 'belief', slug: `b${i}`, body: `Belief ${i}`, agent_id: 'test', session_id: 'test' });
    }
    const result = closure(testDir);
    expect(result.phase).toBe('entanglement');
  });

  it('counts body-text cross-references in beliefs', () => {
    const a1 = createAtom({ memoryDir: testDir, type: 'belief', slug: 'ref-source', body: 'Initial belief', agent_id: 'test', session_id: 'test' });
    const a2 = createAtom({ memoryDir: testDir, type: 'belief', slug: 'ref-target', body: 'Another belief', agent_id: 'test', session_id: 'test' });
    const a3 = createAtom({ memoryDir: testDir, type: 'fact', slug: 'ref-fact', body: 'A fact', agent_id: 'test', session_id: 'test' });

    // Write body text with cross-references into a1's file
    const a1Path = path.join(testDir, 'ENTITIES', `${a1.frontmatter.id}.md`);
    const a1Content = fs.readFileSync(a1Path, 'utf8');
    const updated = a1Content + `\n\nThis references ${a2.frontmatter.id} and ${a3.frontmatter.id} in the body.`;
    fs.writeFileSync(a1Path, updated, 'utf8');

    const result = closure(testDir);
    // a1 is a belief with 2 cross-refs, a2 is a belief with 0 cross-refs
    // avg_body_refs = (2 + 0) / 2 = 1.0
    expect(result.avg_body_refs).toBe(1);
    expect(result.entanglement_pct).toBeGreaterThan(0);
    expect(result.closure_index).toBeGreaterThan(0);
  });

  it('excludes self-references from body ref count', () => {
    const a1 = createAtom({ memoryDir: testDir, type: 'belief', slug: 'self-ref', body: 'A belief', agent_id: 'test', session_id: 'test' });

    // Write body text that references itself
    const a1Path = path.join(testDir, 'ENTITIES', `${a1.frontmatter.id}.md`);
    const a1Content = fs.readFileSync(a1Path, 'utf8');
    fs.writeFileSync(a1Path, a1Content + `\n\nSelf-ref: ${a1.frontmatter.id}`, 'utf8');

    const result = closure(testDir);
    expect(result.avg_body_refs).toBe(0);
  });

  it('generates predictions at different closure levels', () => {
    // Low closure — all reliable
    const low = closure(testDir);
    expect(low.predictions.some(p => p.tool === 'Graph-structural metrics' && p.status === 'reliable')).toBe(true);
  });
});

describe('CLI mk closure --json', () => {
  it('returns valid JSON with expected keys', () => {
    createAtom({ memoryDir: testDir, type: 'belief', slug: 'cli-test', body: 'Test belief', agent_id: 'test', session_id: 'test' });
    const { stdout, exitCode } = mk('closure', '-d', testDir, '--json');
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json).toHaveProperty('atom_count', 1);
    expect(json).toHaveProperty('belief_count', 1);
    expect(json).toHaveProperty('belief_pct', 100);
    expect(json).toHaveProperty('closure_index');
    expect(json).toHaveProperty('entanglement_pct');
    expect(json).toHaveProperty('phase');
    expect(json).toHaveProperty('by_type');
    expect(json).toHaveProperty('relation_types');
    expect(json).toHaveProperty('predictions');
    expect(json).toHaveProperty('trajectory');
  });

  it('includes trajectory when --trajectory is passed', () => {
    createAtom({ memoryDir: testDir, type: 'belief', slug: 'traj-test', body: 'Test', agent_id: 'test', session_id: 'test' });
    const { stdout, exitCode } = mk('closure', '-d', testDir, '--json', '--trajectory');
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json.trajectory.length).toBeGreaterThan(0);
    expect(json.trajectory[0]).toHaveProperty('date');
    expect(json.trajectory[0]).toHaveProperty('closure_index');
  });

  it('returns error JSON for missing directory', () => {
    const { stdout, exitCode } = mk('closure', '-d', '/tmp/nonexistent-mk-closure-test', '--json');
    expect(exitCode).toBe(1);
    const json = parseJson(stdout);
    expect(json).toHaveProperty('error');
  });

  it('human-readable output works without --json', () => {
    createAtom({ memoryDir: testDir, type: 'belief', slug: 'human-test', body: 'Test', agent_id: 'test', session_id: 'test' });
    const { stdout, exitCode } = mk('closure', '-d', testDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Closure Metrics:');
    expect(stdout).toContain('Predictions:');
  });
});
