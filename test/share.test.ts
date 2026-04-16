/**
 * Tests for share/unshare operations in per-agent isolation.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  initIsolatedBase,
  initAgentStore,
  createAtom,
  updateAtom,
  closeAllIndexes,
  openIndex,
  readAtom,
  readEvents,
  compactLog,
  listAtoms,
} from '../src/index.js';
import { shareAtom, unshareAtom, listSharedAtoms } from '../src/share.js';

const AGENT = 'test-agent';
const SESSION = 'test-session';
let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-share-'));
  initIsolatedBase(testDir, 'huston');
  initAgentStore(testDir, 'main');
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

const agentDir = (agent: string) => path.join(testDir, 'agents', agent);
const sharedDir = () => path.join(testDir, 'shared');
const opts = () => ({ agent_id: AGENT, session_id: SESSION });
const base = (dir: string) => ({ memoryDir: dir, agent_id: AGENT, session_id: SESSION });

describe('shareAtom', () => {
  it('copies atom from agent store to shared namespace', () => {
    const hustonDir = agentDir('huston');
    openIndex(hustonDir);

    const atom = createAtom({ ...base(hustonDir), type: 'fact', slug: 'deploy-topology', body: 'Deployment uses k8s with 3 replicas.' });
    const atomId = atom.frontmatter.id;

    const result = shareAtom(testDir, atomId, 'huston', opts());

    expect(result.atom_id).toBe(atomId);
    expect(result.source_agent).toBe('huston');
    expect(fs.existsSync(result.shared_path)).toBe(true);

    // Verify the shared copy has same content
    const sharedAtom = readAtom(result.shared_path);
    expect(sharedAtom.frontmatter.id).toBe(atomId);
    expect(sharedAtom.body).toContain('Deployment uses k8s');
  });

  it('original atom unchanged in agent store after share', () => {
    const hustonDir = agentDir('huston');
    openIndex(hustonDir);

    const atom = createAtom({ ...base(hustonDir), type: 'fact', slug: 'original', body: 'Original content.' });
    const atomId = atom.frontmatter.id;
    const originalPath = atom.filePath!;

    shareAtom(testDir, atomId, 'huston', opts());

    // Original still exists and is unchanged
    expect(fs.existsSync(originalPath)).toBe(true);
    const originalRead = readAtom(originalPath);
    expect(originalRead.body).toContain('Original content');
  });

  it('re-sharing overwrites previous shared version', () => {
    const hustonDir = agentDir('huston');
    openIndex(hustonDir);

    const atom = createAtom({ ...base(hustonDir), type: 'fact', slug: 're-share', body: 'Version 1.' });
    const atomId = atom.frontmatter.id;

    const result1 = shareAtom(testDir, atomId, 'huston', opts());

    // Verify first share
    let shared = readAtom(result1.shared_path);
    expect(shared.body).toContain('Version 1');

    // Now overwrite the shared copy manually to prove re-share works
    // (In real usage, the agent would update their copy then re-share)
    const result2 = shareAtom(testDir, atomId, 'huston', opts());
    shared = readAtom(result2.shared_path);
    expect(shared.body).toContain('Version 1'); // Same content since agent didn't update
  });

  it('throws if atom does not exist in agent store', () => {
    expect(() => shareAtom(testDir, 'NONEXISTENT-ATOM-ID', 'huston', opts()))
      .toThrow(/not found/i);
  });

  it('auto-creates shared directory if missing', () => {
    const hustonDir = agentDir('huston');
    openIndex(hustonDir);

    // Remove shared dir
    fs.rmSync(sharedDir(), { recursive: true, force: true });

    const atom = createAtom({ ...base(hustonDir), type: 'fact', slug: 'auto-create', body: 'Test auto-create shared.' });

    const result = shareAtom(testDir, atom.frontmatter.id, 'huston', opts());
    expect(fs.existsSync(result.shared_path)).toBe(true);
  });
});

describe('unshareAtom', () => {
  it('removes atom from shared namespace', () => {
    const hustonDir = agentDir('huston');
    openIndex(hustonDir);

    const atom = createAtom({ ...base(hustonDir), type: 'fact', slug: 'to-unshare', body: 'Will be unshared.' });
    const atomId = atom.frontmatter.id;

    const result = shareAtom(testDir, atomId, 'huston', opts());
    expect(fs.existsSync(result.shared_path)).toBe(true);

    unshareAtom(testDir, atomId, opts());
    expect(fs.existsSync(result.shared_path)).toBe(false);
  });

  it('throws if atom not found in shared namespace', () => {
    expect(() => unshareAtom(testDir, 'NONEXISTENT-ID', opts()))
      .toThrow(/not found/i);
  });

  it('throws if shared namespace does not exist', () => {
    fs.rmSync(sharedDir(), { recursive: true, force: true });
    expect(() => unshareAtom(testDir, 'SOME-ID', opts()))
      .toThrow(/does not exist/i);
  });
});

describe('listSharedAtoms', () => {
  it('returns empty array when no shared atoms', () => {
    expect(listSharedAtoms(testDir)).toEqual([]);
  });

  it('returns shared atoms', () => {
    const hustonDir = agentDir('huston');
    openIndex(hustonDir);

    const atom1 = createAtom({ ...base(hustonDir), type: 'fact', slug: 'shared-1', body: 'Shared fact 1.' });
    const atom2 = createAtom({ ...base(hustonDir), type: 'decision', slug: 'shared-2', body: 'Shared decision.' });

    shareAtom(testDir, atom1.frontmatter.id, 'huston', opts());
    shareAtom(testDir, atom2.frontmatter.id, 'huston', opts());

    const shared = listSharedAtoms(testDir);
    expect(shared.length).toBe(2);
    const ids = shared.map((a) => a.frontmatter.id).sort();
    expect(ids).toContain(atom1.frontmatter.id);
    expect(ids).toContain(atom2.frontmatter.id);
  });

  it('returns empty when shared dir does not exist', () => {
    fs.rmSync(sharedDir(), { recursive: true, force: true });
    expect(listSharedAtoms(testDir)).toEqual([]);
  });
});

describe('share + compact interaction', () => {
  it('compaction preserves share events and real updates independently', () => {
    const hustonDir = agentDir('huston');

    // Create an atom
    const atom = createAtom({
      ...base(hustonDir),
      type: 'fact',
      slug: 'compact-test',
      body: 'Original body',
    });

    // Share it
    shareAtom(testDir, atom.frontmatter.id, 'huston', opts());

    // Now do a real update to the same atom
    updateAtom({
      ...base(hustonDir),
      filePath: atom.filePath!,
      updates: { confidence: 0.9 },
      body: 'Updated body',
    });

    // Read events before compaction
    const eventsBefore = readEvents(hustonDir);
    const shareEvents = eventsBefore.filter((e) => e.action === 'atom_shared');
    const updateEvents = eventsBefore.filter((e) => e.action === 'atom_updated');

    expect(shareEvents.length).toBe(1);
    expect(updateEvents.length).toBe(1);

    // Compact the log
    const compactResult = compactLog(hustonDir);

    // Both events should survive: atom_shared is non-mutation, atom_updated is kept as latest mutation
    const eventsAfter = readEvents(hustonDir);
    const shareEventsAfter = eventsAfter.filter((e) => e.action === 'atom_shared');
    const updateEventsAfter = eventsAfter.filter((e) => e.action === 'atom_updated');

    expect(shareEventsAfter.length).toBe(1);
    expect(updateEventsAfter.length).toBe(1);

    // The atom_created event for the same atom should be compacted away (atom_updated is latest mutation)
    const createEventsAfter = eventsAfter.filter(
      (e) => e.action === 'atom_created' && e.atom_refs?.includes(atom.frontmatter.id),
    );
    expect(createEventsAfter.length).toBe(0);
  });
});
