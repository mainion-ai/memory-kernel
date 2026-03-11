/**
 * Renderer tests — pure function tests for view materialization.
 */

import { describe, it, expect } from 'vitest';
import type { Atom, MemoryEvent } from '../src/types.js';
import {
  renderIndex,
  renderDecisions,
  renderConstraints,
  renderOpenQuestions,
  renderHandoff,
} from '../src/renderers.js';

// --- Test helpers ---

function makeAtom(overrides: Partial<Atom['frontmatter']> & { body?: string }): Atom {
  const { body, ...fmOverrides } = overrides;
  return {
    frontmatter: {
      id: 'TEST-2026-03-10-STUB-0001',
      type: 'fact',
      status: 'active',
      confidence: 0.8,
      created_at: '2026-03-01T00:00:00Z',
      updated_at: '2026-03-10T00:00:00Z',
      ttl_days: null,
      ...fmOverrides,
    },
    body: body ?? 'Test body content',
  };
}

function makeEvent(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    event_id: 'evt-001',
    timestamp: '2026-03-10T12:00:00Z',
    agent_id: 'test-agent',
    session_id: 'session-1',
    action: 'atom_created',
    ...overrides,
  };
}

const FIXED_TS = '2026-03-10T00:00:00Z';

// --- renderIndex ---

describe('renderIndex', () => {
  it('returns valid frontmatter with type and updated_at', () => {
    const output = renderIndex([], FIXED_TS);
    expect(output).toContain('type: index');
    expect(output).toContain(`updated_at: ${FIXED_TS}`);
  });

  it('renders empty state', () => {
    const output = renderIndex([], FIXED_TS);
    expect(output).toContain('# Memory Index');
    expect(output).toContain('Decisions (0)');
    expect(output).toContain('Constraints (0)');
    expect(output).toContain('Open Questions (0)');
    expect(output).toContain('Entities (0)');
  });

  it('groups atoms by type', () => {
    const atoms = [
      makeAtom({ id: 'DECI-001', type: 'decision', status: 'accepted', body: 'Use TypeScript' }),
      makeAtom({ id: 'CONS-001', type: 'constraint', body: 'Max 200 lines' }),
      makeAtom({ id: 'OQST-001', type: 'open_question', body: 'Which CRDT?' }),
      makeAtom({ id: 'ENTS-001', type: 'entity_summary', body: 'API module' }),
      makeAtom({ id: 'FACT-001', type: 'fact', body: 'Some fact' }),
    ];
    const output = renderIndex(atoms, FIXED_TS);
    expect(output).toContain('Decisions (1)');
    expect(output).toContain('Constraints (1)');
    expect(output).toContain('Open Questions (1)');
    expect(output).toContain('Entities (1)');
    expect(output).toContain('1 facts');
  });

  it('shows conflicts section when conflicts exist', () => {
    const atoms = [
      makeAtom({ id: 'CNFL-001', type: 'conflict', status: 'active', body: 'Conflicting decisions' }),
    ];
    const output = renderIndex(atoms, FIXED_TS);
    expect(output).toContain('Active Conflicts (1)');
    expect(output).toContain('CNFL-001');
  });

  it('excludes archived and expired atoms', () => {
    const atoms = [
      makeAtom({ id: 'DECI-001', type: 'decision', status: 'archived', body: 'Old' }),
      makeAtom({ id: 'DECI-002', type: 'decision', status: 'expired', body: 'Gone' }),
      makeAtom({ id: 'DECI-003', type: 'decision', status: 'active', body: 'Current' }),
    ];
    const output = renderIndex(atoms, FIXED_TS);
    expect(output).toContain('Decisions (1)');
    expect(output).toContain('DECI-003');
    expect(output).not.toContain('DECI-001');
    expect(output).not.toContain('DECI-002');
  });

  it('is deterministic — same input produces same output', () => {
    const atoms = [
      makeAtom({ id: 'DECI-001', type: 'decision', body: 'D1' }),
      makeAtom({ id: 'FACT-001', type: 'fact', body: 'F1' }),
    ];
    const a = renderIndex(atoms, FIXED_TS);
    const b = renderIndex(atoms, FIXED_TS);
    expect(a).toBe(b);
  });

  it('enforces budget when set', () => {
    const atoms = Array.from({ length: 50 }, (_, i) =>
      makeAtom({ id: `DECI-${i}`, type: 'decision', body: `Decision ${i}` }),
    );
    const output = renderIndex(atoms, FIXED_TS, { maxLines: 20 });
    const lines = output.split('\n');
    // Account for trailing newline
    expect(lines.length - 1).toBeLessThanOrEqual(20);
    expect(output).toContain('truncated');
  });
});

// --- renderDecisions ---

describe('renderDecisions', () => {
  it('returns valid frontmatter', () => {
    const output = renderDecisions([], FIXED_TS);
    expect(output).toContain('type: view');
    expect(output).toContain(`updated_at: ${FIXED_TS}`);
  });

  it('renders empty state', () => {
    const output = renderDecisions([], FIXED_TS);
    expect(output).toContain('No decisions recorded.');
  });

  it('groups decisions by status', () => {
    const atoms = [
      makeAtom({ id: 'DECI-001', type: 'decision', status: 'accepted', body: 'Accepted one' }),
      makeAtom({ id: 'DECI-002', type: 'decision', status: 'active', body: 'Active one' }),
      makeAtom({ id: 'DECI-003', type: 'decision', status: 'draft', body: 'Draft one' }),
    ];
    const output = renderDecisions(atoms, FIXED_TS);
    expect(output).toContain('## Accepted (1)');
    expect(output).toContain('## Active (1)');
    expect(output).toContain('## Draft (1)');
  });

  it('excludes non-decision atoms', () => {
    const atoms = [
      makeAtom({ id: 'DECI-001', type: 'decision', status: 'active', body: 'Real decision' }),
      makeAtom({ id: 'FACT-001', type: 'fact', body: 'Not a decision' }),
    ];
    const output = renderDecisions(atoms, FIXED_TS);
    expect(output).toContain('DECI-001');
    expect(output).not.toContain('FACT-001');
  });

  it('shows confidence for each decision', () => {
    const atoms = [
      makeAtom({ id: 'DECI-001', type: 'decision', status: 'active', confidence: 0.9, body: 'High confidence' }),
    ];
    const output = renderDecisions(atoms, FIXED_TS);
    expect(output).toContain('confidence: 0.9');
  });
});

// --- renderConstraints ---

describe('renderConstraints', () => {
  it('renders empty state', () => {
    const output = renderConstraints([], FIXED_TS);
    expect(output).toContain('No constraints recorded.');
  });

  it('lists active constraints', () => {
    const atoms = [
      makeAtom({ id: 'CONS-001', type: 'constraint', body: 'Max 200 lines per view' }),
      makeAtom({ id: 'CONS-002', type: 'constraint', body: 'No LLM in v0.1' }),
    ];
    const output = renderConstraints(atoms, FIXED_TS);
    expect(output).toContain('Active (2)');
    expect(output).toContain('CONS-001');
    expect(output).toContain('CONS-002');
  });

  it('excludes archived constraints', () => {
    const atoms = [
      makeAtom({ id: 'CONS-001', type: 'constraint', status: 'archived', body: 'Old rule' }),
    ];
    const output = renderConstraints(atoms, FIXED_TS);
    expect(output).toContain('No constraints recorded.');
  });
});

// --- renderOpenQuestions ---

describe('renderOpenQuestions', () => {
  it('renders empty state', () => {
    const output = renderOpenQuestions([], FIXED_TS);
    expect(output).toContain('No open questions.');
  });

  it('separates open and resolved questions', () => {
    const atoms = [
      makeAtom({ id: 'OQST-001', type: 'open_question', status: 'active', body: 'Which CRDT?' }),
      makeAtom({ id: 'OQST-002', type: 'open_question', status: 'resolved', body: 'Answered' }),
    ];
    const output = renderOpenQuestions(atoms, FIXED_TS);
    expect(output).toContain('## Open (1)');
    expect(output).toContain('## Resolved (1)');
  });

  it('shows age for open questions', () => {
    const created = '2026-03-01T00:00:00Z';
    const now = new Date('2026-03-10T00:00:00Z').getTime();
    const atoms = [
      makeAtom({ id: 'OQST-001', type: 'open_question', status: 'active', created_at: created, body: 'Q' }),
    ];
    const output = renderOpenQuestions(atoms, FIXED_TS, undefined, now);
    expect(output).toContain('age: 9d');
  });

  it('shows resolved date for resolved questions', () => {
    const atoms = [
      makeAtom({
        id: 'OQST-001', type: 'open_question', status: 'resolved',
        updated_at: '2026-03-08T00:00:00Z', body: 'Answered',
      }),
    ];
    const output = renderOpenQuestions(atoms, FIXED_TS);
    expect(output).toContain('resolved 2026-03-08');
  });

  it('strikes through resolved question IDs', () => {
    const atoms = [
      makeAtom({ id: 'OQST-001', type: 'open_question', status: 'resolved', body: 'Done' }),
    ];
    const output = renderOpenQuestions(atoms, FIXED_TS);
    expect(output).toContain('~~OQST-001~~');
  });
});

// --- renderHandoff ---

describe('renderHandoff', () => {
  it('returns valid frontmatter', () => {
    const output = renderHandoff([], [], FIXED_TS);
    expect(output).toContain('type: handoff');
    expect(output).toContain(`updated_at: ${FIXED_TS}`);
  });

  it('shows status summary with atom counts', () => {
    const atoms = [
      makeAtom({ id: 'DECI-001', type: 'decision', body: 'D1' }),
      makeAtom({ id: 'FACT-001', type: 'fact', body: 'F1' }),
      makeAtom({ id: 'FACT-002', type: 'fact', body: 'F2' }),
    ];
    const output = renderHandoff(atoms, [], FIXED_TS);
    expect(output).toContain('3 active atoms');
    expect(output).toContain('1 decision');
    expect(output).toContain('2 facts');
  });

  it('shows recent events from last session', () => {
    const events: MemoryEvent[] = [
      makeEvent({ session_id: 'old', action: 'atom_created', atom_refs: ['OLD-001'] }),
      makeEvent({ session_id: 'latest', action: 'atom_created', atom_refs: ['NEW-001'] }),
      makeEvent({ session_id: 'latest', action: 'atom_updated', atom_refs: ['NEW-002'] }),
    ];
    const output = renderHandoff([], events, FIXED_TS);
    expect(output).toContain('atom_created');
    expect(output).toContain('NEW-001');
    expect(output).toContain('atom_updated');
    // Should not show old session events in recent activity
    expect(output).not.toContain('OLD-001');
  });

  it('shows "No recent activity" when no events', () => {
    const output = renderHandoff([], [], FIXED_TS);
    expect(output).toContain('No recent activity.');
  });

  it('shows "None" for no conflicts', () => {
    const output = renderHandoff([], [], FIXED_TS);
    expect(output).toMatch(/Active Conflicts.*\n+.*_None\._/);
  });

  it('lists active conflicts', () => {
    const atoms = [
      makeAtom({ id: 'CNFL-001', type: 'conflict', status: 'active', body: 'Disagreement on API' }),
    ];
    const output = renderHandoff(atoms, [], FIXED_TS);
    expect(output).toContain('CNFL-001');
    expect(output).toContain('1 active conflict');
  });

  it('shows top 5 decisions', () => {
    const atoms = Array.from({ length: 8 }, (_, i) =>
      makeAtom({ id: `DECI-${i}`, type: 'decision', body: `Decision ${i}` }),
    );
    const output = renderHandoff(atoms, [], FIXED_TS);
    expect(output).toContain('Key Decisions (5 of 8)');
    expect(output).toContain('DECI-0');
    // Status section may also mention decision counts, so check section specifically
    expect(output).toContain('5 of 8');
  });

  it('shows open questions', () => {
    const atoms = [
      makeAtom({ id: 'OQST-001', type: 'open_question', status: 'active', body: 'Which CRDT?' }),
      makeAtom({ id: 'OQST-002', type: 'open_question', status: 'resolved', body: 'Answered' }),
    ];
    const output = renderHandoff(atoms, [], FIXED_TS);
    expect(output).toContain('Open Questions (1)');
    expect(output).toContain('OQST-001');
    // Resolved should not appear in handoff open questions
    expect(output).not.toContain('OQST-002');
  });

  it('enforces budget', () => {
    const atoms = Array.from({ length: 30 }, (_, i) =>
      makeAtom({ id: `DECI-${i}`, type: 'decision', body: `Decision ${i}` }),
    );
    const output = renderHandoff(atoms, [], FIXED_TS, { maxLines: 30 });
    const lines = output.split('\n');
    expect(lines.length - 1).toBeLessThanOrEqual(30);
    expect(output).toContain('truncated');
  });

  it('is deterministic', () => {
    const atoms = [
      makeAtom({ id: 'DECI-001', type: 'decision', body: 'D1' }),
      makeAtom({ id: 'FACT-001', type: 'fact', body: 'F1' }),
    ];
    const events = [makeEvent()];
    const a = renderHandoff(atoms, events, FIXED_TS);
    const b = renderHandoff(atoms, events, FIXED_TS);
    expect(a).toBe(b);
  });
});

// --- Cross-cutting ---

describe('renderer cross-cutting', () => {
  it('all renderers produce trailing newline', () => {
    expect(renderIndex([], FIXED_TS).endsWith('\n')).toBe(true);
    expect(renderDecisions([], FIXED_TS).endsWith('\n')).toBe(true);
    expect(renderConstraints([], FIXED_TS).endsWith('\n')).toBe(true);
    expect(renderOpenQuestions([], FIXED_TS).endsWith('\n')).toBe(true);
    expect(renderHandoff([], [], FIXED_TS).endsWith('\n')).toBe(true);
  });

  it('all renderers start with YAML frontmatter', () => {
    const outputs = [
      renderIndex([], FIXED_TS),
      renderDecisions([], FIXED_TS),
      renderConstraints([], FIXED_TS),
      renderOpenQuestions([], FIXED_TS),
      renderHandoff([], [], FIXED_TS),
    ];
    for (const output of outputs) {
      expect(output.startsWith('---\n')).toBe(true);
      expect(output).toContain('updated_at:');
    }
  });
});
