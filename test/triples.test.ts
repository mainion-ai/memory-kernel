import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { EntityTriple } from '../src/types.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initMemoryDir, openIndex, closeAllIndexes } from '../src/index.js';
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

  it('does not return the atom as its own candidate', () => {
    openIndex(testDir);
    const a = createAtom({ ...base(testDir), type: 'fact', slug: 'self', body: 'Y is Z.' });
    insertTriples(testDir, a.frontmatter.id, [{ subject: 'Y', predicate: 'is', object: 'Z' }]);
    expect(findCandidateConflicts(testDir, a.frontmatter.id)).toHaveLength(0);
  });
});
