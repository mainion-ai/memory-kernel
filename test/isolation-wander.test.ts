/**
 * Tests for wander isolation: agent graph + optional shared namespace.
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
  wander,
} from '../src/index.js';

const AGENT = 'test-agent';
const SESSION = 'test-session';
let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-iso-wander-'));
  initIsolatedBase(testDir, 'huston');
  initAgentStore(testDir, 'main');
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

const agentDir = (agent: string) => path.join(testDir, 'agents', agent);
const sharedDir = () => path.join(testDir, 'shared');
const base = (dir: string) => ({ memoryDir: dir, agent_id: AGENT, session_id: SESSION });

describe('wander isolation', () => {
  it('wander scoped to agent graph only (no sharedMemoryDir)', () => {
    const hustonDir = agentDir('huston');
    const mainDir = agentDir('main');
    openIndex(hustonDir);
    openIndex(mainDir);

    const h1 = createAtom({ ...base(hustonDir), type: 'fact', slug: 'huston-infra', body: 'Huston infra fact.', scope: { tags: ['infra'] } });
    createAtom({ ...base(mainDir), type: 'fact', slug: 'main-arch', body: 'Main arch fact.', scope: { tags: ['arch'] } });

    const result = wander({ memoryDir: hustonDir, seedTags: ['infra'], steps: 1 });
    const ids = result.activated.map((a) => a.atom_id);

    // Should only find huston's atom
    expect(ids).toContain(h1.frontmatter.id);
    // Should NOT find main's atom
    expect(ids.some((id) => id.toLowerCase().includes('main'))).toBe(false);
  });

  it('shared atoms participate when sharedMemoryDir is set', () => {
    const hustonDir = agentDir('huston');
    const shared = sharedDir();
    openIndex(hustonDir);
    openIndex(shared);

    const h1 = createAtom({ ...base(hustonDir), type: 'fact', slug: 'agent-infra', body: 'Agent infra.', scope: { tags: ['infra'] } });
    const s1 = createAtom({ ...base(shared), type: 'fact', slug: 'shared-infra', body: 'Shared infra.', scope: { tags: ['infra'] } });

    const result = wander({
      memoryDir: hustonDir,
      sharedMemoryDir: shared,
      seedTags: ['infra'],
      steps: 1,
    });

    const ids = result.activated.map((a) => a.atom_id);
    expect(ids).toContain(h1.frontmatter.id);
    expect(ids).toContain(s1.frontmatter.id);
  });

  it('other agent atoms never visible in wander', () => {
    const hustonDir = agentDir('huston');
    const mainDir = agentDir('main');
    const shared = sharedDir();
    openIndex(hustonDir);
    openIndex(mainDir);
    openIndex(shared);

    createAtom({ ...base(hustonDir), type: 'fact', slug: 'huston-fact', body: 'Huston.', scope: { tags: ['ops'] } });
    const mainAtom = createAtom({ ...base(mainDir), type: 'fact', slug: 'main-fact', body: 'Main.', scope: { tags: ['ops'] } });
    createAtom({ ...base(shared), type: 'fact', slug: 'shared-fact', body: 'Shared.', scope: { tags: ['ops'] } });

    // Wander huston with shared — should NOT see main's atoms
    const result = wander({
      memoryDir: hustonDir,
      sharedMemoryDir: shared,
      seedTags: ['ops'],
      steps: 1,
    });

    const ids = result.activated.map((a) => a.atom_id);
    expect(ids).not.toContain(mainAtom.frontmatter.id);
  });

  it('handles missing sharedMemoryDir gracefully', () => {
    const hustonDir = agentDir('huston');
    openIndex(hustonDir);

    createAtom({ ...base(hustonDir), type: 'fact', slug: 'lonely', body: 'Lonely agent.', scope: { tags: ['solo'] } });

    // Non-existent shared dir
    const result = wander({
      memoryDir: hustonDir,
      sharedMemoryDir: '/tmp/nonexistent-shared',
      seedTags: ['solo'],
      steps: 1,
    });

    // Should still work with agent's atoms only
    expect(result.activated.length).toBeGreaterThanOrEqual(1);
  });
});
