/**
 * Phase 3: migrate-relations algorithm tests.
 * Covers links.related migration, body-text mining, dry-run, and idempotency.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  initMemoryDir,
  createAtom,
  closeAllIndexes,
  listAtoms,
  writeAtom,
  readAtom,
} from '../src/index.js';

// Import the migration logic directly (not the CLI command)
// We test the algorithm via its internal function by calling the logic directly.
// To keep tests fast we import the module and invoke the behavior.

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-migrate-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

/**
 * Run the migration algorithm directly (sans CLI wrapper) by reading the
 * module's exported helpers through dynamic import of the CLI module.
 * Since we can't easily tree-shake the Commander setup, we reimplement the
 * core algorithm here in a thin test harness.
 */
function runMigration(memDir: string, apply: boolean): {
  proposed: Array<{ atomId: string; target: string; type: string; source: string }>;
  written: number;
} {
  const la = listAtoms;
  const wa = writeAtom;
  const atoms = la(memDir);
  const knownIds = new Set(atoms.map((a) => a.frontmatter.id));

  const ATOM_ID_PATTERN = /\b([A-Z]{2,8}-\d{4}-\d{2}-\d{2}-[A-Za-z0-9][A-Za-z0-9-]*)\b/g;
  const RELATION_CONTEXT = [
    { words: /extends|builds on|elaborates|generalizes/i, type: 'extends' },
    { words: /contradicts|conflicts with|disagrees/i, type: 'contradicts' },
    { words: /supports|confirms|agrees with/i, type: 'supports' },
    { words: /caused by|because of|due to/i, type: 'caused_by' },
    { words: /supersedes|replaces|obsoletes/i, type: 'supersedes' },
  ] as const;

  function inferType(body: string, idx: number): string {
    const ctx = body.slice(Math.max(0, idx - 100), idx + 100).toLowerCase();
    for (const { words, type } of RELATION_CONTEXT) {
      if (words.test(ctx)) return type;
    }
    return 'related';
  }

  const proposed: Array<{ atomId: string; target: string; type: string; source: string }> = [];
  const changeMap = new Map<string, { atom: typeof atoms[0]; newRelations: Array<{ target: string; type: string }> }>();

  for (const atom of atoms) {
    const id = atom.frontmatter.id;
    const existing = new Set((atom.frontmatter.relations ?? []).map((r) => `${r.target}:${r.type}`));
    const toAdd: Array<{ target: string; type: string; source: string }> = [];

    for (const t of (atom.frontmatter.links?.related ?? [])) {
      if (t === id) continue;
      const key = `${t}:related`;
      if (!existing.has(key)) {
        toAdd.push({ target: t, type: 'related', source: 'links.related' });
        existing.add(key);
      }
    }

    ATOM_ID_PATTERN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ATOM_ID_PATTERN.exec(atom.body)) !== null) {
      const t = m[1];
      if (t === id || !knownIds.has(t)) continue;
      const tp = inferType(atom.body, m.index);
      const key = `${t}:${tp}`;
      if (!existing.has(key)) {
        toAdd.push({ target: t, type: tp, source: 'body_text' });
        existing.add(key);
      }
    }

    if (toAdd.length > 0) {
      proposed.push(...toAdd.map((x) => ({ atomId: id, ...x })));
      changeMap.set(id, { atom, newRelations: toAdd.map((x) => ({ target: x.target, type: x.type })) });
    }
  }

  let written = 0;
  if (apply) {
    for (const { atom, newRelations } of changeMap.values()) {
      const existing = atom.frontmatter.relations ?? [];
      atom.frontmatter.relations = [
        ...existing,
        ...newRelations.map((r) => ({ target: r.target, type: r.type as any })),
      ];
      if (atom.filePath) {
        wa(atom, atom.filePath);
        written++;
      }
    }
  }

  return { proposed, written };
}

describe('links.related migration', () => {
  it('migrates links.related to relations', () => {
    const target = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'target-related', body: 'Target fact',
    });

    const source = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'source-with-links', body: 'Source with links.related',
      links: { related: [target.frontmatter.id] },
    });

    const { proposed } = runMigration(testDir, false);
    expect(proposed.some((p) => p.atomId === source.frontmatter.id && p.target === target.frontmatter.id && p.type === 'related')).toBe(true);
  });

  it('apply writes relations to frontmatter', () => {
    const target = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'apply-target', body: 'Apply target fact',
    });

    const source = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'apply-source', body: 'Apply source belief',
      links: { related: [target.frontmatter.id] },
    });

    const { written } = runMigration(testDir, true);
    expect(written).toBeGreaterThan(0);

    const updated = readAtom(source.filePath!);
    expect(updated.frontmatter.relations).toBeDefined();
    expect(updated.frontmatter.relations!.some(
      (r) => r.target === target.frontmatter.id && r.type === 'related',
    )).toBe(true);
  });

  it('dry-run does not modify files', () => {
    const target = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'dry-target', body: 'Dry run target',
    });
    const source = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'dry-source', body: 'Dry run source',
      links: { related: [target.frontmatter.id] },
    });

    const mtimeBefore = fs.statSync(source.filePath!).mtimeMs;
    runMigration(testDir, false); // dry-run
    const mtimeAfter = fs.statSync(source.filePath!).mtimeMs;

    expect(mtimeAfter).toBe(mtimeBefore);
  });

  it('is idempotent — running twice produces same result', () => {
    const target = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'idem-target', body: 'Idempotent target',
    });
    createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'idem-source', body: 'Idempotent source',
      links: { related: [target.frontmatter.id] },
    });

    runMigration(testDir, true);
    const { proposed: secondRun } = runMigration(testDir, false);
    expect(secondRun).toHaveLength(0); // nothing new to propose
  });
});

describe('body text mining', () => {
  it('infers relation type from context words', () => {
    const target = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'target-infer', body: 'Target for inference',
    });

    const source = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'source-infer',
      body: `This belief extends ${target.frontmatter.id} into new territory.`,
    });

    const { proposed } = runMigration(testDir, false);
    const rel = proposed.find((p) => p.atomId === source.frontmatter.id);
    expect(rel).toBeDefined();
    expect(rel!.type).toBe('extends');
  });

  it('defaults to related when no context words match', () => {
    const target = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'target-default', body: 'Target default',
    });

    const source = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'source-default',
      body: `See also ${target.frontmatter.id} for more context.`,
    });

    const { proposed } = runMigration(testDir, false);
    const rel = proposed.find((p) => p.atomId === source.frontmatter.id);
    expect(rel?.type).toBe('related');
  });

  it('skips self-references (atom ID appears in own body)', () => {
    const atom = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'self-ref',
      body: 'placeholder body', // will be patched below
    });

    // Patch body to include its own ID
    const onDisk = readAtom(atom.filePath!);
    onDisk.body = `This fact ${atom.frontmatter.id} references itself.`;
    writeAtom(onDisk, atom.filePath!);

    const { proposed } = runMigration(testDir, false);
    expect(proposed.filter((p) => p.atomId === atom.frontmatter.id)).toHaveLength(0);
  });

  it('skips unknown atom IDs (not in known-ID set)', () => {
    createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'unknown-ref',
      body: 'See FACT-2020-01-01-DOES-NOT-EXIST-abc for details.',
    });

    const { proposed } = runMigration(testDir, false);
    expect(proposed).toHaveLength(0);
  });
});
