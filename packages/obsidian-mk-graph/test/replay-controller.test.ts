import { describe, it, expect, vi } from 'vitest';
import { ReplayController } from '../src/replay-controller.js';
import type { ParsedAtom } from '../src/atom-parser.js';
import type { PluginEvent } from '../src/event-parser.js';

const atom = (id: string, updatedAt = '2026-04-01T10:00:00Z'): ParsedAtom => ({
  id, type: 'fact', status: 'active', classification: 'TEAM',
  confidence: 1, createdAt: updatedAt, updatedAt, ttlDays: null,
  tags: [], relations: [], body: '',
});

const ev = (id: string, ts: string, action = 'atom_created'): PluginEvent => ({
  event_id: id, timestamp: ts, agent_id: 'a', session_id: 's',
  action,
  atom_refs: [id],
  atom_snapshot: action === 'atom_archived'
    ? undefined
    : `---\nid: ${id}\ntype: fact\nstatus: active\nclassification: TEAM\nconfidence: 1\ncreated_at: "${ts}"\nupdated_at: "${ts}"\nttl_days: null\n---\n\n`,
  schema_version: 2,
});

describe('ReplayController', () => {
  it('Live mode emits the current atom set from fallbackAtoms', () => {
    const onState = vi.fn();
    const c = new ReplayController({ onState });
    c.setEvents([ev('A', '2026-04-01T10:00:00Z'), ev('B', '2026-04-02T10:00:00Z')]);
    c.setFallbackAtoms([atom('A'), atom('B')]);
    c.setMode('live');
    expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ atoms: expect.any(Array) }));
    const last = onState.mock.calls[onState.mock.calls.length - 1][0];
    expect(last.atoms.map((a: ParsedAtom) => a.id).sort()).toEqual(['A', 'B']);
    expect(last.diff).toBeUndefined();
  });

  it('Scrubbed mode replays events to the playhead', () => {
    const onState = vi.fn();
    const c = new ReplayController({ onState });
    c.setEvents([
      ev('A', '2026-04-01T10:00:00Z'),
      ev('B', '2026-04-05T10:00:00Z'),
    ]);
    c.setMode('scrubbed');
    c.setPlayhead('2026-04-03T00:00:00Z');
    const last = onState.mock.calls[onState.mock.calls.length - 1][0];
    expect(last.atoms.map((a: ParsedAtom) => a.id)).toEqual(['A']);
  });

  it('Diff mode replays at T1 and T2 and emits a DiffSet', () => {
    const onState = vi.fn();
    const c = new ReplayController({ onState });
    c.setEvents([
      ev('A', '2026-04-01T10:00:00Z'),
      ev('B', '2026-04-05T10:00:00Z'),
      ev('A', '2026-04-10T10:00:00Z', 'atom_archived'),
    ]);
    c.setDiffRange('2026-04-02T00:00:00Z', '2026-04-15T00:00:00Z');
    c.setMode('diff');
    const last = onState.mock.calls[onState.mock.calls.length - 1][0];
    expect(last.diff).toBeDefined();
    expect([...last.diff.added]).toEqual(['B']);
    expect([...last.diff.removed]).toEqual(['A']);
  });

  it('switching mode re-emits state', () => {
    const onState = vi.fn();
    const c = new ReplayController({ onState });
    c.setEvents([ev('A', '2026-04-01T10:00:00Z')]);
    c.setFallbackAtoms([atom('A')]);
    onState.mockClear();
    c.setMode('live');
    c.setMode('scrubbed');
    expect(onState).toHaveBeenCalledTimes(2);
  });
});
