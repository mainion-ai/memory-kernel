/**
 * PR-7 Bundle C: SECRET-classification file permissions.
 *
 * Defense-in-depth: SECRET atom files (markdown) and the SQLite index file
 * (which denormalizes atom IDs and tags that may reference SECRET atoms) are
 * chmoded to 0o600 so they are readable only by the owner. The default
 * fs.openSync mode is 0o666 masked by umask (typically 0o644 — world-readable).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { initMemoryDir } from '../src/store.js';
import { openIndex, closeAllIndexes } from '../src/index-db.js';
import { createAtom } from '../src/retain.js';

describe('SECRET-classification file permissions', () => {
  let memoryDir: string;

  beforeEach(() => {
    memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-perms-'));
    initMemoryDir(memoryDir);
    process.env.MEMORY_ENCRYPTION_KEY = 'test-passphrase-for-perms';
  });

  afterEach(() => {
    closeAllIndexes();
    delete process.env.MEMORY_ENCRYPTION_KEY;
    fs.rmSync(memoryDir, { recursive: true, force: true });
  });

  it('writes SECRET atom files with mode 0o600', () => {
    const atom = createAtom({
      memoryDir,
      agent_id: 'test',
      session_id: 'test',
      type: 'fact',
      slug: 'secret-perms',
      body: 'secret body',
      classification: 'SECRET',
    });
    const mode = fs.statSync(atom.filePath!).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('writes non-SECRET atom files with the default platform mode (different from SECRET)', () => {
    // Write one SECRET and one PUBLIC atom in the same test so we can compare
    // their modes directly. This is deterministic regardless of the host umask
    // (which would make a fixed-value assertion fragile under e.g. umask 0o077,
    // where the default open mode coincides with 0o600).
    const secretAtom = createAtom({
      memoryDir,
      agent_id: 'test',
      session_id: 'test',
      type: 'fact',
      slug: 'secret-distinguisher',
      body: 'secret body',
      classification: 'SECRET',
    });
    const publicAtom = createAtom({
      memoryDir,
      agent_id: 'test',
      session_id: 'test',
      type: 'fact',
      slug: 'public-distinguisher',
      body: 'public body',
      classification: 'PUBLIC',
    });
    const secretMode = fs.statSync(secretAtom.filePath!).mode & 0o777;
    const publicMode = fs.statSync(publicAtom.filePath!).mode & 0o777;
    expect(secretMode).toBe(0o600);
    // Regression guard: writeAtom must NOT force 0o600 on every write — only on SECRET.
    expect(publicMode).not.toBe(secretMode);
  });

  it('chmods the SQLite index file to 0o600 on openIndex', () => {
    const db = openIndex(memoryDir);
    expect(db).toBeDefined();
    const indexPath = path.join(memoryDir, '.memory-index.db');
    const mode = fs.statSync(indexPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
