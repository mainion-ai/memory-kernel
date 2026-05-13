import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  initMemoryDir, closeAllIndexes, openIndex,
} from '../src/index.js';
import { getTriplesForAtom } from '../src/triples.js';
import { extractFromLog } from '../src/extract.js';

let testDir: string;
let logFile: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-extract-conflicts-'));
  initMemoryDir(testDir);
  openIndex(testDir);
  logFile = path.join(testDir, 'log.txt');
  fs.writeFileSync(logFile, 'conversation content', 'utf-8');
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function mockOllamaSequence(responses: string[]) {
  let i = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
    ok: true,
    json: async () => ({ response: responses[i++] ?? responses[responses.length - 1] }),
  } as Response));
}

describe('extractFromLog — triples persistence', () => {
  it('persists triples returned by the extraction LLM', async () => {
    const candidates = [{
      type: 'fact',
      slug: 'capital-france',
      title: 'France capital',
      body: '## Fact\nFrance capital is Paris.',
      tags: [],
      confidence: 1.0,
      triples: [{ subject: 'France', predicate: 'has_capital', object: 'Paris' }],
    }];
    mockOllamaSequence([JSON.stringify(candidates)]);

    const r = await extractFromLog({
      logPath: logFile,
      memoryDir: testDir,
      model: 'qwen2.5:14b',
    });
    expect(r.extracted).toBe(1);
    const atomId = r.atoms[0].atom_id!;
    const triples = getTriplesForAtom(testDir, atomId);
    expect(triples).toHaveLength(1);
    expect(triples[0].object).toBe('paris');
  });

  it('accepts an extraction with no triples field (back-compat)', async () => {
    const candidates = [{
      type: 'fact',
      slug: 'no-triples',
      title: 't',
      body: '## Fact\nno triples here',
      tags: [],
      confidence: 1.0,
    }];
    mockOllamaSequence([JSON.stringify(candidates)]);

    const r = await extractFromLog({
      logPath: logFile, memoryDir: testDir, model: 'qwen2.5:14b',
    });
    expect(r.extracted).toBe(1);
    const atomId = r.atoms[0].atom_id!;
    expect(getTriplesForAtom(testDir, atomId)).toHaveLength(0);
  });
});
