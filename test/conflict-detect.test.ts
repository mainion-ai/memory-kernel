import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initMemoryDir, closeAllIndexes, openIndex } from '../src/index.js';
import { confirmConflictWithLLM } from '../src/conflict-detect.js';

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
