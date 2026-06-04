/**
 * Regression test for #86: archive basename collision.
 *
 * Pre-fix: src/reflect.ts used `path.basename(filePath)` as the archive
 * destination. Atoms with different IDs but the same basename (e.g. an atom
 * in CONFLICTS/foo.md and another in ENTITIES/foo.md) would silently
 * overwrite each other in ARCHIVE/. This can happen via manually-imported
 * files, hand-renamed atoms, or filesystem copy that bypasses normal API.
 *
 * Fix: prefix archive filename with the atom ID. Covers all three archive
 * call sites in src/reflect.ts (processExpiry, dedupById, body-content dedup).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  initMemoryDir,
  reflect,
  writeAtom,
  closeAllIndexes,
} from '../src';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-archive-collision-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

const base = () => ({
  memoryDir: testDir,
  agent_id: 'test-agent',
  session_id: 'test-session',
});

const sixtyDaysAgo = () =>
  new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');

describe('reflect — archive basename collision (#86)', () => {
  it('archives both atoms distinctly when a CONFLICTS/ file and an ENTITIES/ file share a basename', () => {
    const created = sixtyDaysAgo();
    const sharedBasename = 'collide-stem.md';

    // Atom A: type 'conflict' → lives in CONFLICTS/, basename "collide-stem.md"
    const atomA = {
      frontmatter: {
        id: 'CONF-2026-01-01-collide-stem-aaa',
        type: 'conflict' as const,
        status: 'active' as const,
        confidence: 0.8,
        ttl_days: 30,
        created_at: created,
        updated_at: created,
      },
      body: 'Atom A (conflict-typed, in CONFLICTS/)',
      filePath: path.join(testDir, 'CONFLICTS', sharedBasename),
    };

    // Atom B: type 'fact' with ttl_days=1 → lives in ENTITIES/, same basename
    const atomB = {
      frontmatter: {
        id: 'FACT-2026-01-01-collide-stem-bbb',
        type: 'fact' as const,
        status: 'active' as const,
        confidence: 0.8,
        ttl_days: 1, // ensure expiry independent of fact's default
        created_at: created,
        updated_at: created,
      },
      body: 'Atom B (fact-typed, in ENTITIES/)',
      filePath: path.join(testDir, 'ENTITIES', sharedBasename),
    };

    fs.mkdirSync(path.dirname(atomA.filePath), { recursive: true });
    fs.mkdirSync(path.dirname(atomB.filePath), { recursive: true });
    writeAtom(atomA, atomA.filePath);
    writeAtom(atomB, atomB.filePath);

    const result = reflect(base());
    expect(result.expired).toBe(2);
    expect(result.archived).toBe(2);

    // Source files should be gone.
    expect(fs.existsSync(atomA.filePath)).toBe(false);
    expect(fs.existsSync(atomB.filePath)).toBe(false);

    // ARCHIVE/ should contain BOTH files with distinct names. Pre-fix, the
    // second archive write would overwrite the first because both targeted
    // ARCHIVE/collide-stem.md.
    const archiveFiles = fs.readdirSync(path.join(testDir, 'ARCHIVE')).sort();
    expect(archiveFiles).toHaveLength(2);
    expect(archiveFiles[0]).not.toBe(archiveFiles[1]);

    // Each archive filename should embed the originating atom ID so an
    // operator can trace which source file an archived copy came from.
    const names = archiveFiles.join('\n');
    expect(names).toContain('CONF-2026-01-01-collide-stem-aaa');
    expect(names).toContain('FACT-2026-01-01-collide-stem-bbb');
  });

  it('dedupById archives the older duplicate without colliding with an unrelated atom that shares a basename', () => {
    const older = sixtyDaysAgo();
    const newer = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const dupId = 'FACT-2026-01-01-dup-xxx';
    const sharedBasename = 'dup.md';

    // Two atoms with the same ID (dedupById trigger). Both type 'fact', so
    // both would normally live in ENTITIES/. We force one into CONFLICTS/
    // to create a basename collision opportunity in ARCHIVE/.
    const olderDup = {
      frontmatter: {
        id: dupId,
        type: 'fact' as const,
        status: 'active' as const,
        confidence: 0.8,
        ttl_days: null,
        created_at: older,
        updated_at: older,
      },
      body: 'older copy of duplicate',
      filePath: path.join(testDir, 'ENTITIES', sharedBasename),
    };
    const newerDup = {
      frontmatter: {
        id: dupId,
        type: 'fact' as const,
        status: 'active' as const,
        confidence: 0.8,
        ttl_days: null,
        created_at: newer,
        updated_at: newer,
      },
      body: 'newer copy of duplicate',
      filePath: path.join(testDir, 'CONFLICTS', sharedBasename),
    };

    // Unrelated TTL-expired atom that ALSO shares the basename.
    const unrelated = {
      frontmatter: {
        id: 'FACT-2026-01-01-unrelated-yyy',
        type: 'conflict' as const, // -> CONFLICTS/
        status: 'active' as const,
        confidence: 0.8,
        ttl_days: 30,
        created_at: older,
        updated_at: older,
      },
      body: 'unrelated atom that shares basename',
      filePath: path.join(testDir, 'CONFLICTS', 'unrelated-' + sharedBasename),
    };

    for (const a of [olderDup, newerDup, unrelated]) {
      fs.mkdirSync(path.dirname(a.filePath), { recursive: true });
      writeAtom(a, a.filePath);
    }

    const result = reflect(base());
    // Older dup → dedupById-archived. Unrelated → TTL-expired & archived.
    expect(result.archived).toBeGreaterThanOrEqual(2);

    const archiveFiles = fs.readdirSync(path.join(testDir, 'ARCHIVE'));
    expect(archiveFiles.length).toBeGreaterThanOrEqual(2);

    // No overwrites — every archived file must be distinct.
    const distinctNames = new Set(archiveFiles);
    expect(distinctNames.size).toBe(archiveFiles.length);

    const names = archiveFiles.join('\n');
    expect(names).toContain(dupId);
    expect(names).toContain('FACT-2026-01-01-unrelated-yyy');
  });

  it('body-content dedup archives the older twin distinctly when basename collides', () => {
    const older = sixtyDaysAgo();
    const newer = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const sharedBasename = 'twin.md';

    // Same TYPE and identical BODY → triggers body-content dedup.
    // Different IDs (so dedupById doesn't fire first). Same basename.
    const olderTwin = {
      frontmatter: {
        id: 'BELI-2026-01-01-twin-aaa',
        type: 'belief' as const,
        status: 'active' as const,
        confidence: 0.7,
        ttl_days: null,
        created_at: older,
        updated_at: older,
      },
      body: 'identical body content for dedup',
      filePath: path.join(testDir, 'ENTITIES', sharedBasename),
    };
    const newerTwin = {
      frontmatter: {
        id: 'BELI-2026-01-01-twin-bbb',
        type: 'belief' as const,
        status: 'active' as const,
        confidence: 0.7,
        ttl_days: null,
        created_at: newer,
        updated_at: newer,
      },
      body: 'identical body content for dedup',
      filePath: path.join(testDir, 'CONFLICTS', sharedBasename),
    };

    fs.mkdirSync(path.dirname(olderTwin.filePath), { recursive: true });
    fs.mkdirSync(path.dirname(newerTwin.filePath), { recursive: true });
    writeAtom(olderTwin, olderTwin.filePath);
    writeAtom(newerTwin, newerTwin.filePath);

    const result = reflect(base());
    expect(result.deduped).toBeGreaterThanOrEqual(1);

    const archiveFiles = fs.readdirSync(path.join(testDir, 'ARCHIVE'));
    expect(archiveFiles.length).toBeGreaterThanOrEqual(1);

    // Archived filename must embed the older atom's ID.
    const names = archiveFiles.join('\n');
    expect(names).toContain('BELI-2026-01-01-twin-aaa');
  });
});
