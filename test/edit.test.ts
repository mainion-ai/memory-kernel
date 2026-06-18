/**
 * #247 forward path — `mk edit` / editAtom emits provenanced human_edit events.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initMemoryDir, createAtom, listAtoms, closeAllIndexes } from '../src/index.js';
import { editAtom } from '../src/edit.js';
import { detectUnprovenancedWrites } from '../src/provenance.js';
import { readEvents } from '../src/event-log.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-edit-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

function makeAtom(body = 'Original body.') {
  return createAtom({
    memoryDir: testDir,
    agent_id: 'a',
    session_id: 's',
    type: 'fact',
    slug: 'editable-fact',
    body,
    confidence: 0.8,
    status: 'active',
    ttl_days: null,
  });
}

describe('editAtom — forward human_edit path', () => {
  it('emits a human_edit event with a diff summary when the file changes', () => {
    const id = makeAtom('Original body.').frontmatter.id;

    const result = editAtom({
      memoryDir: testDir,
      atomId: id,
      runEditor: (fp) => {
        const cur = fs.readFileSync(fp, 'utf-8');
        fs.writeFileSync(fp, cur + '\nAn extra hand-written line.\n');
      },
    });

    expect(result.changed).toBe(true);
    expect(result.hash_before).not.toBe(result.hash_after);
    expect(result.lines_added).toBeGreaterThan(0);

    const human = readEvents(testDir).filter((e) => e.action === 'human_edit');
    expect(human).toHaveLength(1);
    expect(human[0].atom_refs).toEqual([id]);
    expect(human[0].schema_version).toBe(2);
    expect(human[0].atom_snapshot).toBeTruthy();
    expect(human[0].meta?.source).toBe('mk edit');
    expect(human[0].meta?.hash_before).toBe(result.hash_before);
    expect(human[0].meta?.hash_after).toBe(result.hash_after);
  });

  it('is a no-op (no event) when the editor saves no changes', () => {
    const id = makeAtom().frontmatter.id;
    const before = readEvents(testDir).length;

    const result = editAtom({
      memoryDir: testDir,
      atomId: id,
      runEditor: () => {
        /* editor opened and closed without changes */
      },
    });

    expect(result.changed).toBe(false);
    expect(readEvents(testDir).length).toBe(before);
  });

  it('dry-run resolves the atom without launching the editor or emitting events', () => {
    const id = makeAtom().frontmatter.id;
    const before = readEvents(testDir).length;
    let launched = false;

    const result = editAtom({
      memoryDir: testDir,
      atomId: id,
      dryRun: true,
      runEditor: () => {
        launched = true;
      },
    });

    expect(launched).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.reason).toBe('dry-run');
    expect(readEvents(testDir).length).toBe(before);
  });

  it('throws (and emits no event) when the editor reports an error', () => {
    const id = makeAtom().frontmatter.id;
    const before = readEvents(testDir).length;
    expect(() =>
      editAtom({
        memoryDir: testDir,
        atomId: id,
        runEditor: () => {
          throw new Error('Editor "vi" terminated by signal SIGINT');
        },
      }),
    ).toThrow(/SIGINT/);
    // No human_edit recorded for an aborted edit.
    expect(readEvents(testDir).filter((e) => e.action === 'human_edit')).toHaveLength(0);
    expect(readEvents(testDir).length).toBe(before);
  });

  it('throws on an unknown atom id', () => {
    expect(() => editAtom({ memoryDir: testDir, atomId: 'NOPE-1', runEditor: () => {} })).toThrow(
      /Atom not found/,
    );
  });

  it('refuses to edit an encrypted (SECRET) atom directly', () => {
    const key = 'test-encryption-key-123';
    const prev = process.env.MEMORY_ENCRYPTION_KEY;
    process.env.MEMORY_ENCRYPTION_KEY = key;
    try {
      const id = createAtom({
        memoryDir: testDir,
        agent_id: 'a',
        session_id: 's',
        type: 'fact',
        slug: 'secret-fact',
        body: 'classified',
        confidence: 0.8,
        status: 'active',
        ttl_days: null,
        classification: 'SECRET',
      }).frontmatter.id;

      expect(() => editAtom({ memoryDir: testDir, atomId: id, runEditor: () => {} })).toThrow(
        /encrypted/i,
      );
    } finally {
      if (prev === undefined) delete process.env.MEMORY_ENCRYPTION_KEY;
      else process.env.MEMORY_ENCRYPTION_KEY = prev;
    }
  });

  it('records an edit the backward-detector will NOT re-flag (idempotency)', () => {
    const id = makeAtom('Original body.').frontmatter.id;

    editAtom({
      memoryDir: testDir,
      atomId: id,
      runEditor: (fp) => {
        const cur = fs.readFileSync(fp, 'utf-8');
        fs.writeFileSync(fp, cur.replace('Original body.', 'Corrected body.'));
      },
    });

    // After a forward edit, the human_edit snapshot matches disk, so reflect's
    // backward detection sees nothing new.
    const detected = detectUnprovenancedWrites(listAtoms(testDir), readEvents(testDir));
    expect(detected.find((d) => d.atom_id === id)).toBeUndefined();
  });
});
