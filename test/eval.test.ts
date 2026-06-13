/**
 * Tests for the `mk eval` engine (#300): fixture loading, scoring, expect_content
 * KNOWLEDGE grep, embed-mode resolution, exit-code mapping. FTS-only (no live API).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { initMemoryDir, createAtom, reindex, closeAllIndexes } from '../src/index.js';
import {
  loadFixtures,
  runFixture,
  runEval,
  resolveEmbed,
  exitCodeForEval,
  EvalError,
  DEFAULT_TOP_K,
  type EvalFixture,
} from '../src/eval.js';

let testDir: string;
let paginationId: string; // real id of the pagination fact (for hyphen-boundary match)
const base = (dir: string) => ({ memoryDir: dir, agent_id: 'a', session_id: 's' });

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-eval-'));
  initMemoryDir(testDir);
  // Deterministic FTS corpus.
  paginationId = createAtom({ ...base(testDir), type: 'fact', slug: 'pagination-api', body: 'Cursor-based pagination for the public API endpoint.', scope: { tags: ['api'] } }).frontmatter.id;
  createAtom({ ...base(testDir), type: 'decision', slug: 'file-first', body: 'Files are the source of truth; SQLite is a derived cache.', scope: { tags: ['arch'] } });
  createAtom({ ...base(testDir), type: 'preference', slug: 'comms', body: 'Nenad prefers direct, concise communication.', scope: { tags: ['prefs'] } });
  reindex(testDir);
});
afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

// --- loadFixtures ----------------------------------------------------------

describe('loadFixtures', () => {
  it('parses a valid YAML fixture (file)', () => {
    const fp = path.join(testDir, 'f.yaml');
    fs.writeFileSync(fp, 'threshold: 0.5\ntop_k: 3\nqueries:\n  - task: "pagination api"\n    expect: ["FACT-"]\n    cat: api\n');
    const fixtures = loadFixtures(fp);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0].name).toBe('f');
    expect(fixtures[0].threshold).toBe(0.5);
    expect(fixtures[0].top_k).toBe(3);
    expect(fixtures[0].queries[0].task).toBe('pagination api');
  });

  it('loads every *.yaml in a directory, sorted', () => {
    const dir = path.join(testDir, 'eval');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'b.yaml'), 'queries:\n  - task: x\n    expect: ["A"]\n');
    fs.writeFileSync(path.join(dir, 'a.yml'), 'queries:\n  - task: y\n    expect: ["B"]\n');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
    const fixtures = loadFixtures(dir);
    expect(fixtures.map((f) => f.name)).toEqual(['a', 'b']);
  });

  it('throws EvalError on a missing path', () => {
    expect(() => loadFixtures(path.join(testDir, 'nope.yaml'))).toThrow(EvalError);
  });

  it('throws EvalError on malformed / empty-queries fixtures', () => {
    const bad = path.join(testDir, 'bad.yaml');
    fs.writeFileSync(bad, 'queries: []\n');
    expect(() => loadFixtures(bad)).toThrow(/non-empty 'queries'/);
    const bad2 = path.join(testDir, 'bad2.yaml');
    fs.writeFileSync(bad2, 'queries:\n  - task: "no expect"\n');
    expect(() => loadFixtures(bad2)).toThrow(/expect/);
  });

  it('rejects an empty/blank expect entry (would match any atom) — #300 review', () => {
    const bad = path.join(testDir, 'empty.yaml');
    fs.writeFileSync(bad, 'queries:\n  - task: "q"\n    expect: [""]\n');
    expect(() => loadFixtures(bad)).toThrow(/empty\/blank/);
  });
});

// --- scoring (FTS-only) ----------------------------------------------------

describe('runFixture scoring (embed off / FTS)', () => {
  it('passes when an expected atom surfaces in top-K; fails when absent', async () => {
    const fixture: EvalFixture = {
      name: 'recall',
      queries: [
        { task: 'cursor pagination api', expect: [paginationId], cat: 'api' },      // should hit the pagination fact
        { task: 'totally unrelated quantum widget', expect: ['FACT-NOPE-XYZ'] }, // should miss
      ],
    };
    const r = await runFixture(testDir, fixture, { embed: 'off' });
    expect(r.total).toBe(2);
    expect(r.passed).toBe(1);
    expect(r.pass_rate).toBeCloseTo(0.5);
    expect(r.embed_used).toBe(false);
    expect(r.results[0].passed).toBe(true);
    expect(r.results[1].passed).toBe(false);
  });

  it('tolerant id match handles suffix drift (prefix expectation matches full id)', async () => {
    const atom = createAtom({ ...base(testDir), type: 'fact', slug: 'tls-standard', body: 'TLS 1.3 is the current transport security standard.', scope: { tags: ['sec'] } });
    reindex(testDir);
    const full = atom.frontmatter.id; // FACT-YYYY-MM-DD-TLS-STANDARD-<suffix>
    const prefix = full.replace(/-[a-z0-9]+$/, ''); // drop the random suffix
    const r = await runFixture(testDir, { name: 't', queries: [{ task: 'TLS transport security standard', expect: [prefix] }] }, { embed: 'off' });
    expect(r.results[0].passed).toBe(true);
  });

  it('ok flag respects threshold; --threshold (opts) overrides fixture', async () => {
    const fixture: EvalFixture = {
      name: 'thr',
      threshold: 1.0,
      queries: [
        { task: 'cursor pagination api', expect: [paginationId] },
        { task: 'totally unrelated quantum widget', expect: ['NOPE'] },
      ],
    };
    const strict = await runFixture(testDir, fixture, { embed: 'off' });
    expect(strict.pass_rate).toBeCloseTo(0.5);
    expect(strict.ok).toBe(false); // 0.5 < 1.0
    const lenient = await runFixture(testDir, fixture, { embed: 'off', threshold: 0.5 });
    expect(lenient.ok).toBe(true); // 0.5 >= 0.5 (opts override)
  });

  it('a degenerate type-prefix does NOT match every atom (#300 review footgun)', async () => {
    // "FACT-" used to match any fact via loose substring; hyphen-boundary match kills that.
    const r = await runFixture(testDir, { name: 'loose', queries: [{ task: 'cursor pagination api', expect: ['FACT-'] }] }, { embed: 'off' });
    expect(r.results[0].passed).toBe(false);
  });

  it('defaults top_k to 5 when unset', async () => {
    const r = await runFixture(testDir, { name: 'k', queries: [{ task: 'pagination', expect: [paginationId] }] }, { embed: 'off' });
    expect(r.top_k).toBe(DEFAULT_TOP_K);
  });
});

// --- expect_content (KNOWLEDGE grep) --------------------------------------

describe('expect_content KNOWLEDGE grep', () => {
  it('hits on content in KNOWLEDGE/**.md, misses when absent', async () => {
    const kdir = path.join(testDir, 'KNOWLEDGE');
    fs.mkdirSync(kdir, { recursive: true });
    fs.writeFileSync(path.join(kdir, 'wander.md'), '# How a wander session works\n\nSpreading activation over the tag graph.\n');
    const r = await runFixture(testDir, {
      name: 'kn',
      queries: [
        { expect_content: 'wander session', cat: 'KNOWLEDGE' },
        { expect_content: 'nonexistent-doc-topic', cat: 'KNOWLEDGE' },
      ],
    }, { embed: 'off' });
    expect(r.results[0].passed).toBe(true);
    expect(r.results[0].detail).toMatch(/wander\.md/);
    expect(r.results[1].passed).toBe(false);
  });
});

// --- embed-mode resolution -------------------------------------------------

describe('resolveEmbed', () => {
  const saved = process.env.EMBEDDING_PROVIDER;
  afterEach(() => { if (saved === undefined) delete process.env.EMBEDDING_PROVIDER; else process.env.EMBEDDING_PROVIDER = saved; });

  it("'off' is always false; 'on' is always true", () => {
    expect(resolveEmbed(testDir, 'off')).toBe(false);
    expect(resolveEmbed(testDir, 'on')).toBe(true);
  });
  it("'auto' is false with no provider key (deterministic / CI)", () => {
    delete process.env.EMBEDDING_PROVIDER;
    expect(resolveEmbed(testDir, 'auto')).toBe(false);
  });
});

// --- exit-code mapping -----------------------------------------------------

describe('exitCodeForEval + runEval', () => {
  it('0 when all fixtures pass, 1 when any fail', async () => {
    const pass: EvalFixture = { name: 'p', threshold: 0.5, queries: [{ task: 'cursor pagination api', expect: [paginationId] }] };
    const fail: EvalFixture = { name: 'f', threshold: 1.0, queries: [{ task: 'unrelated zzz', expect: ['NOPE'] }] };
    const allPass = await runEval(testDir, [pass], { embed: 'off' });
    expect(exitCodeForEval(allPass)).toBe(0);
    const mixed = await runEval(testDir, [pass, fail], { embed: 'off' });
    expect(exitCodeForEval(mixed)).toBe(1);
  });
});
