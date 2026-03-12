/**
 * Recall audit logging tests.
 * Verifies that 'atom_read' events are emitted when recall() is called
 * with agent_id/session_id, and not emitted when those fields are absent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  initMemoryDir,
  createAtom,
  recall,
  readEventsByAction,
  closeAllIndexes,
} from '../src/index.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-audit-'));
  initMemoryDir(testDir);
  // Create a couple of atoms to recall
  createAtom({
    memoryDir: testDir,
    agent_id: 'setup',
    session_id: 'setup',
    type: 'fact',
    slug: 'alpha',
    body: 'Alpha fact body',
  });
  createAtom({
    memoryDir: testDir,
    agent_id: 'setup',
    session_id: 'setup',
    type: 'fact',
    slug: 'beta',
    body: 'Beta fact body',
  });
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('recall audit logging', () => {
  it('emits atom_read event when agent_id and session_id are provided', () => {
    recall(testDir, { agent_id: 'agent1', session_id: 'session1' });

    const auditEvents = readEventsByAction(testDir, 'atom_read');
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].agent_id).toBe('agent1');
    expect(auditEvents[0].session_id).toBe('session1');
    expect(auditEvents[0].meta?.operation).toBe('recall');
  });

  it('includes returned atom IDs in atom_refs', () => {
    const bundle = recall(testDir, { agent_id: 'agent1', session_id: 'session1' });
    const auditEvents = readEventsByAction(testDir, 'atom_read');
    const event = auditEvents[0];

    expect(event.atom_refs).toBeDefined();
    expect(event.atom_refs!.length).toBe(bundle.atoms.length);
    for (const atom of bundle.atoms) {
      expect(event.atom_refs).toContain(atom.frontmatter.id);
    }
  });

  it('records query_task in meta when task is provided', () => {
    recall(testDir, { task: 'find alpha facts', agent_id: 'a', session_id: 's' });

    const events = readEventsByAction(testDir, 'atom_read');
    expect(events[0].meta?.query_task).toBe('find alpha facts');
  });

  it('records token_estimate and atoms_returned in meta', () => {
    const bundle = recall(testDir, { agent_id: 'a', session_id: 's' });
    const events = readEventsByAction(testDir, 'atom_read');

    expect(events[0].meta?.atoms_returned).toBe(bundle.atoms.length);
    expect(typeof events[0].meta?.token_estimate).toBe('number');
  });

  it('does NOT emit atom_read when agent_id is absent', () => {
    recall(testDir, { session_id: 'session1' });

    const auditEvents = readEventsByAction(testDir, 'atom_read');
    expect(auditEvents).toHaveLength(0);
  });

  it('does NOT emit atom_read when session_id is absent', () => {
    recall(testDir, { agent_id: 'agent1' });

    const auditEvents = readEventsByAction(testDir, 'atom_read');
    expect(auditEvents).toHaveLength(0);
  });

  it('does NOT emit atom_read when neither agent_id nor session_id provided (backward compat)', () => {
    recall(testDir, {});
    recall(testDir);

    const auditEvents = readEventsByAction(testDir, 'atom_read');
    expect(auditEvents).toHaveLength(0);
  });

  it('emits separate events for multiple recall calls', () => {
    recall(testDir, { agent_id: 'a', session_id: 's' });
    recall(testDir, { agent_id: 'a', session_id: 's' });

    const auditEvents = readEventsByAction(testDir, 'atom_read');
    expect(auditEvents).toHaveLength(2);
  });
});
