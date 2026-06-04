/**
 * Direct error / edge-path coverage for src/event-log.ts (#104).
 *
 * Sibling to test/event-log-compact-race.test.ts (which pins the lock-ordering
 * invariant) and test/store-file-permissions.test.ts (which pins the 0o600
 * invariant). This file targets the lower-level exports that lack direct
 * tests: appendEvent validation rejection, readEvents corruption tolerance,
 * countEvents parity, getLastEventId edge cases.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  appendEvent,
  readEvents,
  readEventsByAction,
  readEventsForAtoms,
  countEvents,
  getLastEventId,
} from '../src/event-log.js';
import { initMemoryDir } from '../src/store.js';
import { closeAllIndexes } from '../src/index-db.js';

let memoryDir: string;

beforeEach(() => {
  memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-event-log-direct-'));
  initMemoryDir(memoryDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(memoryDir, { recursive: true, force: true });
});

describe('appendEvent — validation', () => {
  it('rejects unknown action with a validator error', () => {
    expect(() =>
      // @ts-expect-error — intentionally pass an invalid action to exercise validateEvent
      appendEvent(memoryDir, 'not_a_real_action', {
        agent_id: 'a',
        session_id: 's',
      }),
    ).toThrow(/Invalid event/);
  });

  it('rejects empty agent_id (zod min(1))', () => {
    expect(() =>
      appendEvent(memoryDir, 'session_started', {
        agent_id: '',
        session_id: 's',
      }),
    ).toThrow(/Invalid event/);
  });

  it('rejects empty session_id (zod min(1))', () => {
    expect(() =>
      appendEvent(memoryDir, 'session_started', {
        agent_id: 'a',
        session_id: '',
      }),
    ).toThrow(/Invalid event/);
  });
});

describe('appendEvent — event_id uniqueness across rapid calls', () => {
  it('generates distinct event_ids across many rapid appends', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const ev = appendEvent(memoryDir, 'session_started', {
        agent_id: 'a',
        session_id: 's',
      });
      ids.add(ev.event_id);
    }
    expect(ids.size).toBe(50);
  });

  it('preserves all caller-provided opts in the returned envelope', () => {
    const ev = appendEvent(memoryDir, 'atom_created', {
      agent_id: 'a',
      session_id: 's',
      atom_refs: ['REF-1', 'REF-2'],
      touched_paths: ['ENTITIES/REF-1.md'],
      evidence: ['sha-1', 'sha-2'],
      meta: { key: 'value', count: 7 },
      schema_version: 2,
      atom_snapshot: '---\nid: REF-1\n---\nbody',
      atom_snapshot_hash: 'sha-snap',
    });
    expect(ev.atom_refs).toEqual(['REF-1', 'REF-2']);
    expect(ev.touched_paths).toEqual(['ENTITIES/REF-1.md']);
    expect(ev.evidence).toEqual(['sha-1', 'sha-2']);
    expect(ev.meta).toEqual({ key: 'value', count: 7 });
    expect(ev.schema_version).toBe(2);
    expect(ev.atom_snapshot).toBe('---\nid: REF-1\n---\nbody');
    expect(ev.atom_snapshot_hash).toBe('sha-snap');
  });
});

describe('readEvents — corruption tolerance', () => {
  it('returns [] when events.ndjson does not exist', () => {
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-no-init-'));
    try {
      expect(readEvents(freshDir)).toEqual([]);
    } finally {
      fs.rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it('returns [] on empty file', () => {
    expect(readEvents(memoryDir)).toEqual([]);
  });

  it('skips corrupted JSON lines and returns valid ones', () => {
    appendEvent(memoryDir, 'session_started', {
      agent_id: 'a',
      session_id: 's',
    });
    // Corrupt the log by inserting an unparseable line in the middle.
    const logPath = path.join(memoryDir, 'events.ndjson');
    const existing = fs.readFileSync(logPath, 'utf-8');
    fs.writeFileSync(
      logPath,
      existing + 'this is not json\n{"another corrupted line\n',
    );
    appendEvent(memoryDir, 'reflect_completed', {
      agent_id: 'a',
      session_id: 's',
    });

    const evs = readEvents(memoryDir);
    // 2 valid events, the 2 corrupted lines silently skipped
    expect(evs.length).toBe(2);
    expect(evs.map((e) => e.action)).toEqual(['session_started', 'reflect_completed']);
  });

  it('tolerates trailing whitespace and blank lines', () => {
    appendEvent(memoryDir, 'session_started', {
      agent_id: 'a',
      session_id: 's',
    });
    const logPath = path.join(memoryDir, 'events.ndjson');
    // Add some trailing newlines / blank middle.
    fs.appendFileSync(logPath, '\n\n');
    expect(readEvents(memoryDir).length).toBe(1);
  });
});

describe('readEventsByAction', () => {
  it('filters events by exact action name', () => {
    appendEvent(memoryDir, 'session_started', { agent_id: 'a', session_id: 's' });
    appendEvent(memoryDir, 'reflect_completed', { agent_id: 'a', session_id: 's' });
    appendEvent(memoryDir, 'session_started', { agent_id: 'a', session_id: 's' });

    const sessions = readEventsByAction(memoryDir, 'session_started');
    expect(sessions.length).toBe(2);
    expect(sessions.every((e) => e.action === 'session_started')).toBe(true);
  });

  it('returns [] when no events match', () => {
    appendEvent(memoryDir, 'session_started', { agent_id: 'a', session_id: 's' });
    expect(readEventsByAction(memoryDir, 'gc_completed')).toEqual([]);
  });
});

describe('readEventsForAtoms', () => {
  it('returns events whose atom_refs intersect the requested IDs', () => {
    appendEvent(memoryDir, 'atom_created', {
      agent_id: 'a',
      session_id: 's',
      atom_refs: ['REF-1'],
    });
    appendEvent(memoryDir, 'atom_updated', {
      agent_id: 'a',
      session_id: 's',
      atom_refs: ['REF-2'],
    });
    appendEvent(memoryDir, 'atom_updated', {
      agent_id: 'a',
      session_id: 's',
      atom_refs: ['REF-1', 'REF-2'],
    });

    const hits = readEventsForAtoms(memoryDir, ['REF-1']);
    expect(hits.length).toBe(2);
    expect(hits.every((e) => e.atom_refs?.includes('REF-1'))).toBe(true);
  });

  it('returns [] when no events reference the requested IDs', () => {
    appendEvent(memoryDir, 'atom_created', {
      agent_id: 'a',
      session_id: 's',
      atom_refs: ['REF-1'],
    });
    expect(readEventsForAtoms(memoryDir, ['REF-NONE'])).toEqual([]);
  });
});

describe('countEvents', () => {
  it('returns 0 for missing events.ndjson', () => {
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-no-init-'));
    try {
      expect(countEvents(freshDir)).toBe(0);
    } finally {
      fs.rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it('returns 0 for an empty events.ndjson', () => {
    expect(countEvents(memoryDir)).toBe(0);
  });

  it('matches readEvents().length even when corrupted lines are present', () => {
    appendEvent(memoryDir, 'session_started', { agent_id: 'a', session_id: 's' });
    appendEvent(memoryDir, 'session_started', { agent_id: 'a', session_id: 's' });

    const logPath = path.join(memoryDir, 'events.ndjson');
    const existing = fs.readFileSync(logPath, 'utf-8');
    fs.writeFileSync(logPath, existing + 'corrupted-not-json\n\n{"truncated\n');

    expect(countEvents(memoryDir)).toBe(readEvents(memoryDir).length);
    expect(countEvents(memoryDir)).toBe(2);
  });
});

describe('getLastEventId', () => {
  it('returns undefined when events.ndjson is missing', () => {
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-no-init-'));
    try {
      expect(getLastEventId(freshDir)).toBeUndefined();
    } finally {
      fs.rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it('returns undefined when events.ndjson is empty', () => {
    expect(getLastEventId(memoryDir)).toBeUndefined();
  });

  it('returns the event_id of the last event on a multi-event log', () => {
    appendEvent(memoryDir, 'session_started', { agent_id: 'a', session_id: 's' });
    const last = appendEvent(memoryDir, 'reflect_completed', {
      agent_id: 'a',
      session_id: 's',
    });
    expect(getLastEventId(memoryDir)).toBe(last.event_id);
  });

  it('returns undefined when the last line is unparseable (matches readEvents tolerance)', () => {
    appendEvent(memoryDir, 'session_started', { agent_id: 'a', session_id: 's' });
    // Append a corrupted last line — getLastEventId reads from the end
    const logPath = path.join(memoryDir, 'events.ndjson');
    fs.appendFileSync(logPath, '{"this is not a valid event\n');
    expect(getLastEventId(memoryDir)).toBeUndefined();
  });
});
