/**
 * Integration tests for SECRET atom encryption.
 * Verifies that SECRET atoms are stored encrypted on disk and in the event log,
 * and that TEAM atoms remain plaintext.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  initMemoryDir,
  createAtom,
  updateAtom,
  archiveAtom,
  readAtom,
  readEvents,
  listAtoms,
  closeAllIndexes,
} from '../src/index.js';
import { isEncrypted } from '../src/crypto.js';

const TEST_KEY = 'c0ffee00'.repeat(8); // 64-char hex (32 bytes)

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-enc-'));
  initMemoryDir(testDir);
  process.env.MEMORY_ENCRYPTION_KEY = TEST_KEY;
});

afterEach(() => {
  delete process.env.MEMORY_ENCRYPTION_KEY;
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('SECRET atom encryption at rest', () => {
  it('stores SECRET atom as encrypted content on disk', () => {
    const atom = createAtom({
      memoryDir: testDir,
      agent_id: 'test',
      session_id: 'test',
      type: 'fact',
      slug: 'secret-thing',
      body: 'This is confidential.',
      classification: 'SECRET',
    });
    const rawContent = fs.readFileSync(atom.filePath!, 'utf-8');
    expect(isEncrypted(rawContent)).toBe(true);
    expect(rawContent).not.toContain('This is confidential.');
  });

  it('TEAM atom is stored as plaintext', () => {
    const atom = createAtom({
      memoryDir: testDir,
      agent_id: 'test',
      session_id: 'test',
      type: 'fact',
      slug: 'public-thing',
      body: 'This is not secret.',
      classification: 'TEAM',
    });
    const rawContent = fs.readFileSync(atom.filePath!, 'utf-8');
    expect(isEncrypted(rawContent)).toBe(false);
    expect(rawContent).toContain('This is not secret.');
  });

  it('readAtom decrypts and returns correct atom', () => {
    const created = createAtom({
      memoryDir: testDir,
      agent_id: 'test',
      session_id: 'test',
      type: 'fact',
      slug: 'secret-read',
      body: 'Secret content here.',
      classification: 'SECRET',
    });
    const read = readAtom(created.filePath!);
    expect(read.frontmatter.id).toBe(created.frontmatter.id);
    expect(read.body).toBe('Secret content here.');
    expect(read.frontmatter.classification).toBe('SECRET');
  });

  it('atom_snapshot in event log is encrypted for SECRET atoms', () => {
    createAtom({
      memoryDir: testDir,
      agent_id: 'test',
      session_id: 'test',
      type: 'fact',
      slug: 'secret-event',
      body: 'Event snapshot must be encrypted.',
      classification: 'SECRET',
    });
    const events = readEvents(testDir);
    const createEvent = events.find((e) => e.action === 'atom_created');
    expect(createEvent).toBeDefined();
    expect(createEvent!.atom_snapshot).toBeDefined();
    expect(isEncrypted(createEvent!.atom_snapshot!)).toBe(true);
    expect(createEvent!.atom_snapshot).not.toContain('Event snapshot must be encrypted.');
  });

  it('TEAM atom_snapshot in event log is plaintext', () => {
    createAtom({
      memoryDir: testDir,
      agent_id: 'test',
      session_id: 'test',
      type: 'fact',
      slug: 'team-event',
      body: 'Team content.',
      classification: 'TEAM',
    });
    const events = readEvents(testDir);
    const createEvent = events.find((e) => e.action === 'atom_created');
    expect(createEvent).toBeDefined();
    expect(isEncrypted(createEvent!.atom_snapshot!)).toBe(false);
    expect(createEvent!.atom_snapshot).toContain('Team content.');
  });

  it('listAtoms returns both TEAM and SECRET atoms when key is set', () => {
    createAtom({ memoryDir: testDir, agent_id: 'a', session_id: 's', type: 'fact', slug: 'visible', body: 'Public', classification: 'TEAM' });
    createAtom({ memoryDir: testDir, agent_id: 'a', session_id: 's', type: 'fact', slug: 'hidden', body: 'Secret', classification: 'SECRET' });

    const atoms = listAtoms(testDir);
    expect(atoms).toHaveLength(2);
  });

  it('readAtom throws a clear error when MEMORY_ENCRYPTION_KEY is not set', () => {
    const atom = createAtom({
      memoryDir: testDir,
      agent_id: 'test',
      session_id: 'test',
      type: 'fact',
      slug: 'no-key',
      body: 'Needs key to read.',
      classification: 'SECRET',
    });
    delete process.env.MEMORY_ENCRYPTION_KEY;
    expect(() => readAtom(atom.filePath!)).toThrow('MEMORY_ENCRYPTION_KEY');
  });

  it('listAtoms skips SECRET atoms and logs warning when key is not set', () => {
    createAtom({ memoryDir: testDir, agent_id: 'a', session_id: 's', type: 'fact', slug: 'public', body: 'Public atom', classification: 'TEAM' });
    createAtom({ memoryDir: testDir, agent_id: 'a', session_id: 's', type: 'fact', slug: 'secret', body: 'Secret atom', classification: 'SECRET' });

    delete process.env.MEMORY_ENCRYPTION_KEY;
    const atoms = listAtoms(testDir);
    // Only the TEAM atom should be readable; SECRET atom is skipped with a warning
    expect(atoms).toHaveLength(1);
    expect(atoms[0].frontmatter.classification).toBe('TEAM');
  });

  it('updateAtom on SECRET atom keeps file encrypted and content correct', () => {
    const created = createAtom({
      memoryDir: testDir,
      agent_id: 'test',
      session_id: 'test',
      type: 'fact',
      slug: 'secret-update',
      body: 'Original secret content.',
      classification: 'SECRET',
    });
    const updated = updateAtom({
      memoryDir: testDir,
      agent_id: 'test',
      session_id: 'test',
      filePath: created.filePath!,
      updates: { confidence: 0.95 },
      body: 'Updated secret content.',
    });

    // File on disk must still be encrypted
    const rawContent = fs.readFileSync(created.filePath!, 'utf-8');
    expect(isEncrypted(rawContent)).toBe(true);
    expect(rawContent).not.toContain('Updated secret content.');

    // readAtom must return the updated content
    const read = readAtom(created.filePath!);
    expect(read.body).toBe('Updated secret content.');
    expect(read.frontmatter.confidence).toBe(0.95);
  });

  it('updateAtom event snapshot is encrypted for SECRET atoms', () => {
    const created = createAtom({
      memoryDir: testDir,
      agent_id: 'test',
      session_id: 'test',
      type: 'fact',
      slug: 'secret-upd-evt',
      body: 'Before update.',
      classification: 'SECRET',
    });
    updateAtom({
      memoryDir: testDir,
      agent_id: 'test',
      session_id: 'test',
      filePath: created.filePath!,
      updates: {},
      body: 'After update.',
    });

    const events = readEvents(testDir);
    const updateEvent = events.find((e) => e.action === 'atom_updated');
    expect(updateEvent).toBeDefined();
    expect(updateEvent!.atom_snapshot).toBeDefined();
    expect(isEncrypted(updateEvent!.atom_snapshot!)).toBe(true);
    expect(updateEvent!.atom_snapshot).not.toContain('After update.');
  });

  it('archiveAtom on SECRET atom encrypts archive file', () => {
    const created = createAtom({
      memoryDir: testDir,
      agent_id: 'test',
      session_id: 'test',
      type: 'fact',
      slug: 'secret-archive',
      body: 'Will be archived secretly.',
      classification: 'SECRET',
    });
    archiveAtom({
      memoryDir: testDir,
      agent_id: 'test',
      session_id: 'test',
      filePath: created.filePath!,
    });

    // Original file should be removed
    expect(fs.existsSync(created.filePath!)).toBe(false);

    // Archive file should exist and be encrypted
    const archivePath = path.join(testDir, 'ARCHIVE', path.basename(created.filePath!));
    expect(fs.existsSync(archivePath)).toBe(true);
    const rawContent = fs.readFileSync(archivePath, 'utf-8');
    expect(isEncrypted(rawContent)).toBe(true);
    expect(rawContent).not.toContain('Will be archived secretly.');
  });

  it('archiveAtom event snapshot is encrypted for SECRET atoms', () => {
    const created = createAtom({
      memoryDir: testDir,
      agent_id: 'test',
      session_id: 'test',
      type: 'fact',
      slug: 'secret-arch-evt',
      body: 'Archive event body.',
      classification: 'SECRET',
    });
    archiveAtom({
      memoryDir: testDir,
      agent_id: 'test',
      session_id: 'test',
      filePath: created.filePath!,
    });

    const events = readEvents(testDir);
    const archiveEvent = events.find((e) => e.action === 'atom_archived');
    expect(archiveEvent).toBeDefined();
    expect(archiveEvent!.atom_snapshot).toBeDefined();
    expect(isEncrypted(archiveEvent!.atom_snapshot!)).toBe(true);
    expect(archiveEvent!.atom_snapshot).not.toContain('Archive event body.');
  });
});
