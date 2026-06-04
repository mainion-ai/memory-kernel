import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initMemoryDir, closeAllIndexes, openIndex } from '../src/index.js';
import { detectAndResolveConflicts } from '../src/conflict-detect.js';
import { createAtom, readAtom, getRelationsForAtom } from '../src/index.js';
import { insertTriples } from '../src/triples.js';

let testDir: string;

function backdateAtom(dir: string, atomId: string, iso: string): void {
  const db = openIndex(dir);
  db.prepare('UPDATE atoms SET created_at = ? WHERE atom_id = ?').run(iso, atomId);
}

function forceSuperseded(dir: string, atomId: string): void {
  const db = openIndex(dir);
  db.prepare("UPDATE atoms SET status = 'superseded' WHERE atom_id = ?").run(atomId);
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-toctou-'));
  initMemoryDir(testDir);
  openIndex(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('detectAndResolveConflicts — TOCTOU stale_decision (#107)', () => {
  it('records stale_decision when candidate is superseded during the Tier-2 LLM call', async () => {
    const oldAtom = createAtom({
      memoryDir: testDir, agent_id: 'test', session_id: 'test',
      type: 'fact', slug: 'old-cap', body: 'France capital is Lyon.',
    });
    insertTriples(testDir, oldAtom.frontmatter.id, [
      { subject: 'France', predicate: 'has_capital', object: 'Lyon' },
    ]);
    backdateAtom(testDir, oldAtom.frontmatter.id, '2024-01-01T00:00:00Z');

    const newAtom = createAtom({
      memoryDir: testDir, agent_id: 'test', session_id: 'test',
      type: 'fact', slug: 'new-cap', body: 'France capital is Paris.',
    });
    insertTriples(testDir, newAtom.frontmatter.id, [
      { subject: 'France', predicate: 'has_capital', object: 'Paris' },
    ]);

    // Race simulation: the mocked LLM marks oldAtom as superseded *during* its
    // call, mimicking a concurrent extract that completed its own supersede
    // between our Tier-1 query and our supersede write.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      forceSuperseded(testDir, oldAtom.frontmatter.id);
      return {
        ok: true,
        json: async () => ({ response: '{"conflict": true, "reason": "different capitals"}' }),
      } as Response;
    });

    const r = await detectAndResolveConflicts({
      memoryDir: testDir,
      newAtomId: newAtom.frontmatter.id,
      model: 'qwen2.5:14b',
    });

    expect(r.resolutions).toHaveLength(1);
    expect(r.resolutions[0].action).toBe('stale_decision');
    expect(r.resolutions[0].old_atom_id).toBe(oldAtom.frontmatter.id);
    expect(r.resolutions[0].reason).toMatch(/status changed/);

    const { outbound } = getRelationsForAtom(testDir, newAtom.frontmatter.id);
    expect(
      outbound.some(
        (rel) =>
          rel.target_id === oldAtom.frontmatter.id && rel.relation_type === 'supersedes',
      ),
    ).toBe(false);
  });

  it('still records supersede_failed (not stale_decision) when the atom file is deleted', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ response: '{"conflict": true, "reason": "x"}' }),
    } as Response);

    const oldAtom = createAtom({
      memoryDir: testDir, agent_id: 'test', session_id: 'test',
      type: 'fact', slug: 'old-del', body: 'A is B.',
    });
    insertTriples(testDir, oldAtom.frontmatter.id, [
      { subject: 'A', predicate: 'is', object: 'B' },
    ]);
    backdateAtom(testDir, oldAtom.frontmatter.id, '2024-01-01T00:00:00Z');

    const newAtom = createAtom({
      memoryDir: testDir, agent_id: 'test', session_id: 'test',
      type: 'fact', slug: 'new-del', body: 'A is C.',
    });
    insertTriples(testDir, newAtom.frontmatter.id, [
      { subject: 'A', predicate: 'is', object: 'C' },
    ]);

    // File deleted, but status in index remains 'active' — CAS check should pass,
    // then supersedeAtoms() will throw on the missing file → supersede_failed.
    fs.unlinkSync(oldAtom.filePath!);

    const r = await detectAndResolveConflicts({
      memoryDir: testDir,
      newAtomId: newAtom.frontmatter.id,
      model: 'qwen2.5:14b',
    });

    expect(r.resolutions).toHaveLength(1);
    expect(r.resolutions[0].action).toBe('supersede_failed');
    expect(r.resolutions[0].action).not.toBe('stale_decision');
  });

  it('still supersedes normally when the candidate remains active through the LLM call', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ response: '{"conflict": true, "reason": "x"}' }),
    } as Response);

    const oldAtom = createAtom({
      memoryDir: testDir, agent_id: 'test', session_id: 'test',
      type: 'fact', slug: 'old-ok', body: 'Sky is green.',
    });
    insertTriples(testDir, oldAtom.frontmatter.id, [
      { subject: 'Sky', predicate: 'has_color', object: 'green' },
    ]);
    backdateAtom(testDir, oldAtom.frontmatter.id, '2024-01-01T00:00:00Z');

    const newAtom = createAtom({
      memoryDir: testDir, agent_id: 'test', session_id: 'test',
      type: 'fact', slug: 'new-ok', body: 'Sky is blue.',
    });
    insertTriples(testDir, newAtom.frontmatter.id, [
      { subject: 'Sky', predicate: 'has_color', object: 'blue' },
    ]);

    const r = await detectAndResolveConflicts({
      memoryDir: testDir,
      newAtomId: newAtom.frontmatter.id,
      model: 'qwen2.5:14b',
    });

    expect(r.resolutions).toHaveLength(1);
    expect(r.resolutions[0].action).toBe('superseded');

    const reReadOld = readAtom(oldAtom.filePath!);
    expect(reReadOld.frontmatter.status).toBe('superseded');
  });
});
