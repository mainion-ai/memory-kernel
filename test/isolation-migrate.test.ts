/**
 * Tests for migration from shared mode to per-agent isolation.
 * Covers all three strategies: fresh, partition, clone-to-shared.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  initMemoryDir,
  createAtom,
  closeAllIndexes,
  openIndex,
  listAtoms,
  isIsolated,
  loadConfig,
  listAgents,
  migrate,
  writeAtom,
} from '../src/index.js';

const AGENT = 'test-agent';
const SESSION = 'test-session';
let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-migrate-'));
  initMemoryDir(testDir);
  openIndex(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('migrate — fresh strategy', () => {
  it('writes config and creates shared dir, no data movement', () => {
    const result = migrate({
      baseDir: testDir,
      strategy: 'fresh',

    });

    expect(result.strategy).toBe('fresh');
    expect(result.config_written).toBe(true);
    expect(result.agents_created).toEqual([]);
    expect(result.atoms_moved).toBe(0);
    expect(result.atoms_shared).toBe(0);
    expect(isIsolated(testDir)).toBe(true);
    expect(fs.existsSync(path.join(testDir, 'shared', 'ENTITIES'))).toBe(true);
  });

  it('fails if already in isolated mode', () => {
    migrate({ baseDir: testDir, strategy: 'fresh' });
    expect(() =>
      migrate({ baseDir: testDir, strategy: 'fresh' }),
    ).toThrow(/already in isolated/);
  });
});

describe('migrate — partition strategy', () => {
  it('routes atoms by creating agent_id from event log', () => {
    // Create atoms as different agents
    createAtom({
      memoryDir: testDir,
      agent_id: 'alice',
      session_id: SESSION,
      type: 'fact',
      slug: 'alice-fact',
      body: 'Alice knows things.',
    });
    createAtom({
      memoryDir: testDir,
      agent_id: 'bob',
      session_id: SESSION,
      type: 'fact',
      slug: 'bob-fact',
      body: 'Bob knows things.',
    });

    closeAllIndexes();
    const result = migrate({
      baseDir: testDir,
      strategy: 'partition',

    });

    expect(result.strategy).toBe('partition');
    expect(result.agents_created.sort()).toEqual(['alice', 'bob']);
    expect(result.atoms_moved).toBe(2);
    expect(result.config_written).toBe(true);
    expect(isIsolated(testDir)).toBe(true);

    // Verify atoms landed in correct agent dirs
    closeAllIndexes();
    const aliceDir = path.join(testDir, 'agents', 'alice');
    const bobDir = path.join(testDir, 'agents', 'bob');
    openIndex(aliceDir);
    openIndex(bobDir);

    const aliceAtoms = listAtoms(aliceDir);
    const bobAtoms = listAtoms(bobDir);
    expect(aliceAtoms.length).toBe(1);
    expect(bobAtoms.length).toBe(1);
    expect(aliceAtoms[0]!.body).toContain('Alice');
    expect(bobAtoms[0]!.body).toContain('Bob');
  });

  it('assigns untagged atoms to specified agent', () => {
    // Create an atom — its agent_id will be in events
    createAtom({
      memoryDir: testDir,
      agent_id: 'worker',
      session_id: SESSION,
      type: 'fact',
      slug: 'worker-fact',
      body: 'Worker fact.',
    });

    closeAllIndexes();
    const result = migrate({
      baseDir: testDir,
      strategy: 'partition',
      assignUntagged: 'default-agent',

    });

    expect(result.agents_created).toContain('worker');
    expect(result.atoms_moved).toBeGreaterThan(0);
  });
});

describe('migrate — clone-to-shared strategy', () => {
  it('copies all atoms to shared namespace', () => {
    createAtom({
      memoryDir: testDir,
      agent_id: AGENT,
      session_id: SESSION,
      type: 'fact',
      slug: 'shared-fact-1',
      body: 'First shared fact.',
    });
    createAtom({
      memoryDir: testDir,
      agent_id: AGENT,
      session_id: SESSION,
      type: 'decision',
      slug: 'shared-decision',
      body: 'A decision.',
    });

    closeAllIndexes();
    const result = migrate({
      baseDir: testDir,
      strategy: 'clone-to-shared',

    });

    expect(result.strategy).toBe('clone-to-shared');
    expect(result.atoms_shared).toBe(2);
    expect(result.agents_created).toEqual([]);
    expect(result.config_written).toBe(true);
    expect(isIsolated(testDir)).toBe(true);

    // Verify atoms exist in shared
    closeAllIndexes();
    const sharedDir = path.join(testDir, 'shared');
    openIndex(sharedDir);
    const sharedAtoms = listAtoms(sharedDir);
    expect(sharedAtoms.length).toBe(2);
  });

  it('handles empty store gracefully', () => {
    closeAllIndexes();
    const result = migrate({
      baseDir: testDir,
      strategy: 'clone-to-shared',

    });

    expect(result.atoms_shared).toBe(0);
    expect(result.config_written).toBe(true);
  });
});

describe('migrate — partition removes originals', () => {
  it('deletes original atom files from baseDir after copying to agent dirs', () => {
    createAtom({
      memoryDir: testDir,
      agent_id: 'alice',
      session_id: SESSION,
      type: 'fact',
      slug: 'alice-fact',
      body: 'Alice fact for cleanup test.',
    });

    // Verify atom exists in baseDir before migration
    const before = listAtoms(testDir);
    expect(before.length).toBe(1);

    closeAllIndexes();
    migrate({
      baseDir: testDir,
      strategy: 'partition',

    });

    // Original atom file should be gone from baseDir/ENTITIES/
    const remaining = fs.readdirSync(path.join(testDir, 'ENTITIES'));
    expect(remaining.length).toBe(0);

    // But the atom should exist in the agent dir
    closeAllIndexes();
    const aliceDir = path.join(testDir, 'agents', 'alice');
    openIndex(aliceDir);
    const aliceAtoms = listAtoms(aliceDir);
    expect(aliceAtoms.length).toBe(1);
    expect(aliceAtoms[0]!.body).toContain('Alice fact for cleanup');
  });
});

describe('migrate — clone-to-shared removes originals', () => {
  it('deletes original atom files from baseDir after copying to shared', () => {
    createAtom({
      memoryDir: testDir,
      agent_id: AGENT,
      session_id: SESSION,
      type: 'fact',
      slug: 'cleanup-fact',
      body: 'Fact for cleanup test.',
    });

    // Verify atom exists in baseDir before migration
    const before = listAtoms(testDir);
    expect(before.length).toBe(1);

    closeAllIndexes();
    migrate({
      baseDir: testDir,
      strategy: 'clone-to-shared',

    });

    // Original atom file should be gone from baseDir/ENTITIES/
    const remaining = fs.readdirSync(path.join(testDir, 'ENTITIES'));
    expect(remaining.length).toBe(0);

    // But the atom should exist in shared
    closeAllIndexes();
    const sharedDir = path.join(testDir, 'shared');
    openIndex(sharedDir);
    const sharedAtoms = listAtoms(sharedDir);
    expect(sharedAtoms.length).toBe(1);
    expect(sharedAtoms[0]!.body).toContain('Fact for cleanup');
  });
});

describe('migrate — partition validates agent_id format', () => {
  it('falls back to assignUntagged for agent_ids with path separators', () => {
    // We need to create an atom and then manually write an event with a bad agent_id
    // to simulate a corrupted event log
    createAtom({
      memoryDir: testDir,
      agent_id: 'agent/subdir',
      session_id: SESSION,
      type: 'fact',
      slug: 'bad-agent-fact',
      body: 'Fact from agent with bad ID.',
    });

    closeAllIndexes();
    const result = migrate({
      baseDir: testDir,
      strategy: 'partition',
      assignUntagged: 'fallback',

    });

    // Should fall back to 'fallback' instead of creating nested dir
    expect(result.agents_created).toContain('fallback');
    expect(result.agents_created).not.toContain('agent/subdir');

    // Verify no nested directory was created
    expect(fs.existsSync(path.join(testDir, 'agents', 'agent', 'subdir'))).toBe(false);
    expect(fs.existsSync(path.join(testDir, 'agents', 'fallback'))).toBe(true);
  });
});

describe('migrate — partition with untagged atoms (no event log entry)', () => {
  it('assigns atoms with no event log entry to assignUntagged agent', () => {
    // Manually write an atom file without going through createAtom
    // (no corresponding event in the event log)
    const orphanPath = path.join(testDir, 'ENTITIES', 'FACT-2025-01-01-orphan.md');
    writeAtom(
      {
        frontmatter: {
          id: 'FACT-2025-01-01-orphan',
          type: 'fact',
          status: 'active',
          slug: 'orphan',
          confidence: 0.8,
          tags: [],
          created_at: '2025-01-01',
          updated_at: '2025-01-01',
        } as any,
        body: 'Orphan atom with no event log entry.',
        filePath: orphanPath,
      },
      orphanPath,
    );

    closeAllIndexes();
    const result = migrate({
      baseDir: testDir,
      strategy: 'partition',
      assignUntagged: 'orphan-catcher',
    });

    // The orphan atom should land in the assignUntagged agent's store
    expect(result.agents_created).toContain('orphan-catcher');
    expect(result.atoms_moved).toBe(1);

    closeAllIndexes();
    const orphanAgentDir = path.join(testDir, 'agents', 'orphan-catcher');
    openIndex(orphanAgentDir);
    const atoms = listAtoms(orphanAgentDir);
    expect(atoms.length).toBe(1);
    expect(atoms[0]!.body).toContain('Orphan atom');
  });
});

describe('migrate — idempotency guard', () => {
  it('refuses to migrate an already-isolated store', () => {
    migrate({ baseDir: testDir, strategy: 'fresh' });

    expect(() =>
      migrate({ baseDir: testDir, strategy: 'partition' }),
    ).toThrow(/already in isolated/);
  });
});
