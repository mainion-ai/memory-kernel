/**
 * mergeEventLogs() — multi-agent event-log union merge tests.
 *
 * Covers:
 * 1.  Non-overlapping atoms: all atoms from both agents present after merge
 * 2.  Event deduplication: shared base events are not duplicated
 * 3.  Concurrent updates → conflict atom created
 * 4.  Idempotent merge: second merge is a no-op
 * 5.  Timestamp ordering: last-writer-wins by timestamp
 * 6.  Dry run: no side effects
 * 7.  Views regenerated after merge
 * 8.  Backup created before writing
 * 9.  Replay invariant: replay(readEvents()) === atoms on disk
 * 10. merge_completed event emitted with correct meta
 * 11. Large merge: 100 atoms each side, all 200 present
 * 12. Conflict idempotency: second merge does not duplicate conflict atom
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  initMemoryDir,
  createAtom,
  updateAtom,
  listAtoms,
  readEvents,
  readView,
  replay,
  closeAllIndexes,
} from '../src/index.js';
import { mergeEventLogs } from '../src/merge.js';

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

let localDir: string;
let remoteDir: string;

beforeEach(() => {
  localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-merge-local-'));
  remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-merge-remote-'));
  initMemoryDir(localDir);
  initMemoryDir(remoteDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(localDir, { recursive: true, force: true });
  fs.rmSync(remoteDir, { recursive: true, force: true });
});

const localBase = () => ({ memoryDir: localDir, agent_id: 'agent-A', session_id: 'session-A' });
const remoteBase = () => ({ memoryDir: remoteDir, agent_id: 'agent-B', session_id: 'session-B' });

function mergeOpts(extra: Partial<Parameters<typeof mergeEventLogs>[0]> = {}) {
  return { localDir, remoteDir, agent_id: 'agent-A', session_id: 'merge-session', ...extra };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mergeEventLogs()', () => {
  it('1. non-overlapping atoms: all atoms from both agents present after merge', () => {
    const a1 = createAtom({ ...localBase(), type: 'fact', slug: 'local-a1', body: 'Local fact A1' });
    const a2 = createAtom({ ...localBase(), type: 'fact', slug: 'local-a2', body: 'Local fact A2' });
    createAtom({ ...remoteBase(), type: 'fact', slug: 'remote-b1', body: 'Remote fact B1' });
    createAtom({ ...remoteBase(), type: 'fact', slug: 'remote-b2', body: 'Remote fact B2' });

    const result = mergeEventLogs(mergeOpts());

    expect(result.events_imported).toBeGreaterThan(0);
    expect(result.events_skipped).toBe(0);
    expect(result.conflicts_created).toBe(0);

    const atoms = listAtoms(localDir);
    expect(atoms.length).toBe(4);
    const ids = atoms.map((a) => a.frontmatter.id);
    expect(ids).toContain(a1.frontmatter.id);
    expect(ids).toContain(a2.frontmatter.id);
    // Remote atoms should now be present
    const bodies = atoms.map((a) => a.body);
    expect(bodies).toContain('Remote fact B1');
    expect(bodies).toContain('Remote fact B2');
  });

  it('2. event deduplication: shared base events are not duplicated', () => {
    // Create atom in local
    createAtom({ ...localBase(), type: 'fact', slug: 'shared-base', body: 'Shared base fact' });

    // Copy local events.ndjson to remote (simulate shared base)
    const localEventsPath = path.join(localDir, 'events.ndjson');
    const remoteEventsPath = path.join(remoteDir, 'events.ndjson');
    fs.copyFileSync(localEventsPath, remoteEventsPath);

    const localEventsBefore = readEvents(localDir);

    const result = mergeEventLogs(mergeOpts());

    expect(result.events_imported).toBe(0);
    expect(result.events_skipped).toBe(localEventsBefore.length);
    expect(result.conflicts_created).toBe(0);

    // No duplicate atoms
    const atoms = listAtoms(localDir);
    expect(atoms.length).toBe(1);

    // No duplicate events
    const eventsAfter = readEvents(localDir);
    const eventIds = eventsAfter.map((e) => e.event_id);
    const uniqueIds = new Set(eventIds);
    expect(eventIds.length).toBe(uniqueIds.size);
  });

  it('3. concurrent updates → conflict atom created', () => {
    // Agent A creates a shared fact
    const shared = createAtom({
      ...localBase(),
      type: 'fact',
      slug: 'shared-fact',
      body: 'Original shared fact',
    });

    // Copy event log to remote (shared base)
    const localEventsPath = path.join(localDir, 'events.ndjson');
    fs.copyFileSync(localEventsPath, path.join(remoteDir, 'events.ndjson'));
    // Copy the atom file to remote dir so updateAtom can find it
    const atomSubdir = path.join(remoteDir, 'FACT');
    fs.mkdirSync(atomSubdir, { recursive: true });
    const atomFileName = path.basename(shared.filePath!);
    fs.copyFileSync(shared.filePath!, path.join(atomSubdir, atomFileName));

    // Agent A updates the fact independently
    updateAtom({
      ...localBase(),
      filePath: shared.filePath!,
      updates: {},
      body: 'Version A update',
    });

    // Agent B updates the same fact independently
    updateAtom({
      ...remoteBase(),
      filePath: path.join(atomSubdir, atomFileName),
      updates: {},
      body: 'Version B update',
    });

    const result = mergeEventLogs(mergeOpts());

    expect(result.conflicts_created).toBe(1);

    const allAtoms = listAtoms(localDir);
    const conflictAtoms = allAtoms.filter((a) => a.frontmatter.type === 'conflict');
    expect(conflictAtoms.length).toBe(1);
    expect(conflictAtoms[0].body).toContain(shared.frontmatter.id);
    expect(conflictAtoms[0].frontmatter.links?.related).toContain(shared.frontmatter.id);
  });

  it('4. idempotent merge: second merge is a no-op', () => {
    createAtom({ ...remoteBase(), type: 'fact', slug: 'remote-fact', body: 'Remote fact' });

    const result1 = mergeEventLogs(mergeOpts());
    expect(result1.events_imported).toBeGreaterThan(0);

    const atomsAfterFirst = listAtoms(localDir).length;

    const result2 = mergeEventLogs(mergeOpts());
    expect(result2.events_imported).toBe(0);
    expect(result2.events_skipped).toBeGreaterThan(0);

    const atomsAfterSecond = listAtoms(localDir).length;
    expect(atomsAfterSecond).toBe(atomsAfterFirst);
  });

  it('5. timestamp ordering: last-writer-wins by timestamp', () => {
    // Agent A creates a shared fact first
    const shared = createAtom({
      ...localBase(),
      type: 'fact',
      slug: 'lww-fact',
      body: 'Initial version',
    });

    // Copy to remote as shared base
    fs.copyFileSync(path.join(localDir, 'events.ndjson'), path.join(remoteDir, 'events.ndjson'));
    const atomSubdir = path.join(remoteDir, 'FACT');
    fs.mkdirSync(atomSubdir, { recursive: true });
    fs.copyFileSync(shared.filePath!, path.join(atomSubdir, path.basename(shared.filePath!)));

    // Agent A updates (will run first in wall-clock time during test)
    updateAtom({ ...localBase(), filePath: shared.filePath!, updates: {}, body: 'Version A' });

    // Brief pause to ensure Agent B's timestamp is strictly later
    // (In practice, events are real-time, so we just need B to be created after A)
    // Agent B updates immediately after
    updateAtom({
      ...remoteBase(),
      filePath: path.join(atomSubdir, path.basename(shared.filePath!)),
      updates: {},
      body: 'Version B (latest)',
    });

    mergeEventLogs(mergeOpts());

    const atoms = listAtoms(localDir);
    const theAtom = atoms.find((a) => a.frontmatter.id === shared.frontmatter.id);
    expect(theAtom).toBeDefined();
    // Both versions end up in the merged log; replay picks the latest by timestamp
    // Agent B's update was emitted after Agent A's, so B wins
    expect(theAtom!.body).toBe('Version B (latest)');
  });

  it('6. dry run: no side effects', () => {
    createAtom({ ...remoteBase(), type: 'fact', slug: 'dry-run-fact', body: 'Remote dry-run fact' });

    const eventsBefore = readEvents(localDir);
    const localEventsPath = path.join(localDir, 'events.ndjson');
    const contentBefore = fs.readFileSync(localEventsPath, 'utf-8');

    const result = mergeEventLogs(mergeOpts({ dryRun: true }));

    expect(result.events_imported).toBeGreaterThan(0);
    expect(result.atoms_updated).toBe(0);
    expect(result.conflicts_created).toBe(0);
    expect(result.backup_path).toBe('');

    // events.ndjson unchanged
    expect(fs.readFileSync(localEventsPath, 'utf-8')).toBe(contentBefore);
    // No new events
    expect(readEvents(localDir).length).toBe(eventsBefore.length);
    // No new atoms
    expect(listAtoms(localDir).length).toBe(0);
  });

  it('7. views regenerated after merge', () => {
    createAtom({ ...localBase(), type: 'decision', slug: 'local-decision', body: 'Local decision' });
    createAtom({ ...remoteBase(), type: 'constraint', slug: 'remote-constraint', body: 'Remote constraint' });

    mergeEventLogs(mergeOpts());

    const index = readView(localDir, 'INDEX.md');
    const decisions = readView(localDir, 'DECISIONS.md');
    const constraints = readView(localDir, 'CONSTRAINTS.md');

    expect(index).toBeTruthy();
    expect(decisions).toContain('Local decision');
    expect(constraints).toContain('Remote constraint');
  });

  it('8. backup created before writing', () => {
    createAtom({ ...remoteBase(), type: 'fact', slug: 'backup-fact', body: 'Backup test fact' });

    const eventsBefore = readEvents(localDir);

    const result = mergeEventLogs(mergeOpts());

    expect(result.backup_path).toBeTruthy();
    expect(fs.existsSync(result.backup_path)).toBe(true);

    // Backup contains the original events (before merge)
    const backupContent = fs.readFileSync(result.backup_path, 'utf-8');
    const backupEvents = backupContent
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(backupEvents.length).toBe(eventsBefore.length);
  });

  it('9. replay invariant: replay(readEvents()) matches atoms on disk', () => {
    createAtom({ ...localBase(), type: 'fact', slug: 'invariant-a', body: 'Invariant fact A' });
    createAtom({ ...remoteBase(), type: 'fact', slug: 'invariant-b', body: 'Invariant fact B' });

    mergeEventLogs(mergeOpts());

    const eventsAfter = readEvents(localDir);
    const replayResult = replay(eventsAfter);
    const atomsOnDisk = listAtoms(localDir);

    // Every atom in replay (non-conflict) should be on disk
    for (const [id] of replayResult.atoms) {
      const onDisk = atomsOnDisk.some((a) => a.frontmatter.id === id);
      expect(onDisk, `atom ${id} from replay missing on disk`).toBe(true);
    }

    // Every non-conflict atom on disk should be in replay
    const nonConflictOnDisk = atomsOnDisk.filter((a) => a.frontmatter.type !== 'conflict');
    for (const atom of nonConflictOnDisk) {
      const inReplay = replayResult.atoms.has(atom.frontmatter.id);
      expect(inReplay, `disk atom ${atom.frontmatter.id} missing from replay`).toBe(true);
    }
  });

  it('10. merge_completed event emitted with correct meta', () => {
    createAtom({ ...remoteBase(), type: 'fact', slug: 'meta-fact', body: 'Meta test fact' });
    createAtom({ ...remoteBase(), type: 'fact', slug: 'meta-fact-2', body: 'Meta test fact 2' });

    mergeEventLogs(mergeOpts());

    const events = readEvents(localDir);
    const mergeEvent = events.find((e) => e.action === 'merge_completed');

    expect(mergeEvent).toBeDefined();
    expect(mergeEvent!.agent_id).toBe('agent-A');
    expect(mergeEvent!.session_id).toBe('merge-session');
    expect(mergeEvent!.meta?.remote_dir).toBe(remoteDir);
    expect(mergeEvent!.meta?.events_imported).toBeGreaterThan(0);
    expect(mergeEvent!.meta?.conflicts_created).toBe(0);
  });

  it('11. large merge: 100 atoms each side, all 200 present', { timeout: 30000 }, () => {
    for (let i = 0; i < 100; i++) {
      createAtom({ ...localBase(), type: 'fact', slug: `local-fact-${i}`, body: `Local fact ${i}` });
    }
    for (let j = 0; j < 100; j++) {
      createAtom({ ...remoteBase(), type: 'fact', slug: `remote-fact-${j}`, body: `Remote fact ${j}` });
    }

    const result = mergeEventLogs(mergeOpts());

    expect(result.events_imported).toBeGreaterThan(0);
    expect(result.conflicts_created).toBe(0);
    expect(result.atoms_updated).toBe(200);

    const atoms = listAtoms(localDir);
    expect(atoms.length).toBe(200);
  });

  it('12. conflict idempotency: second merge does not duplicate conflict atom', () => {
    // Set up concurrent updates (same as test 3)
    const shared = createAtom({
      ...localBase(),
      type: 'fact',
      slug: 'idem-fact',
      body: 'Original idempotency fact',
    });

    fs.copyFileSync(path.join(localDir, 'events.ndjson'), path.join(remoteDir, 'events.ndjson'));
    const atomSubdir = path.join(remoteDir, 'FACT');
    fs.mkdirSync(atomSubdir, { recursive: true });
    fs.copyFileSync(shared.filePath!, path.join(atomSubdir, path.basename(shared.filePath!)));

    updateAtom({ ...localBase(), filePath: shared.filePath!, updates: {}, body: 'Idempotency version A' });
    updateAtom({
      ...remoteBase(),
      filePath: path.join(atomSubdir, path.basename(shared.filePath!)),
      updates: {},
      body: 'Idempotency version B',
    });

    // First merge
    const result1 = mergeEventLogs(mergeOpts());
    expect(result1.conflicts_created).toBe(1);

    const conflictsAfterFirst = listAtoms(localDir).filter((a) => a.frontmatter.type === 'conflict');
    expect(conflictsAfterFirst.length).toBe(1);

    // Second merge (idempotent)
    const result2 = mergeEventLogs(mergeOpts());
    expect(result2.conflicts_created).toBe(0);

    const conflictsAfterSecond = listAtoms(localDir).filter((a) => a.frontmatter.type === 'conflict');
    expect(conflictsAfterSecond.length).toBe(1); // No duplication
  });

  it('same-dir guard: throws when localDir === remoteDir', () => {
    expect(() =>
      mergeEventLogs({ localDir, remoteDir: localDir, agent_id: 'a', session_id: 's' }),
    ).toThrow('localDir and remoteDir must be different directories');
  });

  it('missing remote events.ndjson: returns zeros without error', () => {
    // remoteDir exists but has no events.ndjson
    const emptyRemote = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-merge-empty-'));
    try {
      const result = mergeEventLogs({ localDir, remoteDir: emptyRemote, agent_id: 'a', session_id: 's' });
      expect(result.events_imported).toBe(0);
      expect(result.events_skipped).toBe(0);
    } finally {
      fs.rmSync(emptyRemote, { recursive: true, force: true });
    }
  });
});
