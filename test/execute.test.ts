import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initMemoryDir, createAtom, listAtoms, closeAllIndexes } from '../src/index.js';
import { markExecuted } from '../src/execute.js';
import { readEvents } from '../src/event-log.js';

let testDir: string;

function seedProcedure(): string {
  return createAtom({
    memoryDir: testDir, agent_id: 'a', session_id: 's',
    type: 'procedure', slug: 'do-the-thing', body: 'Steps.', confidence: 0.8, status: 'draft', ttl_days: null,
  }).frontmatter.id;
}
function executedAtOf(id: string): string | undefined {
  return listAtoms(testDir).find((a) => a.frontmatter.id === id)?.frontmatter.executed_at;
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-execute-'));
  initMemoryDir(testDir);
});
afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('markExecuted (#309)', () => {
  it('stamps executed_at and emits an atom_updated event', () => {
    const id = seedProcedure();
    const r = markExecuted({ memoryDir: testDir, atomId: id });
    expect(r.changed).toBe(true);
    expect(r.executed_at).toBeTruthy();
    expect(executedAtOf(id)).toBe(r.executed_at);

    const events = readEvents(testDir);
    const ev = events.find((e) => e.action === 'atom_updated' && e.meta?.operation === 'execute' && e.atom_refs?.includes(id));
    expect(ev).toBeDefined();
  });

  it('is idempotent — a second call preserves the first execution time', () => {
    const id = seedProcedure();
    const first = markExecuted({ memoryDir: testDir, atomId: id });
    const second = markExecuted({ memoryDir: testDir, atomId: id });
    expect(second.changed).toBe(false);
    expect(second.executed_at).toBe(first.executed_at);
    expect(executedAtOf(id)).toBe(first.executed_at);
  });

  it('throws on a missing atom', () => {
    expect(() => markExecuted({ memoryDir: testDir, atomId: 'PROC-2026-01-01-NOPE-xyz' })).toThrow(/not found/i);
  });

  it('--dry-run writes nothing', () => {
    const id = seedProcedure();
    const r = markExecuted({ memoryDir: testDir, atomId: id, dryRun: true });
    expect(r.changed).toBe(true);
    expect(executedAtOf(id)).toBeUndefined(); // not persisted
  });
});
