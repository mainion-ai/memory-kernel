/**
 * Direct coverage for src/store.ts low-level exports (#104).
 *
 * Existing tests cover writeAtom/readAtom and 0o600 permissions
 * (test/store-file-permissions.test.ts) plus integration via createAtom.
 * This file pins direct unit coverage for the three exports that
 * the system review flagged as transitively-only tested:
 *   - assertWithinDir  (security boundary — symlink/traversal/edge cases)
 *   - writeFileAtomic  (mode arg, directory creation, error cleanup)
 *   - escapeXmlBoundary  (prompt-injection helper)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  assertWithinDir,
  writeFileAtomic,
  escapeXmlBoundary,
  initMemoryDir,
} from '../src/store.js';
import { closeAllIndexes } from '../src/index-db.js';

const isPosix = process.platform !== 'win32';
const itPosix = isPosix ? it : it.skip;

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-store-direct-'));
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('assertWithinDir — accepted paths', () => {
  it('allows the root directory itself', () => {
    expect(() => assertWithinDir(testDir, testDir)).not.toThrow();
  });

  it('allows a direct child file path', () => {
    const child = path.join(testDir, 'ENTITIES', 'atom.md');
    expect(() => assertWithinDir(testDir, child)).not.toThrow();
  });

  it('allows a deeply nested child path that does not yet exist', () => {
    const deep = path.join(testDir, 'a', 'b', 'c', 'file.md');
    expect(() => assertWithinDir(testDir, deep)).not.toThrow();
  });
});

describe('assertWithinDir — rejected paths', () => {
  it('rejects a relative ../ traversal that escapes the root', () => {
    const escape = path.join(testDir, '..', 'outside.md');
    expect(() => assertWithinDir(testDir, escape)).toThrow(
      /Path traversal denied/,
    );
  });

  it('rejects an absolute path completely outside the root', () => {
    expect(() => assertWithinDir(testDir, '/tmp/somewhere-else.md')).toThrow(
      /Path traversal denied/,
    );
  });

  it('rejects a sibling directory whose name shares the root prefix', () => {
    // root = /tmp/.../mk-store-direct-XYZ
    // attacker = /tmp/.../mk-store-direct-XYZsibling
    // Without the trailing-separator check, startsWith() would falsely accept.
    const sibling = testDir + 'sibling';
    fs.mkdirSync(sibling, { recursive: true });
    try {
      expect(() => assertWithinDir(testDir, sibling)).toThrow(
        /Path traversal denied/,
      );
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });

  itPosix('rejects a symlink inside the root that points outside the root', () => {
    // Build the layout:
    //   testDir/ENTITIES/ (real)
    //   /tmp/mk-out-...   (the target the symlink will point at)
    //   testDir/ENTITIES/escape -> /tmp/mk-out-...
    fs.mkdirSync(path.join(testDir, 'ENTITIES'), { recursive: true });
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-out-'));
    const symlinkPath = path.join(testDir, 'ENTITIES', 'escape');
    fs.symlinkSync(outsideDir, symlinkPath);
    try {
      expect(() => assertWithinDir(testDir, symlinkPath)).toThrow(
        /Path traversal denied/,
      );
    } finally {
      try { fs.unlinkSync(symlinkPath); } catch { /* best-effort */ }
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe('writeFileAtomic', () => {
  it('creates parent directories that do not exist yet', () => {
    const target = path.join(testDir, 'deep', 'nested', 'file.txt');
    writeFileAtomic(target, 'hello');
    expect(fs.readFileSync(target, 'utf-8')).toBe('hello');
  });

  it('overwrites an existing file with new content (atomic rename)', () => {
    const target = path.join(testDir, 'file.txt');
    writeFileAtomic(target, 'first');
    writeFileAtomic(target, 'second');
    expect(fs.readFileSync(target, 'utf-8')).toBe('second');
  });

  itPosix('applies an explicit mode argument (POSIX)', () => {
    const target = path.join(testDir, 'restricted.txt');
    writeFileAtomic(target, 'secret', 0o600);
    const mode = fs.statSync(target).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('writes empty content correctly', () => {
    const target = path.join(testDir, 'empty.txt');
    writeFileAtomic(target, '');
    expect(fs.readFileSync(target, 'utf-8')).toBe('');
  });

  it('leaves no stray .tmp.* files in the parent directory on success', () => {
    const dir = path.join(testDir, 'staging');
    const target = path.join(dir, 'final.txt');
    writeFileAtomic(target, 'payload');
    const entries = fs.readdirSync(dir);
    expect(entries.some((e) => e.includes('.tmp.'))).toBe(false);
    expect(entries).toContain('final.txt');
  });

  itPosix('cleans up tmp file when rename fails (target is a non-empty directory)', () => {
    // Create a directory at the target path; renameSync over a non-empty
    // directory fails on POSIX. The catch block should unlink the tmp file.
    const target = path.join(testDir, 'collision');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'occupant.txt'), 'taken');
    expect(() => writeFileAtomic(target, 'payload')).toThrow();
    // No .tmp.* files should remain in the parent (best-effort cleanup ran).
    const stray = fs
      .readdirSync(testDir)
      .filter((e) => e.startsWith('collision.tmp.'));
    expect(stray).toEqual([]);
  });
});

describe('escapeXmlBoundary', () => {
  it('escapes < and > to HTML entities', () => {
    expect(escapeXmlBoundary('<tag>')).toBe('&lt;tag&gt;');
  });

  it('leaves &, single-quote, and double-quote untouched (LLM-prompt scope, not HTML)', () => {
    const input = `a & b 'c' "d"`;
    expect(escapeXmlBoundary(input)).toBe(input);
  });

  it('handles strings with multiple boundary chars and surrounding text', () => {
    const input = 'before </close-tag> after <open-tag> end';
    expect(escapeXmlBoundary(input)).toBe(
      'before &lt;/close-tag&gt; after &lt;open-tag&gt; end',
    );
  });

  it('returns empty string unchanged', () => {
    expect(escapeXmlBoundary('')).toBe('');
  });

  it('is idempotent on already-escaped output for the boundary chars', () => {
    // Note: the escaper is not designed to be unescape-aware. Re-running it
    // simply re-escapes the `&` would be untouched — verify that no second
    // pass over already-escaped output adds garbage.
    const once = escapeXmlBoundary('<x>');
    expect(escapeXmlBoundary(once)).toBe('&lt;x&gt;'); // & is NOT escaped
  });
});

describe('assertWithinDir — used by initMemoryDir + writeView/readView indirectly', () => {
  it('works for a freshly-initialized memory directory layout', () => {
    initMemoryDir(testDir);
    // All canonical subdirs and view files should pass the boundary check.
    for (const child of [
      'ENTITIES',
      'EPISODES',
      'EVIDENCE',
      'CONFLICTS',
      'ARCHIVE',
      'INDEX.md',
      'HANDOFF.md',
      'events.ndjson',
    ]) {
      expect(() =>
        assertWithinDir(testDir, path.join(testDir, child)),
      ).not.toThrow();
    }
  });
});
