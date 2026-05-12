/**
 * Tests for `mk supersede` (src/cli/supersede.ts).
 *
 * Covers the pure `supersedeAtoms()` entry point: happy path, idempotency,
 * partial-state recovery, V2 event format, path-traversal guard, and dry-run.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  initMemoryDir,
  createAtom,
  readAtom,
  writeAtom,
  closeAllIndexes,
  openIndex,
  readEvents,
  getRelationsForAtom,
} from '../src/index.js';
import { supersedeAtoms } from '../src/cli/supersede.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-supersede-'));
  initMemoryDir(testDir);
  openIndex(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

function mkAtom(slug: string, body: string) {
  return createAtom({
    memoryDir: testDir,
    agent_id: 'test',
    session_id: 'test',
    type: 'fact',
    slug,
    body,
  });
}

describe('supersedeAtoms — happy path', () => {
  it('marks old atom superseded and adds supersedes relation on new atom', () => {
    const oldAtom = mkAtom('old-fact', 'The old fact');
    const newAtom = mkAtom('new-fact', 'The new fact');

    const result = supersedeAtoms({
      memoryDir: testDir,
      oldAtomId: oldAtom.frontmatter.id,
      newAtomId: newAtom.frontmatter.id,
    });

    expect(result.changed).toBe(true);
    expect(result.old_status_changed).toBe(true);
    expect(result.relation_added).toBe(true);

    const reReadOld = readAtom(oldAtom.filePath!);
    expect(reReadOld.frontmatter.status).toBe('superseded');

    const reReadNew = readAtom(newAtom.filePath!);
    expect(reReadNew.frontmatter.relations).toEqual([
      { target: oldAtom.frontmatter.id, type: 'supersedes' },
    ]);
  });

  it('refreshes updated_at on both atoms to match the supersede event timestamp', () => {
    const oldAtom = mkAtom('a', 'a body');
    const newAtom = mkAtom('b', 'b body');

    supersedeAtoms({
      memoryDir: testDir,
      oldAtomId: oldAtom.frontmatter.id,
      newAtomId: newAtom.frontmatter.id,
    });

    const events = readEvents(testDir).filter(
      (e) => e.action === 'atom_updated' && e.meta?.operation === 'supersede',
    );
    expect(events).toHaveLength(2);

    const reReadOld = readAtom(oldAtom.filePath!);
    const reReadNew = readAtom(newAtom.filePath!);

    // updated_at must be at least as recent as the original; with second-precision
    // timestamps it may equal the create time, but it must be present and well-formed.
    expect(reReadOld.frontmatter.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(reReadNew.frontmatter.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(reReadOld.frontmatter.updated_at >= oldAtom.frontmatter.updated_at).toBe(true);
    expect(reReadNew.frontmatter.updated_at >= newAtom.frontmatter.updated_at).toBe(true);

    // The snapshot stored in the event must reflect the same updated_at — proof
    // the snapshot was taken after the mutation, not before.
    const oldEvent = events.find((e) => e.atom_refs?.[0] === oldAtom.frontmatter.id);
    expect((oldEvent as any).atom_snapshot).toContain(`updated_at: "${reReadOld.frontmatter.updated_at}"`);
  });

  it('emits two V2 atom_updated events with snapshots', () => {
    const oldAtom = mkAtom('old', 'old body');
    const newAtom = mkAtom('new', 'new body');

    supersedeAtoms({
      memoryDir: testDir,
      oldAtomId: oldAtom.frontmatter.id,
      newAtomId: newAtom.frontmatter.id,
      agent_id: 'pytest',
      session_id: 'sess-1',
    });

    const events = readEvents(testDir).filter(
      (e) => e.action === 'atom_updated' && e.meta?.operation === 'supersede',
    );
    expect(events).toHaveLength(2);

    for (const e of events) {
      expect((e as any).schema_version).toBe(2);
      expect(typeof (e as any).atom_snapshot).toBe('string');
      expect((e as any).atom_snapshot.length).toBeGreaterThan(0);
      expect(e.agent_id).toBe('pytest');
      expect(e.session_id).toBe('sess-1');
    }

    const oldEvent = events.find((e) => e.atom_refs?.[0] === oldAtom.frontmatter.id);
    const newEvent = events.find((e) => e.atom_refs?.[0] === newAtom.frontmatter.id);
    expect(oldEvent?.meta?.role).toBe('old');
    expect(newEvent?.meta?.role).toBe('new');
  });

  it('re-indexes both atoms (relations table reflects the new supersedes edge)', () => {
    const oldAtom = mkAtom('old-idx', 'old idx');
    const newAtom = mkAtom('new-idx', 'new idx');

    supersedeAtoms({
      memoryDir: testDir,
      oldAtomId: oldAtom.frontmatter.id,
      newAtomId: newAtom.frontmatter.id,
    });

    const { outbound } = getRelationsForAtom(testDir, newAtom.frontmatter.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].target_id).toBe(oldAtom.frontmatter.id);
    expect(outbound[0].relation_type).toBe('supersedes');
  });
});

describe('supersedeAtoms — validation', () => {
  it('throws on self-supersede', () => {
    const atom = mkAtom('self', 'self body');
    expect(() =>
      supersedeAtoms({
        memoryDir: testDir,
        oldAtomId: atom.frontmatter.id,
        newAtomId: atom.frontmatter.id,
      }),
    ).toThrow(/Cannot supersede/);
  });

  it('throws when old atom is missing', () => {
    const newAtom = mkAtom('present', 'present body');
    expect(() =>
      supersedeAtoms({
        memoryDir: testDir,
        oldAtomId: 'FACT-2020-01-01-ABSENT-zzz',
        newAtomId: newAtom.frontmatter.id,
      }),
    ).toThrow(/Old atom not found/);
  });

  it('throws when new atom is missing', () => {
    const oldAtom = mkAtom('present', 'present body');
    expect(() =>
      supersedeAtoms({
        memoryDir: testDir,
        oldAtomId: oldAtom.frontmatter.id,
        newAtomId: 'FACT-2020-01-01-ABSENT-zzz',
      }),
    ).toThrow(/New atom not found/);
  });
});

describe('supersedeAtoms — idempotency', () => {
  it('second invocation is a no-op when both halves are already applied', () => {
    const oldAtom = mkAtom('o', 'o body');
    const newAtom = mkAtom('n', 'n body');

    supersedeAtoms({
      memoryDir: testDir,
      oldAtomId: oldAtom.frontmatter.id,
      newAtomId: newAtom.frontmatter.id,
    });

    const result2 = supersedeAtoms({
      memoryDir: testDir,
      oldAtomId: oldAtom.frontmatter.id,
      newAtomId: newAtom.frontmatter.id,
    });

    expect(result2.changed).toBe(false);
    expect(result2.old_status_changed).toBe(false);
    expect(result2.relation_added).toBe(false);

    // No extra events emitted on the second call.
    const supersedeEvents = readEvents(testDir).filter(
      (e) => e.action === 'atom_updated' && e.meta?.operation === 'supersede',
    );
    expect(supersedeEvents).toHaveLength(2);
  });

  it('repairs missing relation when old atom is already superseded but relation was lost', () => {
    const oldAtom = mkAtom('o', 'o body');
    const newAtom = mkAtom('n', 'n body');

    // Simulate a partial-state crash: old atom marked superseded, new atom
    // never received its supersedes relation.
    const o = readAtom(oldAtom.filePath!);
    o.frontmatter.status = 'superseded';
    writeAtom(o, oldAtom.filePath!);

    const result = supersedeAtoms({
      memoryDir: testDir,
      oldAtomId: oldAtom.frontmatter.id,
      newAtomId: newAtom.frontmatter.id,
    });

    expect(result.changed).toBe(true);
    expect(result.old_status_changed).toBe(false);
    expect(result.relation_added).toBe(true);

    const reReadNew = readAtom(newAtom.filePath!);
    expect(reReadNew.frontmatter.relations).toEqual([
      { target: oldAtom.frontmatter.id, type: 'supersedes' },
    ]);

    // Only one event for the new-atom half should be emitted.
    const supersedeEvents = readEvents(testDir).filter(
      (e) => e.action === 'atom_updated' && e.meta?.operation === 'supersede',
    );
    expect(supersedeEvents).toHaveLength(1);
    expect(supersedeEvents[0].meta?.role).toBe('new');
  });

  it('repairs missing status when relation is present but old atom is still active', () => {
    const oldAtom = mkAtom('o', 'o body');
    const newAtom = mkAtom('n', 'n body');

    // Simulate the reverse partial state: relation exists, status not flipped.
    const n = readAtom(newAtom.filePath!);
    n.frontmatter.relations = [{ target: oldAtom.frontmatter.id, type: 'supersedes' }];
    writeAtom(n, newAtom.filePath!);

    const result = supersedeAtoms({
      memoryDir: testDir,
      oldAtomId: oldAtom.frontmatter.id,
      newAtomId: newAtom.frontmatter.id,
    });

    expect(result.changed).toBe(true);
    expect(result.old_status_changed).toBe(true);
    expect(result.relation_added).toBe(false);

    const reReadOld = readAtom(oldAtom.filePath!);
    expect(reReadOld.frontmatter.status).toBe('superseded');
  });
});

describe('supersedeAtoms — dry-run', () => {
  it('reports planned changes without writing files or emitting events', () => {
    const oldAtom = mkAtom('o', 'o body');
    const newAtom = mkAtom('n', 'n body');
    const oldSnapshot = fs.readFileSync(oldAtom.filePath!, 'utf-8');
    const newSnapshot = fs.readFileSync(newAtom.filePath!, 'utf-8');
    const eventsBefore = readEvents(testDir).length;

    const result = supersedeAtoms({
      memoryDir: testDir,
      oldAtomId: oldAtom.frontmatter.id,
      newAtomId: newAtom.frontmatter.id,
      dryRun: true,
    });

    expect(result.changed).toBe(true);
    expect(result.old_status_changed).toBe(true);
    expect(result.relation_added).toBe(true);
    expect(result.reason).toBe('dry-run');

    expect(fs.readFileSync(oldAtom.filePath!, 'utf-8')).toBe(oldSnapshot);
    expect(fs.readFileSync(newAtom.filePath!, 'utf-8')).toBe(newSnapshot);
    expect(readEvents(testDir).length).toBe(eventsBefore);
  });
});

describe('supersedeAtoms — path traversal guard', () => {
  it('refuses to operate when an index entry points outside memoryDir', () => {
    const newAtom = mkAtom('n', 'n body');

    // Write a sibling memory tree, then poke its file path into our index
    // for an attacker-controlled ID. assertWithinDir should reject it.
    const evilDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-evil-'));
    initMemoryDir(evilDir);
    const evilAtom = createAtom({
      memoryDir: evilDir,
      agent_id: 't',
      session_id: 't',
      type: 'fact',
      slug: 'evil',
      body: 'evil body',
    });

    const db = openIndex(testDir);
    db.prepare(
      'INSERT OR REPLACE INTO atoms (atom_id, type, status, confidence, classification, created_at, updated_at, file_path, body_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'FACT-2020-01-01-EVIL-aaa',
      'fact',
      'active',
      1,
      'INTERNAL',
      '2020-01-01T00:00:00Z',
      '2020-01-01T00:00:00Z',
      evilAtom.filePath!,
      'deadbeef',
    );

    expect(() =>
      supersedeAtoms({
        memoryDir: testDir,
        oldAtomId: 'FACT-2020-01-01-EVIL-aaa',
        newAtomId: newAtom.frontmatter.id,
      }),
    ).toThrow(/outside|escape|directory/i);

    closeAllIndexes();
    fs.rmSync(evilDir, { recursive: true, force: true });
  });
});
