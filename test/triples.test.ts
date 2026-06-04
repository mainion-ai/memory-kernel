import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { EntityTriple } from '../src/types.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initMemoryDir, openIndex, closeAllIndexes, reindex } from '../src/index.js';
import { insertTriples, getTriplesForAtom, findCandidateConflicts } from '../src/triples.js';
import { createAtom } from '../src/index.js';

const base = (dir: string) => ({ memoryDir: dir, agent_id: 'test', session_id: 'test' });

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-triples-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('EntityTriple type', () => {
  it('accepts a well-formed triple', () => {
    const t: EntityTriple = {
      atom_id: 'FACT-2026-05-13-CAPITAL-abc12',
      subject: 'France',
      predicate: 'has_capital',
      object: 'Paris',
      confidence: 0.95,
      created_at: '2026-05-13T00:00:00Z',
    };
    expect(t.subject).toBe('France');
    expect(t.predicate).toBe('has_capital');
    expect(t.object).toBe('Paris');
  });
});

describe('entity_triples schema', () => {
  it('creates entity_triples table on first open', () => {
    const db = openIndex(testDir);
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='entity_triples'",
    ).get();
    expect(row).toBeDefined();
  });

  it('entity_triples has expected columns', () => {
    const db = openIndex(testDir);
    const cols = db.prepare("PRAGMA table_info('entity_triples')").all() as { name: string }[];
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(['atom_id', 'confidence', 'created_at', 'object', 'predicate', 'subject', 'triple_id']);
  });

  it('schema version is 8', () => {
    const db = openIndex(testDir);
    const ver = db.pragma('user_version', { simple: true }) as number;
    expect(ver).toBe(8);
  });
});

describe('triples — insert and read', () => {
  it('insertTriples writes rows and getTriplesForAtom reads them back', () => {
    openIndex(testDir);
    const atom = createAtom({ ...base(testDir), type: 'fact', slug: 'cap-fr', body: 'France capital is Paris.' });
    insertTriples(testDir, atom.frontmatter.id, [
      { subject: 'France', predicate: 'has_capital', object: 'Paris', confidence: 0.95 },
    ]);
    const got = getTriplesForAtom(testDir, atom.frontmatter.id);
    expect(got).toHaveLength(1);
    expect(got[0].subject).toBe('france');         // lower-cased
    expect(got[0].predicate).toBe('has_capital');
    expect(got[0].object).toBe('paris');
    expect(got[0].confidence).toBeCloseTo(0.95);
  });

  it('insertTriples is a no-op for empty input', () => {
    openIndex(testDir);
    const atom = createAtom({ ...base(testDir), type: 'fact', slug: 'noop', body: 'no triples' });
    insertTriples(testDir, atom.frontmatter.id, []);
    expect(getTriplesForAtom(testDir, atom.frontmatter.id)).toHaveLength(0);
  });

  it('insertTriples skips rows with blank subject/predicate/object', () => {
    openIndex(testDir);
    const atom = createAtom({ ...base(testDir), type: 'fact', slug: 'blanks', body: 'has blanks' });
    insertTriples(testDir, atom.frontmatter.id, [
      { subject: '', predicate: 'is', object: 'X' },          // blank subject — skip
      { subject: 'A', predicate: '', object: 'X' },           // blank predicate — skip
      { subject: 'A', predicate: 'is', object: '' },          // blank object — skip
      { subject: 'A', predicate: 'is', object: 'B' },         // valid — keep
    ]);
    const got = getTriplesForAtom(testDir, atom.frontmatter.id);
    expect(got).toHaveLength(1);
    expect(got[0].object).toBe('b');
  });
});

describe('triples — Tier 1 candidate matching', () => {
  it('findCandidateConflicts returns atom_ids with same (s,p) and different object', () => {
    openIndex(testDir);
    const oldAtom = createAtom({ ...base(testDir), type: 'fact', slug: 'old-cap', body: 'France capital is Lyon.' });
    insertTriples(testDir, oldAtom.frontmatter.id, [
      { subject: 'France', predicate: 'has_capital', object: 'Lyon' },
    ]);
    const newAtom = createAtom({ ...base(testDir), type: 'fact', slug: 'new-cap', body: 'France capital is Paris.' });
    insertTriples(testDir, newAtom.frontmatter.id, [
      { subject: 'France', predicate: 'has_capital', object: 'Paris' },
    ]);

    const candidates = findCandidateConflicts(testDir, newAtom.frontmatter.id);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].old_atom_id).toBe(oldAtom.frontmatter.id);
    expect(candidates[0].new_triple.object).toBe('paris');
    expect(candidates[0].old_triple.object).toBe('lyon');
  });

  it('returns empty when the object agrees', () => {
    openIndex(testDir);
    const a = createAtom({ ...base(testDir), type: 'fact', slug: 'a', body: 'France capital is Paris.' });
    const b = createAtom({ ...base(testDir), type: 'fact', slug: 'b', body: 'France capital is Paris.' });
    insertTriples(testDir, a.frontmatter.id, [{ subject: 'France', predicate: 'has_capital', object: 'Paris' }]);
    insertTriples(testDir, b.frontmatter.id, [{ subject: 'France', predicate: 'has_capital', object: 'Paris' }]);
    expect(findCandidateConflicts(testDir, b.frontmatter.id)).toHaveLength(0);
  });

  it('excludes superseded and archived atoms from candidates', () => {
    openIndex(testDir);
    const oldAtom = createAtom({ ...base(testDir), type: 'fact', slug: 'old', body: 'X is A.' });
    insertTriples(testDir, oldAtom.frontmatter.id, [{ subject: 'X', predicate: 'is', object: 'A' }]);
    // Mark old atom as superseded directly via index update
    const db = openIndex(testDir);
    db.prepare("UPDATE atoms SET status = 'superseded' WHERE atom_id = ?").run(oldAtom.frontmatter.id);

    const newAtom = createAtom({ ...base(testDir), type: 'fact', slug: 'new', body: 'X is B.' });
    insertTriples(testDir, newAtom.frontmatter.id, [{ subject: 'X', predicate: 'is', object: 'B' }]);
    expect(findCandidateConflicts(testDir, newAtom.frontmatter.id)).toHaveLength(0);
  });

  it('excludes expired atoms from candidates', () => {
    openIndex(testDir);
    const oldAtom = createAtom({ ...base(testDir), type: 'fact', slug: 'expired-old', body: 'X is A.' });
    insertTriples(testDir, oldAtom.frontmatter.id, [{ subject: 'X', predicate: 'is', object: 'A' }]);
    const db = openIndex(testDir);
    db.prepare("UPDATE atoms SET status = 'expired' WHERE atom_id = ?").run(oldAtom.frontmatter.id);

    const newAtom = createAtom({ ...base(testDir), type: 'fact', slug: 'expired-new', body: 'X is B.' });
    insertTriples(testDir, newAtom.frontmatter.id, [{ subject: 'X', predicate: 'is', object: 'B' }]);
    expect(findCandidateConflicts(testDir, newAtom.frontmatter.id)).toHaveLength(0);
  });

  it('does not return the atom as its own candidate', () => {
    openIndex(testDir);
    const a = createAtom({ ...base(testDir), type: 'fact', slug: 'self', body: 'Y is Z.' });
    insertTriples(testDir, a.frontmatter.id, [{ subject: 'Y', predicate: 'is', object: 'Z' }]);
    expect(findCandidateConflicts(testDir, a.frontmatter.id)).toHaveLength(0);
  });

  it('returns one row per matching old triple when an old atom has multiple matches', () => {
    openIndex(testDir);
    const oldAtom = createAtom({ ...base(testDir), type: 'fact', slug: 'multi-old', body: 'multi-triple atom' });
    insertTriples(testDir, oldAtom.frontmatter.id, [
      { subject: 'France', predicate: 'has_capital', object: 'Lyon' },
      { subject: 'France', predicate: 'has_capital', object: 'Marseille' },
    ]);
    const newAtom = createAtom({ ...base(testDir), type: 'fact', slug: 'multi-new', body: 'new fact' });
    insertTriples(testDir, newAtom.frontmatter.id, [
      { subject: 'France', predicate: 'has_capital', object: 'Paris' },
    ]);

    const candidates = findCandidateConflicts(testDir, newAtom.frontmatter.id);
    expect(candidates).toHaveLength(2);
    const oldObjects = candidates.map((c) => c.old_triple.object).sort();
    expect(oldObjects).toEqual(['lyon', 'marseille']);
    expect(candidates.every((c) => c.old_atom_id === oldAtom.frontmatter.id)).toBe(true);
  });

  it('matches case-insensitively across atoms (both sides normalized at insert)', () => {
    openIndex(testDir);
    const oldAtom = createAtom({ ...base(testDir), type: 'fact', slug: 'mixed-old', body: 'mixed case old' });
    insertTriples(testDir, oldAtom.frontmatter.id, [
      { subject: 'FRANCE', predicate: 'Has_Capital', object: 'lyon' },     // upper subject, mixed predicate
    ]);
    const newAtom = createAtom({ ...base(testDir), type: 'fact', slug: 'mixed-new', body: 'lower case new' });
    insertTriples(testDir, newAtom.frontmatter.id, [
      { subject: 'france', predicate: 'has_capital', object: 'PARIS' },    // lower subject, upper object
    ]);

    const candidates = findCandidateConflicts(testDir, newAtom.frontmatter.id);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].old_triple.object).toBe('lyon');
    expect(candidates[0].new_triple.object).toBe('paris');
  });
});

describe('triples — fuzzy-arm candidate cap', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-fuzzy-'));
    initMemoryDir(testDir);
  });

  afterEach(() => {
    closeAllIndexes();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('caps fuzzy-arm candidates at FUZZY_CANDIDATE_LIMIT (currently 20)', () => {
    openIndex(testDir);

    // Seed 30 atoms that all share a high-cardinality predicate ("is_a") with
    // distinct subjects and objects — exactly the shape that used to fan out to
    // O(N) candidates before the cap was added.
    for (let i = 0; i < 30; i++) {
      const atom = createAtom({
        ...base(testDir),
        type: 'fact',
        slug: `noise-${i}`,
        body: `noise atom ${i}`,
      });
      insertTriples(testDir, atom.frontmatter.id, [
        { subject: `entity_${i}`, predicate: 'is_a', object: `category_${i}` },
      ]);
    }

    // The probe atom uses the same predicate with yet another subject/object;
    // the exact arm won't match (subjects differ), so all candidates come from
    // the fuzzy arm.
    const newAtom = createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'fuzzy-probe',
      body: 'probe',
    });
    insertTriples(testDir, newAtom.frontmatter.id, [
      { subject: 'entity_new', predicate: 'is_a', object: 'category_new' },
    ]);

    const candidates = findCandidateConflicts(testDir, newAtom.frontmatter.id);

    // Without the cap this would be 30. With LIMIT 20 it must be at most 20.
    expect(candidates.length).toBeLessThanOrEqual(20);
    expect(candidates.length).toBeGreaterThan(0);
  });
});

describe('triples — reindex preservation', () => {
  it('preserves triples across reindex (atoms still exist)', () => {
    openIndex(testDir);
    const atom = createAtom({ ...base(testDir), type: 'fact', slug: 'preserve', body: 'France capital is Paris.' });
    insertTriples(testDir, atom.frontmatter.id, [
      { subject: 'France', predicate: 'has_capital', object: 'Paris', confidence: 0.9 },
      { subject: 'Paris', predicate: 'in', object: 'France' },
    ]);
    expect(getTriplesForAtom(testDir, atom.frontmatter.id)).toHaveLength(2);

    reindex(testDir);

    const got = getTriplesForAtom(testDir, atom.frontmatter.id);
    expect(got).toHaveLength(2);
    const objects = got.map((t) => t.object).sort();
    expect(objects).toEqual(['france', 'paris']);
  });

  it('reindex drops triples whose atom has been removed', () => {
    openIndex(testDir);
    const atom = createAtom({ ...base(testDir), type: 'fact', slug: 'orphan', body: 'X is Y.' });
    insertTriples(testDir, atom.frontmatter.id, [{ subject: 'X', predicate: 'is', object: 'Y' }]);

    // Delete the atom file (but leave the index row temporarily) — reindex must
    // rebuild from files, so the orphaned triple should not survive.
    const fp = atom.filePath;
    if (fp) fs.rmSync(fp);

    reindex(testDir);
    expect(getTriplesForAtom(testDir, atom.frontmatter.id)).toHaveLength(0);
  });

  it('Tier-1 candidate matching still works after reindex', () => {
    openIndex(testDir);
    const oldAtom = createAtom({ ...base(testDir), type: 'fact', slug: 't1-old', body: 'France capital is Lyon.' });
    insertTriples(testDir, oldAtom.frontmatter.id, [
      { subject: 'France', predicate: 'has_capital', object: 'Lyon' },
    ]);
    const newAtom = createAtom({ ...base(testDir), type: 'fact', slug: 't1-new', body: 'France capital is Paris.' });
    insertTriples(testDir, newAtom.frontmatter.id, [
      { subject: 'France', predicate: 'has_capital', object: 'Paris' },
    ]);

    reindex(testDir);

    const candidates = findCandidateConflicts(testDir, newAtom.frontmatter.id);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].old_atom_id).toBe(oldAtom.frontmatter.id);
  });
});

describe('triples — public API surface', () => {
  it('is re-exported from src/index.ts', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.insertTriples).toBe('function');
    expect(typeof mod.getTriplesForAtom).toBe('function');
    expect(typeof mod.findCandidateConflicts).toBe('function');
  });
});
