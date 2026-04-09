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
import { enrichRelations } from '../src/enrich-relations.js';

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

/** Helper: create two atoms with a "related" edge between them. */
function createRelatedPair(): { sourceId: string; targetId: string } {
  const target = createAtom({
    memoryDir: testDir,
    agent_id: 'test', session_id: 'test',
    type: 'belief', slug: 'target-notation',
    body: 'Notation systems shape cognitive boundaries. Writing is a form of thinking.',
  });
  const source = createAtom({
    memoryDir: testDir,
    agent_id: 'test', session_id: 'test',
    type: 'belief', slug: 'source-erasure',
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
});
