/**
 * Event Schema V2 tests — backward compatibility and new fields.
 */

import { describe, it, expect } from 'vitest';
import {
  validateEvent,
  MUTATION_ACTIONS,
  isMutationAction,
} from '../src/index.js';
import type { MemoryEvent } from '../src/index.js';

const BASE_EVENT = {
  event_id: 'evt-test-1',
  timestamp: '2026-03-10T00:00:00Z',
  agent_id: 'test-agent',
  session_id: 'test-session',
  action: 'atom_created' as const,
};

describe('MemoryEventSchema v2', () => {
  it('accepts v1 events (no schema_version)', () => {
    const result = validateEvent(BASE_EVENT);
    expect(result.success).toBe(true);
  });

  it('accepts v2 events with schema_version: 2', () => {
    const result = validateEvent({ ...BASE_EVENT, schema_version: 2 });
    expect(result.success).toBe(true);
  });

  it('accepts v2 events with atom_snapshot', () => {
    const result = validateEvent({
      ...BASE_EVENT,
      schema_version: 2,
      atom_snapshot: '---\nid: TEST-001\n---\n\nBody text',
    });
    expect(result.success).toBe(true);
  });

  it('accepts v2 events with atom_snapshot_hash', () => {
    const result = validateEvent({
      ...BASE_EVENT,
      schema_version: 2,
      atom_snapshot_hash: 'a'.repeat(64),
    });
    expect(result.success).toBe(true);
  });

  it('accepts v2 events with both snapshot and hash', () => {
    const result = validateEvent({
      ...BASE_EVENT,
      schema_version: 2,
      atom_snapshot: 'inline content',
      atom_snapshot_hash: 'b'.repeat(64),
    });
    expect(result.success).toBe(true);
  });

  it('rejects schema_version other than 2', () => {
    const result = validateEvent({ ...BASE_EVENT, schema_version: 1 });
    expect(result.success).toBe(false);
  });

  it('accepts atom_imported action', () => {
    const result = validateEvent({ ...BASE_EVENT, action: 'atom_imported' });
    expect(result.success).toBe(true);
  });

  it('still rejects invalid actions', () => {
    const result = validateEvent({ ...BASE_EVENT, action: 'bogus_action' });
    expect(result.success).toBe(false);
  });
});

describe('MUTATION_ACTIONS', () => {
  it('contains all mutation actions', () => {
    expect(MUTATION_ACTIONS).toContain('atom_created');
    expect(MUTATION_ACTIONS).toContain('atom_updated');
    expect(MUTATION_ACTIONS).toContain('atom_archived');
    expect(MUTATION_ACTIONS).toContain('atom_promoted');
    expect(MUTATION_ACTIONS).toContain('atom_expired');
    expect(MUTATION_ACTIONS).toContain('atom_imported');
    // #109: conflict_resolved is a terminal mutation (archives the conflict
    //       atom and carries the final snapshot) — must be tracked by
    //       compactLog and replay alongside the other archive-like actions.
    expect(MUTATION_ACTIONS).toContain('conflict_resolved');
    // #247: human_edit carries a full post-edit snapshot (mk edit forward path
    //       + reflect backfill) — a non-terminal mutation, tracked like
    //       atom_updated by compactLog and replay.
    expect(MUTATION_ACTIONS).toContain('human_edit');
  });

  it('does not contain non-mutation actions', () => {
    expect(MUTATION_ACTIONS).not.toContain('checkpoint_created');
    expect(MUTATION_ACTIONS).not.toContain('reflect_completed');
    expect(MUTATION_ACTIONS).not.toContain('session_started');
  });
});

describe('isMutationAction', () => {
  it('returns true for all mutation actions', () => {
    for (const action of MUTATION_ACTIONS) {
      expect(isMutationAction(action)).toBe(true);
    }
  });

  it('returns false for non-mutation actions', () => {
    expect(isMutationAction('checkpoint_created')).toBe(false);
    expect(isMutationAction('reflect_completed')).toBe(false);
    expect(isMutationAction('gc_completed')).toBe(false);
    expect(isMutationAction('session_started')).toBe(false);
    expect(isMutationAction('session_ended')).toBe(false);
    expect(isMutationAction('conflict_detected')).toBe(false);
    // #247: human_edit moved INTO MUTATION_ACTIONS (covered by the loop above).
    // #109: conflict_resolved IS a mutation (archives the atom)
    expect(isMutationAction('conflict_resolved')).toBe(true);
  });

  it('returns false for unknown actions', () => {
    expect(isMutationAction('bogus')).toBe(false);
  });
});

// #111: MemoryEvent is a discriminated union on schema_version. Narrowing
//       on `event.schema_version === 2` must reveal V2-only fields without
//       a cast. This is a type-level guarantee; the runtime check below
//       just exercises the narrowing path so a regression in the union
//       layout would show up as a `tsc` error.
describe('MemoryEvent discriminated union (#111)', () => {
  it('narrows to V2 when schema_version === 2', () => {
    const v2: MemoryEvent = {
      event_id: 'evt-v2',
      timestamp: '2026-03-10T00:00:00Z',
      agent_id: 'a',
      session_id: 's',
      action: 'atom_created',
      schema_version: 2,
      atom_snapshot: '---\nid: X\n---\nbody',
    };
    if (v2.schema_version === 2) {
      // After narrowing, atom_snapshot is typed as string | undefined.
      expect(v2.atom_snapshot).toBe('---\nid: X\n---\nbody');
    } else {
      throw new Error('narrowing failed');
    }
  });

  it('narrows to V1 when schema_version is absent', () => {
    const v1: MemoryEvent = {
      event_id: 'evt-v1',
      timestamp: '2026-03-10T00:00:00Z',
      agent_id: 'a',
      session_id: 's',
      action: 'session_started',
    };
    expect(v1.schema_version).toBeUndefined();
    expect(v1.atom_snapshot).toBeUndefined();
  });
});
