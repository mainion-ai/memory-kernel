/**
 * Tests for per-agent render config and renderAgentClaudeMd.
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
  writeRenderConfig,
  renderClaudeMd,
  renderAgentClaudeMd,
} from '../src/index.js';

const AGENT = 'test-agent';
const SESSION = 'test-session';
let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-iso-render-'));
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

describe('renderAgentClaudeMd', () => {
  it('renders agent atoms using render.yaml config', () => {
    const hustonDir = agentDir('huston');
    openIndex(hustonDir);

    createAtom({ ...base(hustonDir), type: 'fact', slug: 'deploy', body: 'Deploy uses k8s.' });
    createAtom({ ...base(hustonDir), type: 'belief', slug: 'scaling', body: 'Auto-scaling is key.', confidence: 0.7 });

    const md = renderAgentClaudeMd(testDir, 'huston');
    expect(md).toContain('Deploy uses k8s');
    expect(md).toContain('Auto-scaling is key');
    expect(md).toContain('# Memory');
  });

  it('includes shared atoms when include_shared is true (default)', () => {
    const hustonDir = agentDir('huston');
    const shared = sharedDir();
    openIndex(hustonDir);
    openIndex(shared);

    createAtom({ ...base(hustonDir), type: 'fact', slug: 'private', body: 'Private huston fact.' });
    createAtom({ ...base(shared), type: 'fact', slug: 'global', body: 'Global shared fact.' });

    const md = renderAgentClaudeMd(testDir, 'huston');
    expect(md).toContain('Private huston fact');
    expect(md).toContain('Global shared fact');
  });

  it('excludes shared atoms when include_shared is false', () => {
    const hustonDir = agentDir('huston');
    const shared = sharedDir();
    openIndex(hustonDir);
    openIndex(shared);

    writeRenderConfig(hustonDir, {
      mode: 'operational',
      max_tokens: 8000,
      include_shared: false,
      type_weights: {},
    });

    createAtom({ ...base(hustonDir), type: 'fact', slug: 'private', body: 'Private huston fact.' });
    createAtom({ ...base(shared), type: 'fact', slug: 'global', body: 'Global shared fact.' });

    const md = renderAgentClaudeMd(testDir, 'huston');
    expect(md).toContain('Private huston fact');
    expect(md).not.toContain('Global shared fact');
  });

  it('uses render.yaml max_tokens', () => {
    const hustonDir = agentDir('huston');
    openIndex(hustonDir);

    writeRenderConfig(hustonDir, {
      mode: 'balanced',
      max_tokens: 500,
      include_shared: true,
      type_weights: {},
    });

    // Create many atoms to exceed small budget
    for (let i = 0; i < 20; i++) {
      createAtom({ ...base(hustonDir), type: 'fact', slug: `fact-${i}`, body: `Fact ${i}: ${'x'.repeat(200)}` });
    }

    const md = renderAgentClaudeMd(testDir, 'huston');
    // Should not contain all 20 atoms due to budget
    const atomCount = (md.match(/^### /gm) ?? []).length;
    expect(atomCount).toBeLessThan(20);
  });

  it('opts.maxTokens overrides render.yaml', () => {
    const hustonDir = agentDir('huston');
    openIndex(hustonDir);

    writeRenderConfig(hustonDir, {
      mode: 'balanced',
      max_tokens: 100, // Very small in config
      include_shared: true,
      type_weights: {},
    });

    for (let i = 0; i < 5; i++) {
      createAtom({ ...base(hustonDir), type: 'fact', slug: `fact-${i}`, body: `Fact ${i}.` });
    }

    // Override with larger budget
    const md = renderAgentClaudeMd(testDir, 'huston', { maxTokens: 10000 });
    const atomCount = (md.match(/^### /gm) ?? []).length;
    expect(atomCount).toBe(5);
  });

  it('different agents produce different render outputs', () => {
    const hustonDir = agentDir('huston');
    const mainDir = agentDir('main');
    openIndex(hustonDir);
    openIndex(mainDir);

    createAtom({ ...base(hustonDir), type: 'fact', slug: 'huston-identity', body: 'I am Huston, the ops agent.' });
    createAtom({ ...base(mainDir), type: 'fact', slug: 'main-identity', body: 'I am Main, the constitutive agent.' });

    const hustonMd = renderAgentClaudeMd(testDir, 'huston');
    const mainMd = renderAgentClaudeMd(testDir, 'main');

    expect(hustonMd).toContain('I am Huston');
    expect(hustonMd).not.toContain('I am Main');
    expect(mainMd).toContain('I am Main');
    expect(mainMd).not.toContain('I am Huston');
  });

  it('renders empty memory with getting started guidance', () => {
    const md = renderAgentClaudeMd(testDir, 'huston');
    expect(md).toContain('Getting Started');
  });

  it('--fill with include_shared unions agent + shared atoms (bypasses recall)', () => {
    const hustonDir = agentDir('huston');
    const shared = sharedDir();
    openIndex(hustonDir);
    openIndex(shared);

    createAtom({ ...base(hustonDir), type: 'fact', slug: 'agent-only', body: 'Agent fact body.' });
    createAtom({ ...base(shared), type: 'fact', slug: 'shared-only', body: 'Shared fact body.' });

    const md = renderAgentClaudeMd(testDir, 'huston', { fill: true });
    expect(md).toContain('Agent fact body');
    expect(md).toContain('Shared fact body');
    // Fill banner is emitted by renderFillIsolated when --fill is honored.
    expect(md).toMatch(/budget \d+ tokens, used ~\d+/);
  });

  it('--fill without include_shared falls back to agent-only fill', () => {
    const hustonDir = agentDir('huston');
    const shared = sharedDir();
    openIndex(hustonDir);
    openIndex(shared);

    writeRenderConfig(hustonDir, {
      mode: 'operational',
      max_tokens: 8000,
      include_shared: false,
      type_weights: {},
    });

    createAtom({ ...base(hustonDir), type: 'fact', slug: 'agent-only', body: 'Agent fact body.' });
    createAtom({ ...base(shared), type: 'fact', slug: 'shared-only', body: 'Shared fact body.' });

    const md = renderAgentClaudeMd(testDir, 'huston', { fill: true });
    expect(md).toContain('Agent fact body');
    expect(md).not.toContain('Shared fact body');
    expect(md).toMatch(/budget \d+ tokens, used ~\d+/);
  });
});
