import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  initMemoryDir,
  createAtom,
  closeAllIndexes,
  openIndex,
  readAtom,
  listAtoms,
} from '../src/index.js';
import { enrichRelations, MAX_REASONING_LEN } from '../src/enrich-relations.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-enrich-'));
  initMemoryDir(testDir);
  openIndex(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

let pairCounter = 0;

/** Helper: create two atoms with a "related" edge between them. */
function createRelatedPair(suffix?: string): { sourceId: string; targetId: string } {
  const tag = suffix ?? String(++pairCounter);
  const target = createAtom({
    memoryDir: testDir,
    agent_id: 'test', session_id: 'test',
    type: 'belief', slug: `target-notation-${tag}`,
    body: 'Notation systems shape cognitive boundaries. Writing is a form of thinking.',
  });
  const source = createAtom({
    memoryDir: testDir,
    agent_id: 'test', session_id: 'test',
    type: 'belief', slug: `source-erasure-${tag}`,
    body: 'Erasure practices in notation reveal hidden assumptions about knowledge.',
    relations: [{ target: target.frontmatter.id, type: 'related' as const }],
  });
  return {
    sourceId: source.frontmatter.id,
    targetId: target.frontmatter.id,
  };
}

function mockFetch(response: string) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({ response }),
  } as Response);
}

describe('enrichRelations', () => {
  it('produces correct proposal from mocked Ollama response', async () => {
    const { sourceId, targetId } = createRelatedPair();

    mockFetch(JSON.stringify({
      type: 'extends',
      confidence: 0.9,
      reasoning: 'source elaborates on notation concepts from target',
    }));

    const result = await enrichRelations(testDir, {
      dryRun: true,
      ollamaUrl: 'http://mock:11434',
      model: 'test-model',
    });

    expect(result.total_related).toBe(1);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({
      sourceId,
      targetId,
      oldType: 'related',
      newType: 'extends',
      confidence: 0.9,
      reasoning: 'source elaborates on notation concepts from target',
    });
    expect(result.kept_related).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('filters low confidence proposals', async () => {
    createRelatedPair();

    mockFetch(JSON.stringify({
      type: 'extends',
      confidence: 0.5,
      reasoning: 'weak connection',
    }));

    const result = await enrichRelations(testDir, {
      dryRun: true,
      ollamaUrl: 'http://mock:11434',
      model: 'test-model',
      minConfidence: 0.7,
    });

    expect(result.total_related).toBe(1);
    expect(result.proposals).toHaveLength(0);
    expect(result.kept_related).toBe(1);
  });

  it('handles invalid JSON from Ollama gracefully', async () => {
    createRelatedPair();

    mockFetch('This is not valid JSON at all');

    const result = await enrichRelations(testDir, {
      dryRun: true,
      ollamaUrl: 'http://mock:11434',
      model: 'test-model',
    });

    expect(result.total_related).toBe(1);
    expect(result.proposals).toHaveLength(0);
    expect(result.errors).toBe(1);
  });

  it('updates frontmatter in apply mode', async () => {
    const { sourceId, targetId } = createRelatedPair();

    mockFetch(JSON.stringify({
      type: 'supports',
      confidence: 0.95,
      reasoning: 'source provides evidence for target',
    }));

    const result = await enrichRelations(testDir, {
      dryRun: false,
      ollamaUrl: 'http://mock:11434',
      model: 'test-model',
    });

    expect(result.applied).toBe(1);

    // Verify the atom file was updated
    const atoms = listAtoms(testDir);
    const atom = atoms.find((a) => a.frontmatter.id === sourceId)!;
    expect(atom).toBeDefined();
    const rel = atom.frontmatter.relations!.find((r) => r.target === targetId);
    expect(rel).toBeDefined();
    expect(rel!.type).toBe('supports');
  });

  it('returns empty result when no related edges exist', async () => {
    // Create atoms with no relations
    createAtom({
      memoryDir: testDir,
      agent_id: 'test', session_id: 'test',
      type: 'belief', slug: 'standalone',
      body: 'standalone atom',
    });

    const result = await enrichRelations(testDir, {
      dryRun: true,
      ollamaUrl: 'http://mock:11434',
      model: 'test-model',
    });

    expect(result.total_related).toBe(0);
    expect(result.proposals).toHaveLength(0);
    expect(result.kept_related).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('handles Ollama HTTP errors gracefully', async () => {
    createRelatedPair();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as Response);

    const result = await enrichRelations(testDir, {
      dryRun: true,
      ollamaUrl: 'http://mock:11434',
      model: 'test-model',
    });

    expect(result.errors).toBe(1);
    expect(result.proposals).toHaveLength(0);
  });

  it('keeps edge as related when LLM returns related type', async () => {
    createRelatedPair();

    mockFetch(JSON.stringify({
      type: 'related',
      confidence: 0.8,
      reasoning: 'genuinely a generic relation',
    }));

    const result = await enrichRelations(testDir, {
      dryRun: true,
      ollamaUrl: 'http://mock:11434',
      model: 'test-model',
    });

    expect(result.proposals).toHaveLength(0);
    expect(result.kept_related).toBe(1);
  });

  it('handles fetch throwing ECONNREFUSED (network error)', async () => {
    createRelatedPair();

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }),
    );

    const result = await enrichRelations(testDir, {
      dryRun: true,
      ollamaUrl: 'http://mock:11434',
      model: 'test-model',
    });

    expect(result.errors).toBe(1);
    expect(result.proposals).toHaveLength(0);
  });

  it('processes multiple related pairs in batches', async () => {
    const pair1 = createRelatedPair('batch-a');
    const pair2 = createRelatedPair('batch-b');
    const pair3 = createRelatedPair('batch-c');

    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount++;
      const types = ['extends', 'supports', 'caused_by'];
      return {
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            type: types[(callCount - 1) % 3],
            confidence: 0.9,
            reasoning: `classification ${callCount}`,
          }),
        }),
      } as Response;
    });

    const result = await enrichRelations(testDir, {
      dryRun: true,
      ollamaUrl: 'http://mock:11434',
      model: 'test-model',
      batchSize: 2,
    });

    expect(result.total_related).toBe(3);
    expect(result.proposals).toHaveLength(3);
    expect(callCount).toBe(3);
  });

  it('counts error for orphaned edge with missing source atom', async () => {
    const { sourceId, targetId } = createRelatedPair();

    // Delete the source atom file to create an orphaned edge
    const atoms = listAtoms(testDir);
    const source = atoms.find((a) => a.frontmatter.id === sourceId)!;
    fs.unlinkSync(source.filePath!);

    mockFetch(JSON.stringify({
      type: 'extends',
      confidence: 0.9,
      reasoning: 'test',
    }));

    const result = await enrichRelations(testDir, {
      dryRun: true,
      ollamaUrl: 'http://mock:11434',
      model: 'test-model',
    });

    expect(result.errors).toBe(1);
    expect(result.proposals).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // #118 — cap LLM reasoning field
  // ---------------------------------------------------------------------------

  it('caps an over-long reasoning field with a truncation marker (#118)', async () => {
    createRelatedPair();

    const longReasoning = 'X'.repeat(5000);
    mockFetch(JSON.stringify({
      type: 'extends',
      confidence: 0.9,
      reasoning: longReasoning,
    }));

    const result = await enrichRelations(testDir, {
      dryRun: true,
      ollamaUrl: 'http://mock:11434',
      model: 'test-model',
    });

    expect(result.proposals).toHaveLength(1);
    const reasoning = result.proposals[0].reasoning;
    // Truncated body of MAX_REASONING_LEN chars + the marker, so total length
    // is bounded but a little above MAX_REASONING_LEN. Stay well under the
    // original 5000.
    expect(reasoning.length).toBeLessThan(longReasoning.length);
    expect(reasoning.length).toBeLessThanOrEqual(MAX_REASONING_LEN + 32);
    expect(reasoning).toMatch(/truncated/);
    // The kept prefix should be exactly MAX_REASONING_LEN of the original.
    expect(reasoning.slice(0, MAX_REASONING_LEN)).toBe('X'.repeat(MAX_REASONING_LEN));
  });

  it('preserves short reasoning verbatim (no truncation marker) (#118)', async () => {
    createRelatedPair();

    const shortReasoning = 'source elaborates target concept';
    mockFetch(JSON.stringify({
      type: 'extends',
      confidence: 0.9,
      reasoning: shortReasoning,
    }));

    const result = await enrichRelations(testDir, {
      dryRun: true,
      ollamaUrl: 'http://mock:11434',
      model: 'test-model',
    });

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].reasoning).toBe(shortReasoning);
  });

  it('handles apply-mode write failure gracefully', async () => {
    createRelatedPair();

    mockFetch(JSON.stringify({
      type: 'extends',
      confidence: 0.9,
      reasoning: 'test',
    }));

    // Make the ENTITIES directory read-only (r-x) so writeAtom fails on tmp file creation
    const entitiesDir = path.join(testDir, 'ENTITIES');
    fs.chmodSync(entitiesDir, 0o555);

    try {
      const result = await enrichRelations(testDir, {
        dryRun: false,
        ollamaUrl: 'http://mock:11434',
        model: 'test-model',
      });

      // Proposals are generated but write fails — applied should be 0
      expect(result.proposals).toHaveLength(1);
      expect(result.applied).toBe(0);
    } finally {
      // Restore permissions for cleanup
      fs.chmodSync(entitiesDir, 0o755);
    }
  });
});
