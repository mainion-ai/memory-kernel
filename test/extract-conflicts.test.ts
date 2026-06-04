import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Command } from 'commander';
import {
  initMemoryDir, closeAllIndexes, openIndex,
} from '../src/index.js';
import { getTriplesForAtom } from '../src/triples.js';
import { extractFromLog } from '../src/extract.js';
import { readAtom, getRelationsForAtom, createAtom } from '../src/index.js';
import { insertTriples } from '../src/triples.js';
import { registerExtractCommand } from '../src/cli/extract.js';

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

describe('extractFromLog — auto-supersede integration', () => {
  it('supersedes an existing atom when the new atom conflicts and is newer', async () => {
    // Seed an older atom with a triple
    const oldAtom = createAtom({
      memoryDir: testDir, agent_id: 'seed', session_id: 'seed',
      type: 'fact', slug: 'old-cap', body: 'France capital is Lyon.',
    });
    insertTriples(testDir, oldAtom.frontmatter.id, [
      { subject: 'France', predicate: 'has_capital', object: 'Lyon' },
    ]);

    // Wait so created_at clearly differs
    await new Promise((res) => setTimeout(res, 1100));

    // First fetch response: the extraction LLM returns a new conflicting atom + triple
    // Second fetch response: the Tier-2 confirmer says "yes, conflict"
    const candidates = [{
      type: 'fact',
      slug: 'new-cap',
      title: 'France capital',
      body: '## Fact\nFrance capital is Paris.',
      tags: [],
      confidence: 1.0,
      triples: [{ subject: 'France', predicate: 'has_capital', object: 'Paris' }],
    }];
    mockOllamaSequence([
      JSON.stringify(candidates),
      '{"conflict": true, "reason": "different capitals"}',
    ]);

    const r = await extractFromLog({
      logPath: logFile,
      memoryDir: testDir,
      model: 'qwen2.5:14b',
    });

    expect(r.extracted).toBe(1);
    expect(r.conflicts).toBe(1);

    // Old atom marked superseded
    const reReadOld = readAtom(oldAtom.filePath!);
    expect(reReadOld.frontmatter.status).toBe('superseded');

    // New atom got the relation
    const newAtomId = r.atoms[0].atom_id!;
    const { outbound } = getRelationsForAtom(testDir, newAtomId);
    expect(outbound.some((rel) => rel.target_id === oldAtom.frontmatter.id && rel.relation_type === 'supersedes')).toBe(true);

    // Per-atom conflict info surfaced in the result
    expect(r.atoms[0].conflicts).toBeDefined();
    expect(r.atoms[0].conflicts).toHaveLength(1);
    expect(r.atoms[0].conflicts![0].action).toBe('superseded');
  });

  it('does not run conflict detection when conflictDetect=false', async () => {
    const oldAtom = createAtom({
      memoryDir: testDir, agent_id: 'seed', session_id: 'seed',
      type: 'fact', slug: 'old-cap', body: 'France capital is Lyon.',
    });
    insertTriples(testDir, oldAtom.frontmatter.id, [
      { subject: 'France', predicate: 'has_capital', object: 'Lyon' },
    ]);
    await new Promise((res) => setTimeout(res, 1100));

    const candidates = [{
      type: 'fact', slug: 'new-cap', title: 't',
      body: '## Fact\nFrance capital is Paris.',
      tags: [], confidence: 1.0,
      triples: [{ subject: 'France', predicate: 'has_capital', object: 'Paris' }],
    }];
    mockOllamaSequence([JSON.stringify(candidates)]);

    const r = await extractFromLog({
      logPath: logFile,
      memoryDir: testDir,
      model: 'qwen2.5:14b',
      conflictDetect: false,
    });

    expect(r.conflicts).toBe(0);
    expect(r.atoms[0].conflicts).toBeUndefined();
    const reReadOld = readAtom(oldAtom.filePath!);
    expect(reReadOld.frontmatter.status).not.toBe('superseded');
  });

  it('dry-run skips conflict detection entirely', async () => {
    const oldAtom = createAtom({
      memoryDir: testDir, agent_id: 'seed', session_id: 'seed',
      type: 'fact', slug: 'old-cap', body: 'France capital is Lyon.',
    });
    insertTriples(testDir, oldAtom.frontmatter.id, [
      { subject: 'France', predicate: 'has_capital', object: 'Lyon' },
    ]);
    await new Promise((res) => setTimeout(res, 1100));

    const candidates = [{
      type: 'fact', slug: 'new-cap', title: 't',
      body: '## Fact\nFrance capital is Paris.',
      tags: [], confidence: 1.0,
      triples: [{ subject: 'France', predicate: 'has_capital', object: 'Paris' }],
    }];
    // Only one mocked response (the extraction LLM); Tier-2 should NOT be called.
    mockOllamaSequence([JSON.stringify(candidates)]);

    const r = await extractFromLog({
      logPath: logFile,
      memoryDir: testDir,
      model: 'qwen2.5:14b',
      dryRun: true,
    });

    expect(r.extracted).toBe(1);
    expect(r.conflicts).toBe(0);
    expect(r.atoms[0].conflicts).toBeUndefined();

    // Old atom remains active — no side-effects from dry-run
    const reReadOld = readAtom(oldAtom.filePath!);
    expect(reReadOld.frontmatter.status).not.toBe('superseded');
  });
});

describe('mk extract CLI — conflict flags', () => {
  it('registers --no-conflict-detect and --conflict-confirm-model options', () => {
    const prog = new Command();
    registerExtractCommand(prog);
    const extractCmd = prog.commands.find((c) => c.name() === 'extract')!;
    const optNames = extractCmd.options.map((o) => o.long);
    expect(optNames).toContain('--no-conflict-detect');
    expect(optNames).toContain('--conflict-confirm-model');
  });
});
