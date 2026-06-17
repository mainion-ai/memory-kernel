/**
 * entity_triples durability (#370).
 *
 * Triples are LLM-extracted and not serialized into atom markdown, so the
 * SQLite index used to be their only home — deleting `.memory-index.db` lost
 * them permanently. A durable NDJSON sidecar (`triples.ndjson`) now mirrors
 * every insert and lets `reindex` rebuild `entity_triples` from disk.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  initMemoryDir,
  createAtom,
  openIndex,
  reindex,
  insertTriples,
  getTriplesForAtom,
  closeAllIndexes,
} from '../src/index.js';
import {
  triplesSidecarPath,
  readTriplesSidecar,
  writeTriplesSidecar,
} from '../src/triples-sidecar.js';
import type { EntityTriple } from '../src/types.js';

const AGENT = 'test-agent';
const SESSION = 'test-session';
let testDir: string;

const base = (dir: string) => ({ memoryDir: dir, agent_id: AGENT, session_id: SESSION });
const dbPath = (dir: string) => path.join(dir, '.memory-index.db');

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-triples-'));
  initMemoryDir(testDir);
  openIndex(testDir); // required so createAtom/insertTriples actually index
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('triples sidecar — read/write round trip', () => {
  it('writes and reads back rows; skips malformed lines', () => {
    const rows: EntityTriple[] = [
      { atom_id: 'FACT-X', subject: 'a', predicate: 'b', object: 'c', confidence: 1, created_at: '2026-01-01T00:00:00Z' },
    ];
    writeTriplesSidecar(testDir, rows);
    expect(readTriplesSidecar(testDir)).toEqual(rows);

    // A corrupt trailing line must not break the reader (resilience parity with readEvents).
    fs.appendFileSync(triplesSidecarPath(testDir), 'not json\n');
    expect(readTriplesSidecar(testDir)).toEqual(rows);
  });

  it('removes the sidecar file when written empty', () => {
    writeTriplesSidecar(testDir, [{ atom_id: 'A', subject: 's', predicate: 'p', object: 'o', confidence: 1, created_at: 't' }]);
    expect(fs.existsSync(triplesSidecarPath(testDir))).toBe(true);
    writeTriplesSidecar(testDir, []);
    expect(fs.existsSync(triplesSidecarPath(testDir))).toBe(false);
  });
});

describe('insertTriples — mirrors into the sidecar', () => {
  it('appends each inserted (normalized) triple to triples.ndjson', () => {
    const atom = createAtom({ ...base(testDir), type: 'fact', slug: 'france', body: 'France capital is Paris' });
    insertTriples(testDir, atom.frontmatter.id, [{ subject: 'France', predicate: 'has_capital', object: 'Paris' }]);

    const side = readTriplesSidecar(testDir);
    expect(side).toHaveLength(1);
    expect(side[0].atom_id).toBe(atom.frontmatter.id);
    expect(side[0].subject).toBe('france'); // normalized lower-case, matching the DB row
    expect(side[0].object).toBe('paris');
  });
});

// #138 parity: the sidecar holds triple content extracted from possibly
// SECRET-classified atoms, so it must be owner-only like events.ndjson / atoms,
// not world/group-readable at the platform default.
const itPosix = process.platform === 'win32' ? it.skip : it;
const mode = (p: string) => fs.statSync(p).mode & 0o777;

describe('triples sidecar — file permissions (0o600)', () => {
  itPosix('append path creates the sidecar 0o600', () => {
    const atom = createAtom({ ...base(testDir), type: 'fact', slug: 'france', body: 'France capital is Paris' });
    insertTriples(testDir, atom.frontmatter.id, [{ subject: 'France', predicate: 'has_capital', object: 'Paris' }]);
    expect(mode(triplesSidecarPath(testDir))).toBe(0o600);
  });

  itPosix('atomic rewrite keeps the sidecar 0o600', () => {
    writeTriplesSidecar(testDir, [
      { atom_id: 'A', subject: 's', predicate: 'p', object: 'o', confidence: 1, created_at: 't' },
    ]);
    expect(mode(triplesSidecarPath(testDir))).toBe(0o600);
  });
});

describe('reindex — rebuilds triples from the sidecar', () => {
  it('restores triples after the index file is deleted (the #370 gap)', () => {
    const atom = createAtom({ ...base(testDir), type: 'fact', slug: 'france', body: 'France capital is Paris' });
    insertTriples(testDir, atom.frontmatter.id, [{ subject: 'France', predicate: 'has_capital', object: 'Paris' }]);

    closeAllIndexes();
    fs.rmSync(dbPath(testDir)); // the previously-unrecoverable action
    expect(fs.existsSync(dbPath(testDir))).toBe(false);

    reindex(testDir);

    const triples = getTriplesForAtom(testDir, atom.frontmatter.id);
    expect(triples).toHaveLength(1);
    expect(triples[0].subject).toBe('france');
    expect(triples[0].object).toBe('paris');
  });

  it('backfills the sidecar for an old store that has table triples but no sidecar', () => {
    const atom = createAtom({ ...base(testDir), type: 'fact', slug: 'france', body: 'France capital is Paris' });
    insertTriples(testDir, atom.frontmatter.id, [{ subject: 'France', predicate: 'has_capital', object: 'Paris' }]);

    // Simulate a pre-#370 store: index has the triples, but no sidecar exists.
    fs.rmSync(triplesSidecarPath(testDir));
    expect(fs.existsSync(triplesSidecarPath(testDir))).toBe(false);

    reindex(testDir);

    expect(fs.existsSync(triplesSidecarPath(testDir))).toBe(true);
    expect(readTriplesSidecar(testDir)).toHaveLength(1);
    expect(getTriplesForAtom(testDir, atom.frontmatter.id)).toHaveLength(1);
  });

  it('prunes triples whose atom no longer exists', () => {
    const atom = createAtom({ ...base(testDir), type: 'fact', slug: 'france', body: 'France capital is Paris' });
    insertTriples(testDir, atom.frontmatter.id, [{ subject: 'France', predicate: 'has_capital', object: 'Paris' }]);

    fs.rmSync(atom.filePath!); // atom gone from disk → dropped on reindex

    reindex(testDir);

    expect(getTriplesForAtom(testDir, atom.frontmatter.id)).toHaveLength(0);
    expect(readTriplesSidecar(testDir).some((r) => r.atom_id === atom.frontmatter.id)).toBe(false);
  });
});

// #379 — the reconcile must be a UNION over existing atoms, not all-or-nothing.
// Before the fix, recovery was gated on the whole table being empty, so a table
// that was a non-empty SUBSET of the durable sidecar (partial DB row loss, or an
// atom transiently missing during reindex) skipped recovery AND truncated the
// sidecar to the smaller table set — silent data loss from the durable layer.
describe('reindex — union reconcile (#379)', () => {
  it('recovers sidecar-only triples for still-existing atoms (table subset of sidecar)', () => {
    const a = createAtom({ ...base(testDir), type: 'fact', slug: 'france', body: 'France capital is Paris' });
    const b = createAtom({ ...base(testDir), type: 'fact', slug: 'spain', body: 'Spain capital is Madrid' });
    insertTriples(testDir, a.frontmatter.id, [{ subject: 'France', predicate: 'has_capital', object: 'Paris' }]);
    insertTriples(testDir, b.frontmatter.id, [{ subject: 'Spain', predicate: 'has_capital', object: 'Madrid' }]);

    // Both atoms still exist on disk and in the sidecar, but simulate partial DB
    // row loss: drop B's row from the table only. The sidecar still has A + B.
    const db = openIndex(testDir);
    db.prepare('DELETE FROM entity_triples WHERE atom_id = ?').run(b.frontmatter.id);
    expect(getTriplesForAtom(testDir, b.frontmatter.id)).toHaveLength(0);
    expect(readTriplesSidecar(testDir).filter((r) => r.atom_id === b.frontmatter.id)).toHaveLength(1);

    reindex(testDir);

    // B's triple is recovered from the sidecar into the table, and A's survives.
    expect(getTriplesForAtom(testDir, a.frontmatter.id)).toHaveLength(1);
    expect(getTriplesForAtom(testDir, b.frontmatter.id)).toHaveLength(1);
    const side = readTriplesSidecar(testDir);
    expect(side.filter((r) => r.atom_id === a.frontmatter.id)).toHaveLength(1);
    expect(side.filter((r) => r.atom_id === b.frontmatter.id)).toHaveLength(1);
  });

  it('collapses duplicate (atom_id,s,p,o) rows across table+sidecar to one', () => {
    const a = createAtom({ ...base(testDir), type: 'fact', slug: 'france', body: 'France capital is Paris' });
    // Two identical inserts → the append-only sidecar and the no-UNIQUE table
    // each accumulate two identical rows.
    insertTriples(testDir, a.frontmatter.id, [{ subject: 'France', predicate: 'has_capital', object: 'Paris' }]);
    insertTriples(testDir, a.frontmatter.id, [{ subject: 'France', predicate: 'has_capital', object: 'Paris' }]);
    expect(getTriplesForAtom(testDir, a.frontmatter.id)).toHaveLength(2);
    expect(readTriplesSidecar(testDir)).toHaveLength(2);

    reindex(testDir);

    expect(getTriplesForAtom(testDir, a.frontmatter.id)).toHaveLength(1);
    expect(readTriplesSidecar(testDir)).toHaveLength(1);
  });
});
