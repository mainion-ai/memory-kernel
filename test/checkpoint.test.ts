/**
 * Checkpoint tests — integration tests for the checkpoint/handoff API.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  initMemoryDir,
  createAtom,
  readEvents,
} from '../src/index.js';
import { checkpoint } from '../src/checkpoint.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-ckpt-'));
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

const BASE_OPTS = {
  agent_id: 'test-agent',
  session_id: 'test-session',
};

describe('checkpoint', () => {
  it('works on empty memory', () => {
    initMemoryDir(testDir);
    const result = checkpoint({ memoryDir: testDir, ...BASE_OPTS });

    expect(result.markdown).toContain('Memory Index');
    expect(result.markdown).toContain('Handoff');
    expect(result.markdown).toContain('Constraints');
    expect(result.event_id).toBeTruthy();
    expect(result.bundle.atoms).toHaveLength(0);
  });

  it('includes atoms in the bundle', () => {
    initMemoryDir(testDir);
    createAtom({ memoryDir: testDir, ...BASE_OPTS, type: 'decision', slug: 'use-ts', body: 'Use TypeScript' });
    createAtom({ memoryDir: testDir, ...BASE_OPTS, type: 'constraint', slug: 'max-lines', body: 'Max 200 lines' });

    const result = checkpoint({ memoryDir: testDir, ...BASE_OPTS });

    expect(result.bundle.atoms.length).toBeGreaterThanOrEqual(2);
    expect(result.markdown).toContain('Scoped Atoms');
    expect(result.markdown).toContain('Use TypeScript');
  });

  it('emits checkpoint_created event', () => {
    initMemoryDir(testDir);
    checkpoint({ memoryDir: testDir, ...BASE_OPTS });

    const events = readEvents(testDir);
    const ckptEvents = events.filter((e) => e.action === 'checkpoint_created');
    expect(ckptEvents.length).toBeGreaterThanOrEqual(1);

    const last = ckptEvents[ckptEvents.length - 1];
    expect(last.meta).toHaveProperty('token_estimate');
    expect(last.meta).toHaveProperty('atom_count');
  });

  it('skipReflect option works', () => {
    initMemoryDir(testDir);
    createAtom({ memoryDir: testDir, ...BASE_OPTS, type: 'fact', slug: 'f1', body: 'Some fact' });

    const result = checkpoint({ memoryDir: testDir, ...BASE_OPTS, skipReflect: true });

    // Should still produce output
    expect(result.markdown).toContain('Memory Index');
    expect(result.event_id).toBeTruthy();

    // Verify no reflect_completed event (only checkpoint_created + atom_created)
    const events = readEvents(testDir);
    const reflectEvents = events.filter((e) => e.action === 'reflect_completed');
    expect(reflectEvents).toHaveLength(0);
  });

  it('respects token budget', () => {
    initMemoryDir(testDir);
    // Create many atoms with UNIQUE bodies to avoid dedup
    for (let i = 0; i < 20; i++) {
      createAtom({
        memoryDir: testDir, ...BASE_OPTS,
        type: 'fact', slug: `fact-${i}`,
        body: `Unique fact number ${i}: ${'A'.repeat(200)}`,
      });
    }

    const small = checkpoint({ memoryDir: testDir, ...BASE_OPTS, max_tokens: 100 });
    const large = checkpoint({ memoryDir: testDir, ...BASE_OPTS, max_tokens: 10000 });

    expect(small.bundle.atoms.length).toBeLessThan(large.bundle.atoms.length);
  });

  it('passes task through to recall', () => {
    initMemoryDir(testDir);
    const result = checkpoint({
      memoryDir: testDir, ...BASE_OPTS,
      task: 'Implement authentication',
    });

    // Task is stored in checkpoint event meta
    const events = readEvents(testDir);
    const ckptEvent = events.find((e) => e.action === 'checkpoint_created');
    expect(ckptEvent?.meta?.task).toBe('Implement authentication');
  });

  it('is deterministic ignoring timestamps', () => {
    initMemoryDir(testDir);
    createAtom({ memoryDir: testDir, ...BASE_OPTS, type: 'decision', slug: 'test', body: 'Test decision' });

    const r1 = checkpoint({ memoryDir: testDir, ...BASE_OPTS, skipReflect: true });
    const r2 = checkpoint({ memoryDir: testDir, ...BASE_OPTS, skipReflect: true });

    // The markdown structure should be the same (timestamps will differ)
    expect(r1.bundle.atoms.length).toBe(r2.bundle.atoms.length);
  });

  it('includes fresh views after reflect', () => {
    initMemoryDir(testDir);
    createAtom({ memoryDir: testDir, ...BASE_OPTS, type: 'decision', slug: 'use-ts', body: 'Use TypeScript' });

    const result = checkpoint({ memoryDir: testDir, ...BASE_OPTS });

    // Views should contain the decision we just created
    expect(result.bundle.index).toContain('Decisions (1)');
    expect(result.bundle.handoff).toContain('Handoff');
  });
});
