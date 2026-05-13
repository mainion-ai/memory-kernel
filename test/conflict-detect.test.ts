import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initMemoryDir, closeAllIndexes, openIndex } from '../src/index.js';
import { confirmConflictWithLLM, detectAndResolveConflicts } from '../src/conflict-detect.js';
import { createAtom, readAtom, getRelationsForAtom } from '../src/index.js';
import { insertTriples } from '../src/triples.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-conflict-'));
  initMemoryDir(testDir);
  openIndex(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function mockOllama(response: string) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({ response }),
  } as Response);
}

describe('confirmConflictWithLLM', () => {
  it('returns conflict=true when model says YES', async () => {
    mockOllama('{"conflict": true, "reason": "different capitals"}');
    const r = await confirmConflictWithLLM({
      oldFact: 'France capital is Lyon',
      newFact: 'France capital is Paris',
      model: 'qwen2.5:14b',
    });
    expect(r.conflict).toBe(true);
    expect(r.reason).toMatch(/capital/);
  });

  it('returns conflict=false when model says NO', async () => {
    mockOllama('{"conflict": false, "reason": "facts complement each other"}');
    const r = await confirmConflictWithLLM({
      oldFact: 'Paris is in France',
      newFact: 'Paris has 2M residents',
      model: 'qwen2.5:14b',
    });
    expect(r.conflict).toBe(false);
  });

  it('returns conflict=false (fail-safe) when LLM returns malformed JSON', async () => {
    mockOllama('not json at all');
    const r = await confirmConflictWithLLM({
      oldFact: 'a', newFact: 'b', model: 'qwen2.5:14b',
    });
    expect(r.conflict).toBe(false);
    expect(r.reason).toMatch(/parse/i);
  });

  it('strips markdown code fences from model output', async () => {
    mockOllama('```json\n{"conflict": true, "reason": "x"}\n```');
    const r = await confirmConflictWithLLM({
      oldFact: 'a', newFact: 'b', model: 'qwen2.5:14b',
    });
    expect(r.conflict).toBe(true);
  });

  it('returns conflict=false (fail-safe) when callLLM throws', async () => {
    // Make fetch throw to simulate Ollama network failure
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const r = await confirmConflictWithLLM({
      oldFact: 'a', newFact: 'b', model: 'qwen2.5:14b',
    });
    expect(r.conflict).toBe(false);
    expect(r.reason).toMatch(/LLM call failed/);
    expect(r.reason).toMatch(/network down/);
  });

  it('returns conflict=false (fail-safe) when JSON is structurally valid but missing the conflict field', async () => {
    mockOllama('{"reason": "no verdict"}');
    const r = await confirmConflictWithLLM({
      oldFact: 'a', newFact: 'b', model: 'qwen2.5:14b',
    });
    expect(r.conflict).toBe(false);
    expect(r.reason).toMatch(/malformed response/);
  });
});

const base = (dir: string) => ({ memoryDir: dir, agent_id: 'test', session_id: 'test' });

describe('detectAndResolveConflicts', () => {
  it('returns empty resolutions when no candidates exist', async () => {
    const a = createAtom({ ...base(testDir), type: 'fact', slug: 'lonely', body: 'lonely fact' });
    insertTriples(testDir, a.frontmatter.id, [
      { subject: 'X', predicate: 'is', object: 'Y' },
    ]);
    const r = await detectAndResolveConflicts({
      memoryDir: testDir,
      newAtomId: a.frontmatter.id,
    });
    expect(r.resolutions).toEqual([]);
    expect(r.llm_calls).toBe(0);
  });

  it('auto-supersedes an older atom when Tier 2 confirms the conflict', async () => {
    mockOllama('{"conflict": true, "reason": "x"}');
    const oldAtom = createAtom({ ...base(testDir), type: 'fact', slug: 'old-cap', body: 'France capital is Lyon.' });
    insertTriples(testDir, oldAtom.frontmatter.id, [{ subject: 'France', predicate: 'has_capital', object: 'Lyon' }]);

    // Force a clear created_at gap (timestamps are second-precision)
    await new Promise((res) => setTimeout(res, 1100));

    const newAtom = createAtom({ ...base(testDir), type: 'fact', slug: 'new-cap', body: 'France capital is Paris.' });
    insertTriples(testDir, newAtom.frontmatter.id, [{ subject: 'France', predicate: 'has_capital', object: 'Paris' }]);

    const r = await detectAndResolveConflicts({
      memoryDir: testDir,
      newAtomId: newAtom.frontmatter.id,
      model: 'qwen2.5:14b',
    });

    expect(r.resolutions).toHaveLength(1);
    expect(r.resolutions[0].action).toBe('superseded');
    expect(r.resolutions[0].old_atom_id).toBe(oldAtom.frontmatter.id);
    expect(r.resolutions[0].new_atom_id).toBe(newAtom.frontmatter.id);

    // Verify the supersede side-effects actually applied:
    const reReadOld = readAtom(oldAtom.filePath!);
    expect(reReadOld.frontmatter.status).toBe('superseded');

    const { outbound } = getRelationsForAtom(testDir, newAtom.frontmatter.id);
    expect(outbound.some((rel) => rel.target_id === oldAtom.frontmatter.id && rel.relation_type === 'supersedes')).toBe(true);
  });

  it('does NOT supersede when Tier 2 returns conflict=false', async () => {
    mockOllama('{"conflict": false, "reason": "complementary"}');
    const oldAtom = createAtom({ ...base(testDir), type: 'fact', slug: 'old-p', body: 'Paris is a city.' });
    insertTriples(testDir, oldAtom.frontmatter.id, [{ subject: 'Paris', predicate: 'is_a', object: 'City' }]);

    await new Promise((res) => setTimeout(res, 1100));

    const newAtom = createAtom({ ...base(testDir), type: 'fact', slug: 'new-p', body: 'Paris is a capital.' });
    insertTriples(testDir, newAtom.frontmatter.id, [{ subject: 'Paris', predicate: 'is_a', object: 'Capital' }]);

    const r = await detectAndResolveConflicts({
      memoryDir: testDir,
      newAtomId: newAtom.frontmatter.id,
      model: 'qwen2.5:14b',
    });

    expect(r.resolutions).toHaveLength(1);
    expect(r.resolutions[0].action).toBe('not_a_conflict');
    expect(r.llm_calls).toBe(1);

    const reReadOld = readAtom(oldAtom.filePath!);
    expect(reReadOld.frontmatter.status).not.toBe('superseded');
  });

  it('skips Tier 2 when new atom is OLDER than the candidate (defensive)', async () => {
    const newAtom = createAtom({ ...base(testDir), type: 'fact', slug: 'new', body: 'A is B.' });
    insertTriples(testDir, newAtom.frontmatter.id, [{ subject: 'A', predicate: 'is', object: 'B' }]);

    await new Promise((res) => setTimeout(res, 1100));

    const oldAtom = createAtom({ ...base(testDir), type: 'fact', slug: 'old', body: 'A is C.' });
    insertTriples(testDir, oldAtom.frontmatter.id, [{ subject: 'A', predicate: 'is', object: 'C' }]);

    // call against newAtom: candidate (oldAtom) is *newer* than newAtom → skip
    const r = await detectAndResolveConflicts({
      memoryDir: testDir,
      newAtomId: newAtom.frontmatter.id,
      model: 'qwen2.5:14b',
    });
    expect(r.resolutions).toHaveLength(1);
    expect(r.resolutions[0].action).toBe('skipped_wrong_direction');
    expect(r.llm_calls).toBe(0);
  });

  it('honors dryRun (no supersede side-effects)', async () => {
    mockOllama('{"conflict": true, "reason": "x"}');
    const oldAtom = createAtom({ ...base(testDir), type: 'fact', slug: 'old', body: 'A is B.' });
    insertTriples(testDir, oldAtom.frontmatter.id, [{ subject: 'A', predicate: 'is', object: 'B' }]);
    await new Promise((res) => setTimeout(res, 1100));
    const newAtom = createAtom({ ...base(testDir), type: 'fact', slug: 'new', body: 'A is C.' });
    insertTriples(testDir, newAtom.frontmatter.id, [{ subject: 'A', predicate: 'is', object: 'C' }]);

    const r = await detectAndResolveConflicts({
      memoryDir: testDir,
      newAtomId: newAtom.frontmatter.id,
      model: 'qwen2.5:14b',
      dryRun: true,
    });

    expect(r.resolutions[0].action).toBe('would_supersede');
    const reReadOld = readAtom(oldAtom.filePath!);
    expect(reReadOld.frontmatter.status).not.toBe('superseded');
  });
});
