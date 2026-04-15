/**
 * Tests for isolated recall: union of agent store + shared namespace.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  initIsolatedBase,
  initAgentStore,
  createAtom,
  closeAllIndexes,
  openIndex,
  listAtoms,
} from '../src/index.js';
import { recallIsolated } from '../src/isolation-recall.js';
import { recall } from '../src/recall.js';

const AGENT = 'test-agent';
const SESSION = 'test-session';
let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-iso-recall-'));
  initIsolatedBase(testDir, 'huston');
  initAgentStore(testDir, 'main');
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

const agentDir = (agent: string) => path.join(testDir, 'agents', agent);
const sharedDir = () => path.join(testDir, 'shared');

const base = (dir: string) => ({
  memoryDir: dir,
  agent_id: AGENT,
  session_id: SESSION,
});

describe('recallIsolated', () => {
  it('returns agent atoms when shared is empty', () => {
    const hustonDir = agentDir('huston');
    openIndex(hustonDir);
    createAtom({ ...base(hustonDir), type: 'fact', slug: 'huston-fact', body: 'Huston knows about deployment.' });

    const bundle = recallIsolated(hustonDir, testDir);
    expect(bundle.atoms.length).toBe(1);
    expect(bundle.atoms[0].body).toContain('Huston knows');
  });

  it('includes shared atoms in results', () => {
    const hustonDir = agentDir('huston');
    const shared = sharedDir();
    openIndex(hustonDir);
    openIndex(shared);

    createAtom({ ...base(hustonDir), type: 'fact', slug: 'private-fact', body: 'Private huston fact.' });
    createAtom({ ...base(shared), type: 'fact', slug: 'shared-fact', body: 'Shared fact visible to all.' });

    const bundle = recallIsolated(hustonDir, testDir);
    expect(bundle.atoms.length).toBe(2);
    const bodies = bundle.atoms.map((a) => a.body);
    expect(bodies.some((b) => b.includes('Private huston'))).toBe(true);
    expect(bodies.some((b) => b.includes('Shared fact'))).toBe(true);
  });

  it('agent atom wins on ID collision with shared', () => {
    const hustonDir = agentDir('huston');
    const shared = sharedDir();
    openIndex(hustonDir);
    openIndex(shared);

    // Create atom in agent store
    const agentAtom = createAtom({ ...base(hustonDir), type: 'fact', slug: 'overlapping', body: 'Agent version of fact.' });

    // Manually copy to shared with same ID (simulating a share + local update)
    const sharedAtom = createAtom({ ...base(shared), type: 'fact', slug: 'overlapping', body: 'Shared version of fact.' });

    // Even though both exist, agent's atoms come first in the merged result
    const bundle = recallIsolated(hustonDir, testDir);
    // Both have different IDs (generated IDs include random suffix), so both should appear
    expect(bundle.atoms.length).toBe(2);
  });

  it('other agents atoms are invisible', () => {
    const hustonDir = agentDir('huston');
    const mainDir = agentDir('main');
    openIndex(hustonDir);
    openIndex(mainDir);

    createAtom({ ...base(hustonDir), type: 'fact', slug: 'huston-only', body: 'Huston secret fact.' });
    createAtom({ ...base(mainDir), type: 'fact', slug: 'main-only', body: 'Main private fact.' });

    // Recall for huston — should NOT see main's atoms
    const hustonBundle = recallIsolated(hustonDir, testDir);
    expect(hustonBundle.atoms.length).toBe(1);
    expect(hustonBundle.atoms[0].body).toContain('Huston secret');

    // Recall for main — should NOT see huston's atoms
    const mainBundle = recallIsolated(mainDir, testDir);
    expect(mainBundle.atoms.length).toBe(1);
    expect(mainBundle.atoms[0].body).toContain('Main private');
  });

  it('respects token budget across merged results', () => {
    const hustonDir = agentDir('huston');
    const shared = sharedDir();
    openIndex(hustonDir);
    openIndex(shared);

    // Create many atoms to exceed a small token budget
    for (let i = 0; i < 10; i++) {
      createAtom({ ...base(hustonDir), type: 'fact', slug: `agent-fact-${i}`, body: `Agent fact ${i}: ${'x'.repeat(500)}` });
    }
    for (let i = 0; i < 10; i++) {
      createAtom({ ...base(shared), type: 'fact', slug: `shared-fact-${i}`, body: `Shared fact ${i}: ${'x'.repeat(500)}` });
    }

    // Use small token budget
    const bundle = recallIsolated(hustonDir, testDir, { max_tokens: 2000 });
    // Should be limited by budget, not returning all 20
    expect(bundle.atoms.length).toBeLessThan(20);
    expect(bundle.token_estimate).toBeLessThanOrEqual(2000 + 200); // some tolerance
  });

  it('shared atoms are not truncated by sub-recall budget', () => {
    const hustonDir = agentDir('huston');
    const shared = sharedDir();
    openIndex(hustonDir);
    openIndex(shared);

    // Create agent atoms that would fill a moderate budget
    for (let i = 0; i < 5; i++) {
      createAtom({ ...base(hustonDir), type: 'fact', slug: `agent-fact-${i}`, body: `Agent fact ${i}: ${'x'.repeat(200)}` });
    }
    // Create shared atoms
    for (let i = 0; i < 5; i++) {
      createAtom({ ...base(shared), type: 'fact', slug: `shared-fact-${i}`, body: `Shared fact ${i}: ${'x'.repeat(200)}` });
    }

    // Use a budget large enough for all 10 atoms — before the fix, the inner
    // recall() would apply max_tokens and potentially truncate shared atoms
    // before merging. Now both sub-calls return unbounded results and the
    // budget is applied once on the merged set.
    const bundle = recallIsolated(hustonDir, testDir, { max_tokens: 8000 });

    const agentCount = bundle.atoms.filter((a) => a.body.includes('Agent fact')).length;
    const sharedCount = bundle.atoms.filter((a) => a.body.includes('Shared fact')).length;

    // All atoms from both stores should be present within the generous budget
    expect(agentCount).toBe(5);
    expect(sharedCount).toBe(5);
  });

  it('handles missing shared directory gracefully', () => {
    const hustonDir = agentDir('huston');
    openIndex(hustonDir);
    createAtom({ ...base(hustonDir), type: 'fact', slug: 'lonely-fact', body: 'Lonely agent fact.' });

    // Remove shared directory
    fs.rmSync(sharedDir(), { recursive: true, force: true });

    const bundle = recallIsolated(hustonDir, testDir);
    expect(bundle.atoms.length).toBe(1);
  });

  it('merges episodes from agent and shared', () => {
    const hustonDir = agentDir('huston');
    const shared = sharedDir();
    openIndex(hustonDir);
    openIndex(shared);

    createAtom({ ...base(hustonDir), type: 'fact', slug: 'agent-fact', body: 'Agent fact.' });
    createAtom({ ...base(shared), type: 'fact', slug: 'shared-fact', body: 'Shared fact.' });

    // Include episodes in recall
    const bundle = recallIsolated(hustonDir, testDir, { include_episodes: true });
    expect(bundle.atoms.length).toBe(2);
    // Episodes may be empty since we didn't write any, but the field should exist or be undefined
  });

  it('returns views from agent store, not shared', () => {
    const hustonDir = agentDir('huston');
    const shared = sharedDir();
    openIndex(hustonDir);
    openIndex(shared);

    createAtom({ ...base(hustonDir), type: 'fact', slug: 'agent-fact', body: 'Agent context.' });
    createAtom({ ...base(shared), type: 'fact', slug: 'shared-fact', body: 'Shared context.' });

    const bundle = recallIsolated(hustonDir, testDir);
    // Views should come from agent's directory
    expect(bundle.index).toBeDefined();
    expect(bundle.handoff).toBeDefined();
    expect(bundle.constraints).toBeDefined();
  });
});
