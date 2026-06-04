/**
 * Direct error / edge-path coverage for src/migrate.ts (#104).
 *
 * Sibling to test/isolation-migrate.test.ts (which covers the happy paths
 * for the three strategies). This file targets the validation / env / empty-
 * store edge cases that the system review flagged as uncovered.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  initMemoryDir,
  createAtom,
  closeAllIndexes,
  openIndex,
  migrate,
  isIsolated,
} from '../src/index.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-migrate-direct-'));
  initMemoryDir(testDir);
  openIndex(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
  // Clean up any env var pollution between tests
  delete process.env.MK_ISOLATION;
});

describe('migrate — unknown strategy', () => {
  it('throws for an unrecognized strategy value', () => {
    expect(() =>
      // @ts-expect-error — intentionally pass invalid strategy
      migrate({ baseDir: testDir, strategy: 'bogus-strategy' }),
    ).toThrow(/Unknown migration strategy/);
  });
});

describe('migrate — MK_ISOLATION env var interaction', () => {
  it('refuses to migrate when MK_ISOLATION=per-agent makes the store appear isolated', () => {
    // MK_ISOLATION env var alone (no config.yaml) makes isIsolated() true.
    process.env.MK_ISOLATION = 'per-agent';
    expect(isIsolated(testDir)).toBe(true);
    expect(() => migrate({ baseDir: testDir, strategy: 'fresh' })).toThrow(
      /already in isolated/,
    );
  });

  it('proceeds normally when MK_ISOLATION=shared (explicit shared mode)', () => {
    process.env.MK_ISOLATION = 'shared';
    expect(isIsolated(testDir)).toBe(false);
    const result = migrate({ baseDir: testDir, strategy: 'fresh' });
    expect(result.config_written).toBe(true);
    expect(result.strategy).toBe('fresh');
  });

  it('ignores garbage MK_ISOLATION values and falls back to default (shared)', () => {
    process.env.MK_ISOLATION = 'not-a-real-mode';
    expect(isIsolated(testDir)).toBe(false);
    // Confirm migrate proceeds against the default-shared state.
    const result = migrate({ baseDir: testDir, strategy: 'fresh' });
    expect(result.config_written).toBe(true);
  });
});

describe('migrate — partition strategy: assignUntagged validation', () => {
  it('throws when assignUntagged contains a path separator', () => {
    closeAllIndexes();
    expect(() =>
      migrate({
        baseDir: testDir,
        strategy: 'partition',
        assignUntagged: 'has/slash',
      }),
    ).toThrow(/Invalid assignUntagged/);
  });

  it('throws when assignUntagged is empty', () => {
    closeAllIndexes();
    expect(() =>
      migrate({
        baseDir: testDir,
        strategy: 'partition',
        assignUntagged: '',
      }),
    ).toThrow(/Invalid assignUntagged/);
  });

  it('throws when assignUntagged contains a traversal segment', () => {
    closeAllIndexes();
    expect(() =>
      migrate({
        baseDir: testDir,
        strategy: 'partition',
        assignUntagged: '..',
      }),
    ).toThrow(/Invalid assignUntagged/);
  });

  it('accepts a valid assignUntagged value with allowed alphanumerics/dashes', () => {
    closeAllIndexes();
    const result = migrate({
      baseDir: testDir,
      strategy: 'partition',
      assignUntagged: 'fallback-agent_1',
    });
    expect(result.config_written).toBe(true);
    expect(isIsolated(testDir)).toBe(true);
  });
});

describe('migrate — empty store edge cases', () => {
  it('partition succeeds on a fresh empty store (no atoms, no events)', () => {
    closeAllIndexes();
    const result = migrate({ baseDir: testDir, strategy: 'partition' });
    expect(result.strategy).toBe('partition');
    expect(result.atoms_moved).toBe(0);
    expect(result.agents_created).toEqual([]);
    // No atoms = no backup created
    expect(result.backup_path).toBe('');
    expect(result.config_written).toBe(true);
  });

  it('clone-to-shared succeeds on an empty store with no backup created', () => {
    closeAllIndexes();
    const result = migrate({ baseDir: testDir, strategy: 'clone-to-shared' });
    expect(result.atoms_shared).toBe(0);
    expect(result.backup_path).toBe('');
    expect(result.config_written).toBe(true);
  });
});

describe('migrate — backup directory contents', () => {
  it('partition produces a backup directory containing the original atom files', () => {
    const atom = createAtom({
      memoryDir: testDir,
      agent_id: 'alice',
      session_id: 'sess',
      type: 'fact',
      slug: 'backup-source',
      body: 'Original content to be backed up.',
    });
    const originalRel = path.relative(testDir, atom.filePath!);
    closeAllIndexes();

    const result = migrate({ baseDir: testDir, strategy: 'partition' });

    expect(result.backup_path).not.toBe('');
    expect(fs.existsSync(result.backup_path)).toBe(true);

    const backedUpFile = path.join(result.backup_path, originalRel);
    expect(fs.existsSync(backedUpFile)).toBe(true);
    const backedUpContent = fs.readFileSync(backedUpFile, 'utf-8');
    expect(backedUpContent).toContain('Original content to be backed up.');
  });

  it('clone-to-shared produces a backup that mirrors the source layout', () => {
    const atom = createAtom({
      memoryDir: testDir,
      agent_id: 'main',
      session_id: 'sess',
      type: 'decision',
      slug: 'clone-source',
      body: 'Will be cloned to shared.',
    });
    const originalRel = path.relative(testDir, atom.filePath!);
    closeAllIndexes();

    const result = migrate({ baseDir: testDir, strategy: 'clone-to-shared' });

    expect(result.backup_path).not.toBe('');
    const backedUpFile = path.join(result.backup_path, originalRel);
    expect(fs.existsSync(backedUpFile)).toBe(true);
  });
});

describe('migrate — config write ordering invariant', () => {
  it('partition writes config first so a re-run hits the "already isolated" guard (idempotency)', () => {
    createAtom({
      memoryDir: testDir,
      agent_id: 'a',
      session_id: 's',
      type: 'fact',
      slug: 'idempotency-source',
      body: 'first',
    });
    closeAllIndexes();

    migrate({ baseDir: testDir, strategy: 'partition' });
    // After a successful partition, a second migrate (any strategy) must
    // refuse — proves the config was written even if some other invariant
    // changed mid-run.
    expect(() =>
      migrate({ baseDir: testDir, strategy: 'fresh' }),
    ).toThrow(/already in isolated/);
  });
});
