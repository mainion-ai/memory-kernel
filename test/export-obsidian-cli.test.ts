/**
 * #358 — coverage for `src/cli/export-obsidian.ts`.
 *
 * `transformAtom` previously had only the CodeQL YAML-escape regression tests;
 * its classification/tags/relations/wikilink-resolution branches and the
 * `export-obsidian` command happy path were uncovered. These are characterization
 * tests of the current behaviour (no behaviour change).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initMemoryDir, createAtom, listAtoms, closeAllIndexes } from '../src/index.js';
import { transformAtom } from '../src/cli/export-obsidian.js';
import type { Atom } from '../src/types.js';

const CLI = path.resolve('dist/cli/mk.js');

let testDir: string;

function mk(...args: string[]): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      encoding: 'utf-8',
      timeout: 15000,
      env: { ...process.env, NODE_NO_WARNINGS: '1', HOME: testDir, USERPROFILE: testDir },
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return { stdout: err.stdout ?? '', exitCode: err.status ?? 1 };
  }
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-export-obs-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('transformAtom', () => {
  function sampleAtom(overrides: Partial<Atom> = {}): Atom {
    createAtom({
      memoryDir: testDir,
      type: 'decision',
      slug: 'pick-vitest',
      body: 'We chose vitest.',
      agent_id: 'a',
      session_id: 's',
      scope: { tags: ['testing', 'tooling'] },
      relations: [{ type: 'supports', target: 'FACT-2026-01-01-OTHER-xyz' }],
    });
    const atom = listAtoms(testDir)[0]!;
    return { ...atom, ...overrides };
  }

  it('emits a stable filename and the core frontmatter keys', () => {
    const atom = sampleAtom();
    const { filename, content } = transformAtom(atom, new Set([atom.frontmatter.id]));
    expect(filename).toBe(`${atom.frontmatter.id}.md`);
    expect(content).toContain(`id: ${atom.frontmatter.id}`);
    expect(content).toContain('type: decision');
    expect(content).toContain('status: active');
  });

  it('promotes scope.tags to a top-level YAML list', () => {
    const atom = sampleAtom();
    const { content } = transformAtom(atom, new Set([atom.frontmatter.id]));
    expect(content).toMatch(/tags:\n {2}- testing\n {2}- tooling/);
  });

  it('emits the classification key (createAtom defaults to TEAM)', () => {
    const atom = sampleAtom();
    const { content } = transformAtom(atom, new Set([atom.frontmatter.id]));
    expect(content).toContain('classification: TEAM');
  });

  it('renders a ## Relations section with wikilinks and counts them', () => {
    const atom = sampleAtom();
    const { content, wikilinkCount } = transformAtom(atom, new Set([atom.frontmatter.id]));
    expect(content).toContain('## Relations');
    expect(content).toContain('- supports [[FACT-2026-01-01-OTHER-xyz]]');
    expect(wikilinkCount).toBeGreaterThanOrEqual(1);
  });

  // ATOM_ID_PATTERN only captures the uppercase TYPE-DATE-SLUG portion (it stops
  // at the lowercase hash suffix), so body references resolve against knownIds by
  // exact/prefix match on that captured portion.
  it('wraps an exact-match body id as a wikilink (resolveAtomId exact branch)', () => {
    const atom = sampleAtom({ body: 'see FACT-2026-01-01-OTHER here' });
    const { content } = transformAtom(atom, new Set(['FACT-2026-01-01-OTHER']));
    expect(content).toContain('[[FACT-2026-01-01-OTHER]]');
  });

  it('resolves a captured partial id to the unique full known id (prefix branch)', () => {
    const atom = sampleAtom({ body: 'see FACT-2026-01-01-OTHER for context' });
    const { content } = transformAtom(atom, new Set(['FACT-2026-01-01-OTHER-xyz']));
    // prefix-unique → resolved to the full id (incl. the lowercase hash suffix)
    expect(content).toContain('[[FACT-2026-01-01-OTHER-xyz]]');
  });

  it('leaves an unknown body id as-is (no-match branch, still wikilinked)', () => {
    const atom = sampleAtom({ body: 'see FACT-2026-01-01-GHOST elsewhere' });
    const { content } = transformAtom(atom, new Set(['FACT-2026-01-01-OTHER-xyz']));
    expect(content).toContain('[[FACT-2026-01-01-GHOST]]');
  });

  it('resolves a body id when the known id (slug) is a prefix of it (slug-match branch)', () => {
    // Case 2 of resolveAtomId: the body has the full conceptual name and the
    // known id is a hash-suffixed truncation of it. The known slug (id minus the
    // -hash suffix) must be >20 chars and a prefix of the captured partial.
    const knownId = 'FACT-2026-01-01-NOTATIONERASUREPROFILE-ab12';
    const atom = sampleAtom({ body: 'ref FACT-2026-01-01-NOTATIONERASUREPROFILE-DETAIL here' });
    const { content } = transformAtom(atom, new Set([knownId]));
    expect(content).toContain(`[[${knownId}]]`);
  });
});

describe('mk export-obsidian (subprocess)', () => {
  function seed() {
    createAtom({ memoryDir: testDir, type: 'fact', slug: 'paris', body: 'Capital is Paris.', agent_id: 'a', session_id: 's' });
    createAtom({ memoryDir: testDir, type: 'decision', slug: 'gone', body: 'Old.', agent_id: 'a', session_id: 's', status: 'archived' });
    closeAllIndexes();
  }

  it('exports active atoms to the vault + writes .obsidian/graph.json', () => {
    seed();
    const out = path.join(testDir, 'vault');
    const { exitCode, stdout } = mk('export-obsidian', '--out', out, '-d', testDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Exported');
    // archived excluded by default → only the fact file present
    const files = fs.readdirSync(out).filter((f) => f.endsWith('.md'));
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^FACT-/);
    expect(fs.existsSync(path.join(out, '.obsidian', 'graph.json'))).toBe(true);
  });

  it('--include-archived includes the archived atom', () => {
    seed();
    const out = path.join(testDir, 'vault-all');
    const { exitCode } = mk('export-obsidian', '--out', out, '-d', testDir, '--include-archived');
    expect(exitCode).toBe(0);
    const files = fs.readdirSync(out).filter((f) => f.endsWith('.md'));
    expect(files.length).toBe(2);
  });

  it('--json emits a structured summary', () => {
    seed();
    const out = path.join(testDir, 'vault-json');
    const { exitCode, stdout } = mk('export-obsidian', '--out', out, '-d', testDir, '--json');
    expect(exitCode).toBe(0);
    const summary = JSON.parse(stdout.trim());
    expect(summary.exported).toBe(1);
    expect(summary.output_dir).toContain('vault-json');
    expect(typeof summary.wikilinks).toBe('number');
  });
});
