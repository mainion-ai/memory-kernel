/**
 * Replay engine tests — deterministic state reconstruction from events.
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
  readEvents,
  serializeAtom,
  parseAtom,
  writeEvidence,
} from '../src/index.js';
import { replay, replayFromFile } from '../src/replay.js';
import type { MemoryEvent, Atom } from '../src/types.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-replay-'));
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

const BASE_OPTS = {
  agent_id: 'test-agent',
  session_id: 'test-session',
};

const FIXED_TS = '2026-03-10T00:00:00Z';

function makeEvent(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    event_id: 'evt-test-1',
    timestamp: '2026-03-10T12:00:00Z',
    agent_id: 'test-agent',
    session_id: 'test-session',
    action: 'atom_created',
    ...overrides,
  };
}

function makeAtomSnapshot(type: string, id: string, body: string, status = 'active'): string {
  return `---
id: ${id}
type: ${type}
status: ${status}
confidence: 0.8
created_at: "2026-03-10T00:00:00Z"
updated_at: "2026-03-10T00:00:00Z"
ttl_days: null
---

${body}
`;
}

describe('replay', () => {
  it('returns empty result for empty events', () => {
    const result = replay([], { timestamp: FIXED_TS });
    expect(result.atoms.size).toBe(0);
    expect(result.events_processed).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(result.views.index).toContain('Memory Index');
  });

  it('reconstructs atom from atom_created event', () => {
    const snapshot = makeAtomSnapshot('decision', 'DECI-001', 'Use TypeScript');
    const events: MemoryEvent[] = [
      makeEvent({
        action: 'atom_created',
        atom_refs: ['DECI-001'],
        schema_version: 2,
        atom_snapshot: snapshot,
      }),
    ];

    const result = replay(events, { timestamp: FIXED_TS });
    expect(result.atoms.size).toBe(1);
    expect(result.atoms.get('DECI-001')).toBeDefined();
    expect(result.atoms.get('DECI-001')!.body).toContain('Use TypeScript');
  });

  it('reconstructs multiple atoms', () => {
    const events: MemoryEvent[] = [
      makeEvent({
        event_id: 'evt-1',
        action: 'atom_created',
        atom_refs: ['DECI-001'],
        schema_version: 2,
        atom_snapshot: makeAtomSnapshot('decision', 'DECI-001', 'Decision 1'),
      }),
      makeEvent({
        event_id: 'evt-2',
        action: 'atom_created',
        atom_refs: ['FACT-001'],
        schema_version: 2,
        atom_snapshot: makeAtomSnapshot('fact', 'FACT-001', 'Fact 1'),
      }),
    ];

    const result = replay(events, { timestamp: FIXED_TS });
    expect(result.atoms.size).toBe(2);
  });

  it('atom_updated replaces previous state', () => {
    const events: MemoryEvent[] = [
      makeEvent({
        event_id: 'evt-1',
        action: 'atom_created',
        atom_refs: ['DECI-001'],
        schema_version: 2,
        atom_snapshot: makeAtomSnapshot('decision', 'DECI-001', 'Original'),
      }),
      makeEvent({
        event_id: 'evt-2',
        action: 'atom_updated',
        atom_refs: ['DECI-001'],
        schema_version: 2,
        atom_snapshot: makeAtomSnapshot('decision', 'DECI-001', 'Updated'),
      }),
    ];

    const result = replay(events, { timestamp: FIXED_TS });
    expect(result.atoms.size).toBe(1);
    expect(result.atoms.get('DECI-001')!.body).toContain('Updated');
  });

  it('atom_archived removes atom from result', () => {
    const events: MemoryEvent[] = [
      makeEvent({
        event_id: 'evt-1',
        action: 'atom_created',
        atom_refs: ['DECI-001'],
        schema_version: 2,
        atom_snapshot: makeAtomSnapshot('decision', 'DECI-001', 'Will archive'),
      }),
      makeEvent({
        event_id: 'evt-2',
        action: 'atom_archived',
        atom_refs: ['DECI-001'],
        schema_version: 2,
        atom_snapshot: makeAtomSnapshot('decision', 'DECI-001', 'Will archive', 'archived'),
      }),
    ];

    const result = replay(events, { timestamp: FIXED_TS });
    expect(result.atoms.size).toBe(0);
  });

  it('atom_expired removes atom from result', () => {
    const events: MemoryEvent[] = [
      makeEvent({
        event_id: 'evt-1',
        action: 'atom_created',
        atom_refs: ['BELI-001'],
        schema_version: 2,
        atom_snapshot: makeAtomSnapshot('belief', 'BELI-001', 'Temporary'),
      }),
      makeEvent({
        event_id: 'evt-2',
        action: 'atom_expired',
        atom_refs: ['BELI-001'],
        schema_version: 2,
        atom_snapshot: makeAtomSnapshot('belief', 'BELI-001', 'Temporary', 'expired'),
      }),
    ];

    const result = replay(events, { timestamp: FIXED_TS });
    expect(result.atoms.size).toBe(0);
  });

  it('handles create → update → archive lifecycle', () => {
    const events: MemoryEvent[] = [
      makeEvent({
        event_id: 'evt-1',
        action: 'atom_created',
        atom_refs: ['DECI-001'],
        schema_version: 2,
        atom_snapshot: makeAtomSnapshot('decision', 'DECI-001', 'V1'),
      }),
      makeEvent({
        event_id: 'evt-2',
        action: 'atom_updated',
        atom_refs: ['DECI-001'],
        schema_version: 2,
        atom_snapshot: makeAtomSnapshot('decision', 'DECI-001', 'V2'),
      }),
      makeEvent({
        event_id: 'evt-3',
        action: 'atom_archived',
        atom_refs: ['DECI-001'],
        schema_version: 2,
        atom_snapshot: makeAtomSnapshot('decision', 'DECI-001', 'V2', 'archived'),
      }),
    ];

    const result = replay(events, { timestamp: FIXED_TS });
    expect(result.atoms.size).toBe(0);
    expect(result.events_processed).toBe(3);
  });

  it('generates views from reconstructed atoms', () => {
    const events: MemoryEvent[] = [
      makeEvent({
        action: 'atom_created',
        atom_refs: ['DECI-001'],
        schema_version: 2,
        atom_snapshot: makeAtomSnapshot('decision', 'DECI-001', 'Use TypeScript'),
      }),
    ];

    const result = replay(events, { timestamp: FIXED_TS });
    expect(result.views.index).toContain('Decisions (1)');
    expect(result.views.decisions).toContain('DECI-001');
    expect(result.views.handoff).toContain('1 decision');
  });

  it('is deterministic with fixed timestamp', () => {
    const events: MemoryEvent[] = [
      makeEvent({
        event_id: 'evt-1',
        action: 'atom_created',
        atom_refs: ['DECI-001'],
        schema_version: 2,
        atom_snapshot: makeAtomSnapshot('decision', 'DECI-001', 'D1'),
      }),
      makeEvent({
        event_id: 'evt-2',
        action: 'atom_created',
        atom_refs: ['FACT-001'],
        schema_version: 2,
        atom_snapshot: makeAtomSnapshot('fact', 'FACT-001', 'F1'),
      }),
    ];

    const r1 = replay(events, { timestamp: FIXED_TS });
    const r2 = replay(events, { timestamp: FIXED_TS });

    expect(r1.views.index).toBe(r2.views.index);
    expect(r1.views.decisions).toBe(r2.views.decisions);
    expect(r1.views.handoff).toBe(r2.views.handoff);
    expect(r1.atoms.size).toBe(r2.atoms.size);
  });

  it('v1 events (no snapshot) produce errors but no crash', () => {
    const events: MemoryEvent[] = [
      makeEvent({ event_id: 'evt-v1', action: 'atom_created', atom_refs: ['OLD-001'] }),
    ];

    const result = replay(events, { timestamp: FIXED_TS });
    expect(result.atoms.size).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('no snapshot');
  });

  it('v1 archive events remove atoms without snapshot', () => {
    const events: MemoryEvent[] = [
      makeEvent({
        event_id: 'evt-1',
        action: 'atom_created',
        atom_refs: ['DECI-001'],
        schema_version: 2,
        atom_snapshot: makeAtomSnapshot('decision', 'DECI-001', 'D1'),
      }),
      // V1-style archive (no snapshot)
      makeEvent({ event_id: 'evt-2', action: 'atom_archived', atom_refs: ['DECI-001'] }),
    ];

    const result = replay(events, { timestamp: FIXED_TS });
    expect(result.atoms.size).toBe(0);
    expect(result.errors).toHaveLength(0); // No error for v1 archive
  });

  it('resolves atom_snapshot_hash from evidence store', () => {
    initMemoryDir(testDir);
    const snapshotText = makeAtomSnapshot('fact', 'FACT-001', 'Evidence-backed fact');
    const hash = writeEvidence(testDir, Buffer.from(snapshotText));

    const events: MemoryEvent[] = [
      makeEvent({
        action: 'atom_created',
        atom_refs: ['FACT-001'],
        schema_version: 2,
        atom_snapshot_hash: hash,
      }),
    ];

    const result = replay(events, { evidenceDir: testDir, timestamp: FIXED_TS });
    expect(result.atoms.size).toBe(1);
    expect(result.atoms.get('FACT-001')!.body).toContain('Evidence-backed fact');
  });

  it('missing evidence hash produces error and continues', () => {
    initMemoryDir(testDir);

    const events: MemoryEvent[] = [
      makeEvent({
        event_id: 'evt-1',
        action: 'atom_created',
        atom_refs: ['FACT-001'],
        schema_version: 2,
        atom_snapshot_hash: 'a'.repeat(64),
      }),
      makeEvent({
        event_id: 'evt-2',
        action: 'atom_created',
        atom_refs: ['FACT-002'],
        schema_version: 2,
        atom_snapshot: makeAtomSnapshot('fact', 'FACT-002', 'Good fact'),
      }),
    ];

    const result = replay(events, { evidenceDir: testDir, timestamp: FIXED_TS });
    expect(result.atoms.size).toBe(1); // Only the second one
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('evidence');
  });

  it('atom_imported works like atom_created', () => {
    const events: MemoryEvent[] = [
      makeEvent({
        action: 'atom_imported',
        atom_refs: ['DECI-001'],
        schema_version: 2,
        atom_snapshot: makeAtomSnapshot('decision', 'DECI-001', 'Imported decision'),
      }),
    ];

    const result = replay(events, { timestamp: FIXED_TS });
    expect(result.atoms.size).toBe(1);
    expect(result.atoms.get('DECI-001')!.body).toContain('Imported decision');
  });

  it('non-mutation events are skipped', () => {
    const events: MemoryEvent[] = [
      makeEvent({ event_id: 'evt-1', action: 'reflect_completed' }),
      makeEvent({ event_id: 'evt-2', action: 'checkpoint_created' }),
      makeEvent({ event_id: 'evt-3', action: 'session_started' }),
    ];

    const result = replay(events, { timestamp: FIXED_TS });
    expect(result.atoms.size).toBe(0);
    expect(result.events_processed).toBe(3);
    expect(result.errors).toHaveLength(0);
  });

  it('corrupted snapshot produces error and continues', () => {
    const events: MemoryEvent[] = [
      makeEvent({
        event_id: 'evt-1',
        action: 'atom_created',
        atom_refs: ['BAD-001'],
        schema_version: 2,
        atom_snapshot: 'not valid yaml frontmatter',
      }),
      makeEvent({
        event_id: 'evt-2',
        action: 'atom_created',
        atom_refs: ['FACT-001'],
        schema_version: 2,
        atom_snapshot: makeAtomSnapshot('fact', 'FACT-001', 'Good'),
      }),
    ];

    const result = replay(events, { timestamp: FIXED_TS });
    expect(result.atoms.size).toBe(1);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });

  it('promotion changes atom type from belief to fact', () => {
    const events: MemoryEvent[] = [
      makeEvent({
        event_id: 'evt-1',
        action: 'atom_created',
        atom_refs: ['BELI-001'],
        schema_version: 2,
        atom_snapshot: makeAtomSnapshot('belief', 'BELI-001', 'Promoted belief'),
      }),
      makeEvent({
        event_id: 'evt-2',
        action: 'atom_promoted',
        atom_refs: ['BELI-001'],
        schema_version: 2,
        atom_snapshot: makeAtomSnapshot('fact', 'BELI-001', 'Promoted belief'),
      }),
    ];

    const result = replay(events, { timestamp: FIXED_TS });
    expect(result.atoms.get('BELI-001')!.frontmatter.type).toBe('fact');
  });

  it('handles large event stream (500+ events)', () => {
    const events: MemoryEvent[] = [];
    for (let i = 0; i < 500; i++) {
      events.push(
        makeEvent({
          event_id: `evt-${i}`,
          action: 'atom_created',
          atom_refs: [`FACT-${i}`],
          schema_version: 2,
          atom_snapshot: makeAtomSnapshot('fact', `FACT-${i}`, `Fact number ${i}`),
        }),
      );
    }

    const result = replay(events, { timestamp: FIXED_TS });
    expect(result.atoms.size).toBe(500);
    expect(result.events_processed).toBe(500);
  });
});

describe('replayFromFile', () => {
  it('reads NDJSON file and replays', () => {
    initMemoryDir(testDir);
    createAtom({ memoryDir: testDir, ...BASE_OPTS, type: 'decision', slug: 'test', body: 'Test' });

    const eventsFile = path.join(testDir, 'events.ndjson');
    const result = replayFromFile(eventsFile, { timestamp: FIXED_TS });

    // Should have at least the created atom
    expect(result.atoms.size).toBeGreaterThanOrEqual(1);
  });

  it('returns empty result for missing file', () => {
    const result = replayFromFile('/nonexistent/events.ndjson', { timestamp: FIXED_TS });
    expect(result.atoms.size).toBe(0);
    expect(result.events_processed).toBe(0);
  });

  it('writes atoms and views to outputDir', () => {
    initMemoryDir(testDir);
    createAtom({ memoryDir: testDir, ...BASE_OPTS, type: 'decision', slug: 'd1', body: 'Decision 1' });
    createAtom({ memoryDir: testDir, ...BASE_OPTS, type: 'fact', slug: 'f1', body: 'Fact 1' });

    const outDir = path.join(testDir, 'replay-output');
    const eventsFile = path.join(testDir, 'events.ndjson');
    replayFromFile(eventsFile, { outputDir: outDir, timestamp: FIXED_TS });

    // Views should be written
    expect(fs.existsSync(path.join(outDir, 'INDEX.md'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'DECISIONS.md'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'HANDOFF.md'))).toBe(true);

    // Atom files should be written in ENTITIES/
    const entityFiles = fs.readdirSync(path.join(outDir, 'ENTITIES'));
    expect(entityFiles.length).toBeGreaterThanOrEqual(2);
  });

  it('returns empty result for empty file', () => {
    const emptyFile = path.join(testDir, 'empty.ndjson');
    fs.writeFileSync(emptyFile, '');
    const result = replayFromFile(emptyFile, { timestamp: FIXED_TS });
    expect(result.atoms.size).toBe(0);
  });
});

describe('replay integration with real operations', () => {
  it('replays v2 events from createAtom', () => {
    initMemoryDir(testDir);
    createAtom({ memoryDir: testDir, ...BASE_OPTS, type: 'decision', slug: 'use-ts', body: 'Use TypeScript' });

    const events = readEvents(testDir);
    const result = replay(events, { timestamp: FIXED_TS });

    expect(result.atoms.size).toBe(1);
    const atom = Array.from(result.atoms.values())[0];
    expect(atom.frontmatter.type).toBe('decision');
    expect(atom.body).toContain('Use TypeScript');
  });

  it('replays create + update correctly', () => {
    initMemoryDir(testDir);
    const created = createAtom({
      memoryDir: testDir, ...BASE_OPTS,
      type: 'fact', slug: 'f1', body: 'Original',
    });
    updateAtom({
      memoryDir: testDir, ...BASE_OPTS,
      filePath: created.filePath!,
      updates: { confidence: 0.95 },
      body: 'Updated body',
    });

    const events = readEvents(testDir);
    const result = replay(events, { timestamp: FIXED_TS });

    expect(result.atoms.size).toBe(1);
    const atom = Array.from(result.atoms.values())[0];
    expect(atom.body).toContain('Updated body');
    expect(atom.frontmatter.confidence).toBe(0.95);
  });

  it('replays create + archive correctly', () => {
    initMemoryDir(testDir);
    const created = createAtom({
      memoryDir: testDir, ...BASE_OPTS,
      type: 'fact', slug: 'f1', body: 'Will be archived',
    });
    archiveAtom({ memoryDir: testDir, ...BASE_OPTS, filePath: created.filePath! });

    const events = readEvents(testDir);
    const result = replay(events, { timestamp: FIXED_TS });

    expect(result.atoms.size).toBe(0); // Archived = removed
  });
});
