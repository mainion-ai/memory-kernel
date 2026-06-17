/**
 * #371 — recall ranking observability (opt-in via RECALL_DEBUG).
 *
 * When RECALL_DEBUG=1, recall() writes a per-atom score breakdown to stderr so
 * "why did atom X outrank atom Y?" is answerable in the field. It is OFF by
 * default (zero overhead, no stderr noise, no ContextBundle field).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initMemoryDir, createAtom, reindex, recall, closeAllIndexes } from '../src/index.js';

let testDir: string;

function seed() {
  // Bodies chosen so the task "notation erasure" FTS-matches A strongly, B weakly.
  createAtom({ memoryDir: testDir, agent_id: 'a', session_id: 's', type: 'belief', slug: 'notation', body: 'Notation erasure: the notation erasure principle governs how erasure works.' });
  createAtom({ memoryDir: testDir, agent_id: 'a', session_id: 's', type: 'fact', slug: 'other', body: 'Erasure appears once here.' });
  reindex(testDir);
}

function captureStderr(): { lines: () => string[]; restore: () => void } {
  const written: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
    written.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  });
  return {
    lines: () => written.join('').split('\n').filter((l) => l.includes('recall-debug:')),
    restore: () => spy.mockRestore(),
  };
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-recall-dbg-'));
  initMemoryDir(testDir);
  delete process.env.RECALL_DEBUG;
});

afterEach(() => {
  delete process.env.RECALL_DEBUG;
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('recall observability (RECALL_DEBUG)', () => {
  it('emits a per-atom task-path score breakdown to stderr when RECALL_DEBUG=1', () => {
    seed();
    process.env.RECALL_DEBUG = '1';
    const cap = captureStderr();
    try {
      recall(testDir, { task: 'notation erasure' });
      const lines = cap.lines();
      // Header names the scoring stage (it is pre-MMR / pre-token-budget).
      expect(lines.some((l) => l.includes('task-path scoring ranking for "notation erasure"'))).toBe(true);
      const atomLines = lines.filter((l) => /fts=.*semantic=.*final=/.test(l));
      expect(atomLines.length).toBeGreaterThanOrEqual(1);
      // Every documented component key is present on an atom line.
      const firstAtom = atomLines[0]!;
      for (const key of ['fts=', 'specificity=', 'length=', 'coverage=', 'semantic=', 'recency=', 'type_weight=', 'conf_factor=', 'graph_boost=', 'final=']) {
        expect(firstAtom).toContain(key);
      }
      // The trace covers the scored candidate pool — both seeded atoms FTS-match
      // "notation erasure" (this is the scoring stage, NOT necessarily the final
      // returned set, which MMR/token-budget can prune — so don't couple to
      // bundle.atoms.length).
      const traced = atomLines.join('\n');
      expect(traced).toMatch(/NOTATION/);
      expect(traced).toMatch(/OTHER/);
    } finally {
      cap.restore();
    }
  });

  it('is silent (no recall-debug output) when RECALL_DEBUG is unset', () => {
    seed();
    // RECALL_DEBUG deliberately unset (beforeEach deletes it).
    const cap = captureStderr();
    try {
      recall(testDir, { task: 'notation erasure' });
      expect(cap.lines()).toHaveLength(0);
    } finally {
      cap.restore();
    }
  });

  it('emits a no-task ranking trace when RECALL_DEBUG=1 and no task is given', () => {
    seed();
    process.env.RECALL_DEBUG = '1';
    const cap = captureStderr();
    try {
      recall(testDir, {});
      const lines = cap.lines();
      expect(lines.some((l) => l.includes('no-task ranking'))).toBe(true);
      expect(lines.some((l) => /status_priority=.*recency=.*updated_at=/.test(l))).toBe(true);
    } finally {
      cap.restore();
    }
  });
});
