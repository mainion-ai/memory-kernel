/**
 * OpenClaw-like integration tests (tool-surface simulation).
 *
 * Goal:
 * - Reproduce the live-test workflow (mk_remember -> mk_recall)
 * - Make recall behavior explainable + regression-tested
 *
 * These tests intentionally do NOT import the OpenClaw plugin package.
 * The plugin lives in a subpackage with its own deps; root CI should remain slim.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { FakeToolApi, stringifyResult } from '../_harness/openclaw-like.js';

import { initMemoryDir, createAtom, recall, reflect, checkpoint, reindex, closeAllIndexes } from '../../src/index.js';
import type { AtomType, Classification, RecallQuery } from '../../src/index.js';

function registerMemoryKernelTools(api: FakeToolApi, memoryDir: string) {
  api.registerTool({
    name: 'mk_remember',
    async execute(_id, params) {
      const p = params as {
        type: AtomType;
        slug: string;
        body: string;
        classification?: Classification;
        confidence?: number;
      };

      // Simulate "agent writes structured atom"
      const atom = createAtom({
        memoryDir,
        agent_id: 'openclaw-agent',
        session_id: 'openclaw-session',
        type: p.type,
        slug: p.slug,
        body: p.body,
        classification: p.classification,
        confidence: p.confidence,
      });

      return { ok: true, text: `Stored ${atom.frontmatter.type}: ${atom.frontmatter.id}` };
    },
  });

  api.registerTool({
    name: 'mk_recall',
    async execute(_id, params) {
      const p = params as RecallQuery;
      const bundle = recall(memoryDir, {
        task: p.task,
        types: p.types,
        tags: p.tags,
        include_episodes: p.include_episodes,
        max_tokens: p.max_tokens,
      });

      const text =
        (bundle.atoms?.length ?? 0) > 0
          ? bundle.atoms.map((a) => `- [${a.frontmatter.type}] ${a.frontmatter.id}: ${a.body}`).join('\n')
          : '(no atoms found)';

      return { ok: true, text, meta: { atomCount: bundle.atoms?.length ?? 0, tokenEstimate: bundle.token_estimate, atoms: bundle.atoms ?? [] } };
    },
  });

  api.registerTool({
    name: 'mk_reflect',
    async execute() {
      const result = reflect({ memoryDir, agent_id: 'openclaw-agent', session_id: 'openclaw-session' });
      return { ok: true, text: 'reflect complete', meta: result };
    },
  });

  api.registerTool({
    name: 'mk_context_bundle',
    async execute(_id, params) {
      const p = params as { task?: string; max_tokens?: number; skipReflect?: boolean };
      const result = checkpoint({ memoryDir, agent_id: 'openclaw-agent', session_id: 'openclaw-session', task: p.task, max_tokens: p.max_tokens, skipReflect: p.skipReflect });
      return { ok: true, text: result.markdown, meta: result };
    },
  });
}

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-openclaw-like-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('OpenClaw-like tool surface', () => {
  it('mk_remember -> mk_recall roundtrip works for TEAM atoms', async () => {
    const api = new FakeToolApi();
    registerMemoryKernelTools(api, testDir);

    await api.getTool('mk_remember').execute('1', {
      type: 'preference',
      slug: 'ui-theme',
      body: 'User prefers dark mode.',
      classification: 'TEAM',
    });

    const res = await api.getTool('mk_recall').execute('2', { types: ['preference'] });
    const s = stringifyResult(res);
    expect(s).toContain('dark mode');
    expect(s).toContain('preference');
  });

  it('documents policy: PERSONAL / SECRET atoms are excluded from recall by default', async () => {
    const api = new FakeToolApi();
    registerMemoryKernelTools(api, testDir);

    await api.getTool('mk_remember').execute('1', {
      type: 'preference',
      slug: 'coffee-order',
      body: 'User coffee order: flat white.',
      classification: 'PERSONAL',
    });

    const res = await api.getTool('mk_recall').execute('2', { types: ['preference'] });
    const s = stringifyResult(res);
    expect(s).not.toContain('flat white');
    expect(s).toContain('(no atoms found)');
  });

  it('task-based FTS re-ranking requires an index (reindex) to be present', async () => {
    // This test reproduces the "FTS task-based ranking not functioning" report.
    // Without an index, recall falls back to file-scan; task re-ranking is limited.
    const api = new FakeToolApi();
    registerMemoryKernelTools(api, testDir);

    await api.getTool('mk_remember').execute('1', {
      type: 'fact',
      slug: 'alpha',
      body: 'Alpha uses TypeScript.',
      classification: 'TEAM',
    });
    await api.getTool('mk_remember').execute('2', {
      type: 'fact',
      slug: 'beta',
      body: 'Beta uses Python.',
      classification: 'TEAM',
    });

    // Build SQLite + FTS index.
    reindex(testDir);

    const res = await api.getTool('mk_recall').execute('3', { task: 'TypeScript', types: ['fact'] });

    // The keyword-matching atom should be ranked first by FTS.
    expect(res.meta.atomCount).toBe(2);
    const bodies = (res.meta.atoms as any[]).map((a) => a.body as string);
    expect(bodies[0]).toContain('TypeScript');
    expect(bodies[1]).toContain('Python');
  });
});
