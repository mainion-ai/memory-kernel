import { describe, it, expect } from 'vitest';
import { parseEventLine, isMutationEvent } from '../src/event-parser.js';

describe('parseEventLine', () => {
  it('parses a v2 atom_created event with snapshot', () => {
    const line = JSON.stringify({
      event_id: 'EVT-001',
      timestamp: '2026-04-01T10:00:00Z',
      agent_id: 'a',
      session_id: 's',
      action: 'atom_created',
      atom_refs: ['FACT-2026-04-01-X-aa00'],
      schema_version: 2,
      atom_snapshot: '---\nid: FACT-2026-04-01-X-aa00\n---\nbody',
    });
    const ev = parseEventLine(line);
    expect(ev).not.toBeNull();
    expect(ev!.action).toBe('atom_created');
    expect(ev!.atom_snapshot).toContain('FACT-2026-04-01-X-aa00');
    expect(ev!.timestamp).toBe('2026-04-01T10:00:00Z');
  });

  it('returns null for malformed JSON', () => {
    expect(parseEventLine('not json')).toBeNull();
    expect(parseEventLine('{')).toBeNull();
  });

  it('returns null when required fields missing', () => {
    expect(parseEventLine(JSON.stringify({ action: 'atom_created' }))).toBeNull();
    expect(parseEventLine(JSON.stringify({ event_id: 'X', action: 'x' }))).toBeNull();
  });

  it('returns null on empty / whitespace lines', () => {
    expect(parseEventLine('')).toBeNull();
    expect(parseEventLine('   ')).toBeNull();
  });
});

describe('isMutationEvent', () => {
  it('returns true for the five mutation actions', () => {
    for (const a of ['atom_created', 'atom_updated', 'atom_archived', 'atom_promoted', 'atom_expired']) {
      expect(isMutationEvent({ action: a } as never)).toBe(true);
    }
  });

  it('returns false for non-mutation actions', () => {
    expect(isMutationEvent({ action: 'recall' } as never)).toBe(false);
    expect(isMutationEvent({ action: 'wander' } as never)).toBe(false);
    expect(isMutationEvent({ action: 'compact' } as never)).toBe(false);
  });
});
