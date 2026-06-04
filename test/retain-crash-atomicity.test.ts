/**
 * Regression tests for #84 — event-first write path.
 *
 * `createAtom`, `updateAtom`, `archiveAtom`, and `resolveConflict` previously
 * emitted the durable event AFTER mutating files / the index. A crash between
 * the file mutation and the event append left:
 *   - the file system in the post-mutation state
 *   - the event log WITHOUT the snapshot
 *   - replay unable to reconstruct the mutation
 *
 * Worst case: `archiveAtom` unlinkSync'd the source file BEFORE appendEvent,
 * so a crash there left an orphan archive copy and no event-log record.
 *
 * Fix: emit the v2 event (with full snapshot) FIRST, then do the file/index
 * mutation. On crash, the event log alone is enough for replay to reconstruct.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  initMemoryDir,
  createAtom,
  updateAtom,
  archiveAtom,
  resolveConflict,
  readEvents,
  closeAllIndexes,
} from '../src';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-crash-atomicity-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

const base = () => ({
  memoryDir: testDir,
  agent_id: 'test-agent',
  session_id: 'test-session',
});

describe('retain — event-first write path (#84)', () => {
  it('createAtom: event is appended before the atom file is written', () => {
    // writeAtom → writeFileAtomic → fs.renameSync(tmp, final). Failing the
    // rename to a path inside ENTITIES/ simulates a crash mid-writeAtom.
    const originalRenameSync = fs.renameSync;
    let renameFailed = false;
    vi.spyOn(fs, 'renameSync').mockImplementation((src, dest) => {
      const destStr = typeof dest === 'string' ? dest : '';
      if (
        !renameFailed &&
        destStr.includes(path.sep + 'ENTITIES' + path.sep) &&
        destStr.endsWith('.md')
      ) {
        renameFailed = true;
        throw new Error('simulated crash during writeAtom');
      }
      return originalRenameSync.call(fs, src, dest);
    });

    expect(() =>
      createAtom({
        ...base(),
        type: 'fact',
        slug: 'crash-test',
        body: 'should be recoverable',
      }),
    ).toThrow(/simulated crash/);

    // Event log must already have the atom_created event with full snapshot.
    const events = readEvents(testDir);
    const created = events.filter((e) => e.action === 'atom_created');
    expect(created).toHaveLength(1);
    expect((created[0] as any).atom_snapshot).toBeDefined();
    expect(typeof (created[0] as any).atom_snapshot).toBe('string');
  });

  it('updateAtom: event is appended before the file is updated', () => {
    const atom = createAtom({
      ...base(),
      type: 'fact',
      slug: 'will-update',
      body: 'original',
    });

    // Failing the rename to the atom path should still leave the
    // `atom_updated` event in the log.
    const originalRenameSync = fs.renameSync;
    let renameFailed = false;
    vi.spyOn(fs, 'renameSync').mockImplementation((src, dest) => {
      const destStr = typeof dest === 'string' ? dest : '';
      if (!renameFailed && destStr === atom.filePath) {
        renameFailed = true;
        throw new Error('simulated crash during update writeAtom');
      }
      return originalRenameSync.call(fs, src, dest);
    });

    expect(() =>
      updateAtom({
        ...base(),
        filePath: atom.filePath!,
        updates: {},
        body: 'updated content',
      }),
    ).toThrow(/simulated crash/);

    const events = readEvents(testDir);
    const updates = events.filter((e) => e.action === 'atom_updated');
    expect(updates).toHaveLength(1);
    expect((updates[0] as any).atom_snapshot).toBeDefined();
  });

  it('archiveAtom: event is appended before the source file is unlinked (no data loss on crash)', () => {
    const atom = createAtom({
      ...base(),
      type: 'fact',
      slug: 'will-archive',
      body: 'should-not-be-destroyed',
    });

    // Simulate a crash at the unlinkSync step. Pre-fix this happened AFTER
    // unlinkSync was called and BEFORE appendEvent — destroying the source
    // file with no event-log record. Post-fix the event already exists.
    const originalUnlinkSync = fs.unlinkSync;
    let unlinkFailed = false;
    vi.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
      const targetStr = typeof target === 'string' ? target : '';
      if (!unlinkFailed && targetStr === atom.filePath) {
        unlinkFailed = true;
        throw new Error('simulated crash during archiveAtom unlinkSync');
      }
      return originalUnlinkSync.call(fs, target);
    });

    expect(() =>
      archiveAtom({ ...base(), filePath: atom.filePath! }),
    ).toThrow(/simulated crash/);

    const events = readEvents(testDir);
    const archived = events.filter((e) => e.action === 'atom_archived');
    expect(archived).toHaveLength(1);
    expect((archived[0] as any).atom_snapshot).toBeDefined();
  });

  it('resolveConflict: event is appended before the source file is unlinked', () => {
    const conflictAtom = createAtom({
      ...base(),
      type: 'conflict',
      slug: 'will-resolve',
      body: 'conflict body',
    });

    const originalUnlinkSync = fs.unlinkSync;
    let unlinkFailed = false;
    vi.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
      const targetStr = typeof target === 'string' ? target : '';
      if (!unlinkFailed && targetStr === conflictAtom.filePath) {
        unlinkFailed = true;
        throw new Error('simulated crash during resolveConflict unlinkSync');
      }
      return originalUnlinkSync.call(fs, target);
    });

    expect(() =>
      resolveConflict({
        ...base(),
        filePath: conflictAtom.filePath!,
        resolutionNote: 'resolved during test',
      }),
    ).toThrow(/simulated crash/);

    const events = readEvents(testDir);
    const resolved = events.filter((e) => e.action === 'conflict_resolved');
    expect(resolved).toHaveLength(1);
    expect((resolved[0] as any).atom_snapshot).toBeDefined();
  });

  it('archiveAtom: snapshot reflects post-mutation state (status=archived)', () => {
    const atom = createAtom({
      ...base(),
      type: 'fact',
      slug: 'snapshot-state',
      body: 'pre-archive',
    });

    archiveAtom({ ...base(), filePath: atom.filePath! });

    const events = readEvents(testDir);
    const archived = events.filter((e) => e.action === 'atom_archived');
    expect(archived).toHaveLength(1);
    const snapshot = (archived[0] as any).atom_snapshot as string;
    expect(snapshot).toContain('status: archived');
  });
});
