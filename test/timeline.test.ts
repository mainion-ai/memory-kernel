import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  initMemoryDir,
  createAtom,
  closeAllIndexes,
} from '../src/index.js';
import { getTimeline } from '../src/timeline.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-timeline-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('getTimeline', () => {
  it('returns events with inline atom_snapshot for v2 mutation events', () => {
    createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'first',
      body: 'First fact.',
    });

    const result = getTimeline({ memoryDir: testDir });
    expect(result.events.length).toBeGreaterThan(0);
    const created = result.events.find(e => e.action === 'atom_created');
    expect(created).toBeDefined();
    expect(created!.atom_snapshot).toBeDefined();
    expect(created!.atom_snapshot).toMatch(/type: fact/);
  });

  it('filters events by from/to time range', () => {
    const before = new Date(Date.now() - 60_000).toISOString();
    createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'a',
      body: 'A.',
    });
    const after = new Date(Date.now() + 60_000).toISOString();

    // Time window includes the just-created atom
    const inWindow = getTimeline({ memoryDir: testDir, from: before, to: after });
    expect(inWindow.events.length).toBeGreaterThan(0);

    // Time window before atom existed: empty
    const empty = getTimeline({
      memoryDir: testDir,
      from: '2020-01-01T00:00:00Z',
      to: '2020-01-02T00:00:00Z',
    });
    expect(empty.events).toHaveLength(0);
  });

  it('emits redacted snapshot for SECRET atoms when key is unavailable at read time', () => {
    // SECRET atoms are only encrypted when a key is present at WRITE time
    // (see snapshotAtom() in src/retain.ts). To exercise the redaction path,
    // we set a key during create (encrypts the snapshot), then unset it before
    // calling getTimeline (forces the decryption-failure → redacted=true path).
    const previousKey = process.env.MEMORY_ENCRYPTION_KEY;
    process.env.MEMORY_ENCRYPTION_KEY = 'test-key-32-bytes-aaaaaaaaaaaaaa';

    try {
      createAtom({
        memoryDir: testDir,
        agent_id: 'a', session_id: 's',
        type: 'fact', slug: 'secret',
        body: 'Secret content.',
        classification: 'SECRET',
      });

      // Now unset the key — getTimeline will see encrypted snapshots it cannot decrypt
      delete process.env.MEMORY_ENCRYPTION_KEY;

      const result = getTimeline({ memoryDir: testDir });
      const created = result.events.find(e => e.action === 'atom_created');
      expect(created!.redacted).toBe(true);
      expect(created!.atom_snapshot).toBeUndefined();
    } finally {
      if (previousKey !== undefined) process.env.MEMORY_ENCRYPTION_KEY = previousKey;
      else delete process.env.MEMORY_ENCRYPTION_KEY;
    }
  });

  it('returns events sorted by timestamp ascending', () => {
    createAtom({ memoryDir: testDir, agent_id: 'a', session_id: 's', type: 'fact', slug: 'first', body: '1' });
    createAtom({ memoryDir: testDir, agent_id: 'a', session_id: 's', type: 'fact', slug: 'second', body: '2' });
    createAtom({ memoryDir: testDir, agent_id: 'a', session_id: 's', type: 'fact', slug: 'third', body: '3' });

    const result = getTimeline({ memoryDir: testDir });
    for (let i = 1; i < result.events.length; i++) {
      expect(result.events[i].timestamp >= result.events[i - 1].timestamp).toBe(true);
    }
  });
});
