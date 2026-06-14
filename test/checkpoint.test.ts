/**
 * Checkpoint tests — integration tests for the checkpoint/handoff API.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  initMemoryDir,
  createAtom,
  readEvents,
  initIsolatedBase,
  closeAllIndexes,
} from '../src/index.js';
import { checkpoint } from '../src/checkpoint.js';
import * as embeddings from '../src/embeddings.js';

// Partial mock so getEmbeddingConfig/embedText are spy-able while the rest of
// the embeddings module (used by recall's ranking) stays real.
vi.mock('../src/embeddings.js', async (importActual) => ({
  ...(await importActual<typeof import('../src/embeddings.js')>()),
}));

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-ckpt-'));
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

const BASE_OPTS = {
  agent_id: 'test-agent',
  session_id: 'test-session',
};

describe('checkpoint', () => {
  it('works on empty memory', async () => {
    initMemoryDir(testDir);
    const result = await checkpoint({ memoryDir: testDir, ...BASE_OPTS });

    expect(result.markdown).toContain('Memory Index');
    expect(result.markdown).toContain('Handoff');
    expect(result.markdown).toContain('Constraints');
    expect(result.event_id).toBeTruthy();
    expect(result.bundle.atoms).toHaveLength(0);
  });

  it('includes atoms in the bundle', async () => {
    initMemoryDir(testDir);
    createAtom({ memoryDir: testDir, ...BASE_OPTS, type: 'decision', slug: 'use-ts', body: 'Use TypeScript' });
    createAtom({ memoryDir: testDir, ...BASE_OPTS, type: 'constraint', slug: 'max-lines', body: 'Max 200 lines' });

    const result = await checkpoint({ memoryDir: testDir, ...BASE_OPTS });

    expect(result.bundle.atoms.length).toBeGreaterThanOrEqual(2);
    expect(result.markdown).toContain('Scoped Atoms');
    expect(result.markdown).toContain('Use TypeScript');
  });

  it('emits checkpoint_created event', async () => {
    initMemoryDir(testDir);
    await checkpoint({ memoryDir: testDir, ...BASE_OPTS });

    const events = readEvents(testDir);
    const ckptEvents = events.filter((e) => e.action === 'checkpoint_created');
    expect(ckptEvents.length).toBeGreaterThanOrEqual(1);

    const last = ckptEvents[ckptEvents.length - 1];
    expect(last.meta).toHaveProperty('token_estimate');
    expect(last.meta).toHaveProperty('atom_count');
  });

  it('skipReflect option works', async () => {
    initMemoryDir(testDir);
    createAtom({ memoryDir: testDir, ...BASE_OPTS, type: 'fact', slug: 'f1', body: 'Some fact' });

    const result = await checkpoint({ memoryDir: testDir, ...BASE_OPTS, skipReflect: true });

    // Should still produce output
    expect(result.markdown).toContain('Memory Index');
    expect(result.event_id).toBeTruthy();

    // Verify no reflect_completed event (only checkpoint_created + atom_created)
    const events = readEvents(testDir);
    const reflectEvents = events.filter((e) => e.action === 'reflect_completed');
    expect(reflectEvents).toHaveLength(0);
  });

  it('respects token budget', async () => {
    initMemoryDir(testDir);
    // Create many atoms with UNIQUE bodies to avoid dedup
    for (let i = 0; i < 20; i++) {
      createAtom({
        memoryDir: testDir, ...BASE_OPTS,
        type: 'fact', slug: `fact-${i}`,
        body: `Unique fact number ${i}: ${'A'.repeat(200)}`,
      });
    }

    const small = await checkpoint({ memoryDir: testDir, ...BASE_OPTS, max_tokens: 100 });
    const large = await checkpoint({ memoryDir: testDir, ...BASE_OPTS, max_tokens: 10000 });

    expect(small.bundle.atoms.length).toBeLessThan(large.bundle.atoms.length);
  });

  it('passes task through to recall', async () => {
    initMemoryDir(testDir);
    const result = await checkpoint({
      memoryDir: testDir, ...BASE_OPTS,
      task: 'Implement authentication',
    });

    // Task is stored in checkpoint event meta
    const events = readEvents(testDir);
    const ckptEvent = events.find((e) => e.action === 'checkpoint_created');
    expect(ckptEvent?.meta?.task).toBe('Implement authentication');
  });

  it('is deterministic ignoring timestamps', async () => {
    initMemoryDir(testDir);
    createAtom({ memoryDir: testDir, ...BASE_OPTS, type: 'decision', slug: 'test', body: 'Test decision' });

    const r1 = await checkpoint({ memoryDir: testDir, ...BASE_OPTS, skipReflect: true });
    const r2 = await checkpoint({ memoryDir: testDir, ...BASE_OPTS, skipReflect: true });

    // The markdown structure should be the same (timestamps will differ)
    expect(r1.bundle.atoms.length).toBe(r2.bundle.atoms.length);
  });

  it('includes fresh views after reflect', async () => {
    initMemoryDir(testDir);
    createAtom({ memoryDir: testDir, ...BASE_OPTS, type: 'decision', slug: 'use-ts', body: 'Use TypeScript' });

    const result = await checkpoint({ memoryDir: testDir, ...BASE_OPTS });

    // Views should contain the decision we just created
    expect(result.bundle.index).toContain('Decisions (1)');
    expect(result.bundle.handoff).toContain('Handoff');
  });
});

describe('isolation-aware checkpoint', () => {
  it('includes shared atoms when isolated + sharedRecall', async () => {
    initIsolatedBase(testDir, 'test-agent');
    const agentDir = path.join(testDir, 'agents', 'test-agent');
    const sharedDir = path.join(testDir, 'shared');

    createAtom({ memoryDir: agentDir, ...BASE_OPTS, type: 'fact', slug: 'agent-f', body: 'Agent fact for checkpoint' });
    createAtom({ memoryDir: sharedDir, ...BASE_OPTS, type: 'decision', slug: 'shared-d', body: 'Shared decision for checkpoint' });

    const result = await checkpoint({
      memoryDir: agentDir,
      ...BASE_OPTS,
      baseDir: testDir,
      isolated: true,
      sharedRecall: true,
    });

    expect(result.bundle.atoms.length).toBe(2);
    expect(result.markdown).toContain('Agent fact for checkpoint');
    expect(result.markdown).toContain('Shared decision for checkpoint');
  });

  it('excludes shared atoms when sharedRecall is false', async () => {
    initIsolatedBase(testDir, 'test-agent');
    const agentDir = path.join(testDir, 'agents', 'test-agent');
    const sharedDir = path.join(testDir, 'shared');

    createAtom({ memoryDir: agentDir, ...BASE_OPTS, type: 'fact', slug: 'agent-f', body: 'Agent fact only' });
    createAtom({ memoryDir: sharedDir, ...BASE_OPTS, type: 'decision', slug: 'shared-d', body: 'Shared decision excluded' });

    const result = await checkpoint({
      memoryDir: agentDir,
      ...BASE_OPTS,
      baseDir: testDir,
      isolated: true,
      sharedRecall: false,
    });

    expect(result.bundle.atoms.length).toBe(1);
    expect(result.markdown).toContain('Agent fact only');
    expect(result.markdown).not.toContain('Shared decision excluded');
  });

  it('isolation params absent means single-dir recall (backward compat)', async () => {
    initMemoryDir(testDir);
    createAtom({ memoryDir: testDir, ...BASE_OPTS, type: 'fact', slug: 'compat', body: 'Backward compat fact' });

    const result = await checkpoint({ memoryDir: testDir, ...BASE_OPTS });
    expect(result.bundle.atoms.length).toBe(1);
    expect(result.markdown).toContain('Backward compat fact');
  });

  it('checkpoint event includes isolation metadata', async () => {
    initIsolatedBase(testDir, 'test-agent');
    const agentDir = path.join(testDir, 'agents', 'test-agent');
    createAtom({ memoryDir: agentDir, ...BASE_OPTS, type: 'fact', slug: 'meta-test', body: 'Metadata test' });

    await checkpoint({
      memoryDir: agentDir,
      ...BASE_OPTS,
      baseDir: testDir,
      isolated: true,
      sharedRecall: true,
    });

    const events = readEvents(agentDir);
    const ckpt = events.find((e) => e.action === 'checkpoint_created');
    expect(ckpt?.meta?.isolated).toBe(true);
    expect(ckpt?.meta?.shared_recall).toBe(true);
  });
});

describe('checkpoint embedding recall (#323)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('embeds the task when an embedding key is configured', async () => {
    initMemoryDir(testDir);
    createAtom({ memoryDir: testDir, ...BASE_OPTS, type: 'fact', slug: 'f', body: 'A fact about pagination cursors' });

    const cfgSpy = vi.spyOn(embeddings, 'getEmbeddingConfig')
      .mockReturnValue({ provider: 'voyage', model: 'voyage-3', dimensions: 3 } as any);
    const embedSpy = vi.spyOn(embeddings, 'embedText')
      .mockResolvedValue({ vector: [0, 0, 1], model: 'voyage-3' } as any);

    const result = await checkpoint({ memoryDir: testDir, ...BASE_OPTS, task: 'how does paging work' });

    // checkpoint now takes the semantic path: the task was embedded.
    expect(cfgSpy).toHaveBeenCalled();
    expect(embedSpy).toHaveBeenCalledWith('how does paging work', expect.anything());
    expect(result.event_id).toBeTruthy();
  });

  it('does NOT embed (silent FTS fallback) when no key is configured', async () => {
    initMemoryDir(testDir);
    createAtom({ memoryDir: testDir, ...BASE_OPTS, type: 'fact', slug: 'f', body: 'A fact' });

    vi.spyOn(embeddings, 'getEmbeddingConfig').mockReturnValue(null);
    const embedSpy = vi.spyOn(embeddings, 'embedText');

    const result = await checkpoint({ memoryDir: testDir, ...BASE_OPTS, task: 'anything' });

    expect(embedSpy).not.toHaveBeenCalled(); // no-key path unchanged (FTS-only)
    expect(result.markdown).toContain('Memory Index');
  });

  it('does NOT embed when there is no task (cheap path preserved)', async () => {
    initMemoryDir(testDir);
    vi.spyOn(embeddings, 'getEmbeddingConfig')
      .mockReturnValue({ provider: 'voyage', model: 'voyage-3', dimensions: 3 } as any);
    const embedSpy = vi.spyOn(embeddings, 'embedText');

    await checkpoint({ memoryDir: testDir, ...BASE_OPTS }); // no task

    expect(embedSpy).not.toHaveBeenCalled();
  });
});
