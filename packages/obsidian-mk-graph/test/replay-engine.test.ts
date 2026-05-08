import { describe, it, expect } from 'vitest';
import { replayEvents } from '../src/replay-engine.js';
import type { PluginEvent } from '../src/event-parser.js';
import type { ParsedAtom } from '../src/atom-parser.js';

const snap = (id: string, ts: string, body = 'b') =>
  `---\nid: ${id}\ntype: fact\nstatus: active\nclassification: TEAM\nconfidence: 0.9\ncreated_at: "${ts}"\nupdated_at: "${ts}"\nttl_days: null\n---\n\n${body}\n`;

const evCreate = (id: string, ts: string): PluginEvent => ({
  event_id: `EVT-${id}`,
  timestamp: ts,
  agent_id: 'a',
  session_id: 's',
  action: 'atom_created',
  atom_refs: [id],
  atom_snapshot: snap(id, ts),
  schema_version: 2,
});

const evArchive = (id: string, ts: string): PluginEvent => ({
  event_id: `EVT-A-${id}`,
  timestamp: ts,
  agent_id: 'a',
  session_id: 's',
  action: 'atom_archived',
  atom_refs: [id],
  schema_version: 2,
});

describe('replayEvents', () => {
  it('returns empty map for empty input', () => {
    expect(replayEvents([]).size).toBe(0);
  });

  it('reconstructs atoms from atom_created snapshots', () => {
    const out = replayEvents([
      evCreate('FACT-A', '2026-04-01T10:00:00Z'),
      evCreate('FACT-B', '2026-04-02T10:00:00Z'),
    ]);
    expect(out.size).toBe(2);
    expect(out.get('FACT-A')?.id).toBe('FACT-A');
    expect(out.get('FACT-B')?.id).toBe('FACT-B');
  });

  it('removes atoms on atom_archived', () => {
    const out = replayEvents([
      evCreate('FACT-A', '2026-04-01T10:00:00Z'),
      evArchive('FACT-A', '2026-04-02T10:00:00Z'),
    ]);
    expect(out.size).toBe(0);
  });

  it('atom_updated replaces snapshot', () => {
    const out = replayEvents([
      evCreate('FACT-A', '2026-04-01T10:00:00Z'),
      {
        ...evCreate('FACT-A', '2026-04-02T10:00:00Z'),
        action: 'atom_updated',
        atom_snapshot: snap('FACT-A', '2026-04-02T10:00:00Z', 'updated body'),
      },
    ]);
    expect(out.get('FACT-A')?.updatedAt).toBe('2026-04-02T10:00:00Z');
    expect(out.get('FACT-A')?.body).toContain('updated body');
  });

  it('honours target T cutoff (events with ts > T are ignored)', () => {
    const out = replayEvents(
      [
        evCreate('FACT-A', '2026-04-01T10:00:00Z'),
        evCreate('FACT-B', '2026-04-05T10:00:00Z'),
      ],
      { targetTimestamp: '2026-04-03T00:00:00Z' },
    );
    expect(out.size).toBe(1);
    expect(out.has('FACT-A')).toBe(true);
    expect(out.has('FACT-B')).toBe(false);
  });

  it('ignores non-mutation events', () => {
    const out = replayEvents([
      evCreate('FACT-A', '2026-04-01T10:00:00Z'),
      { event_id: 'X', timestamp: '2026-04-02T10:00:00Z', agent_id: 'a', session_id: 's', action: 'recall' },
      { event_id: 'Y', timestamp: '2026-04-03T10:00:00Z', agent_id: 'a', session_id: 's', action: 'wander' },
    ]);
    expect(out.size).toBe(1);
  });

  it('falls back to fallbackAtoms when snapshot is missing (V1 events)', () => {
    const fallback: ParsedAtom[] = [{
      id: 'FACT-LEGACY',
      type: 'fact',
      status: 'active',
      classification: 'TEAM',
      confidence: 1,
      createdAt: '2026-03-01T10:00:00Z',
      updatedAt: '2026-03-01T10:00:00Z',
      ttlDays: null,
      tags: [],
      relations: [],
      body: 'legacy body',
    }];
    const out = replayEvents(
      [
        // V1 event — no schema_version, no snapshot.
        { event_id: 'X', timestamp: '2026-03-01T10:00:00Z', agent_id: 'a', session_id: 's', action: 'atom_created', atom_refs: ['FACT-LEGACY'] },
      ],
      { fallbackAtoms: fallback },
    );
    expect(out.get('FACT-LEGACY')?.body).toBe('legacy body');
  });

  it('sorts events by timestamp before processing', () => {
    // Create with later ts, then archive with earlier ts — the create should
    // win because replay processes in timestamp order, not file order.
    const out = replayEvents([
      evArchive('FACT-A', '2026-04-01T10:00:00Z'),
      evCreate('FACT-A', '2026-04-02T10:00:00Z'),
    ]);
    expect(out.size).toBe(1);
    expect(out.has('FACT-A')).toBe(true);
  });

  it('inherits filePath from fallback so click-to-open works in Scrubbed/Diff', () => {
    // Snapshot-derived atoms have no filePath of their own (parseAtomFile
    // only sets it when given an explicit path). Without inheritance, click-
    // to-open silently no-ops in Scrubbed / Diff modes.
    const fallback: ParsedAtom[] = [{
      id: 'FACT-A',
      type: 'fact',
      status: 'active',
      classification: 'TEAM',
      confidence: 1,
      createdAt: '2026-04-01T10:00:00Z',
      updatedAt: '2026-04-01T10:00:00Z',
      ttlDays: null,
      tags: [],
      relations: [],
      body: '',
      filePath: '/abs/path/ENTITIES/FACT-A.md',
    }];
    const out = replayEvents(
      [evCreate('FACT-A', '2026-04-01T10:00:00Z')],
      { fallbackAtoms: fallback },
    );
    expect(out.get('FACT-A')?.filePath).toBe('/abs/path/ENTITIES/FACT-A.md');
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseEventLine } from '../src/event-parser.js';

describe('replayEvents on small-vault fixture', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const eventsPath = path.join(here, 'fixtures', 'small-vault', 'events.ndjson');

  it('reconstructs the post-archive state (20 created − 2 archived = 18 atoms)', () => {
    const raw = readFileSync(eventsPath, 'utf-8');
    const events = raw.split('\n').map(parseEventLine).filter((e): e is NonNullable<typeof e> => e !== null);
    const out = replayEvents(events);
    expect(out.size).toBe(18);
  });

  it('reconstructs pre-archive state when T is set before archives', () => {
    const raw = readFileSync(eventsPath, 'utf-8');
    const events = raw.split('\n').map(parseEventLine).filter((e): e is NonNullable<typeof e> => e !== null);
    const out = replayEvents(events, { targetTimestamp: '2026-04-25T23:59:59Z' });
    expect(out.size).toBe(20);
  });
});
