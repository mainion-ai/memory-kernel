import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  initMemoryDir,
  createAtom,
  readEvents,
  listAtoms,
  bootstrapEvents,
  replay,
} from '../src/index.js';

let tmpDir: string;
let memoryDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-bootstrap-'));
  memoryDir = path.join(tmpDir, 'memory');
  initMemoryDir(memoryDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const AGENT = 'test-agent';
const SESSION = 'test-session';

describe('bootstrapEvents', () => {
  it('produces zero imports for empty memory', () => {
    const result = bootstrapEvents({
      memoryDir,
      agent_id: AGENT,
      session_id: SESSION,
    });

    expect(result.imported).toBe(0);
    expect(result.events_written).toBe(0);
  });

  it('imports existing atoms as atom_imported events', () => {
    createAtom({
      memoryDir,
      type: 'fact',
      slug: 'f1',
      body: 'Fact one',
      agent_id: AGENT,
      session_id: SESSION,
    });
    createAtom({
      memoryDir,
      type: 'decision',
      slug: 'd1',
      body: 'Decision one',
      agent_id: AGENT,
      session_id: SESSION,
    });

    // Before bootstrap: 2 atom_created events
    const eventsBefore = readEvents(memoryDir);
    expect(eventsBefore.length).toBe(2);

    const result = bootstrapEvents({
      memoryDir,
      agent_id: AGENT,
      session_id: SESSION,
    });

    expect(result.imported).toBe(2);
    // 2 import + 2 original = 4
    expect(result.events_written).toBe(4);

    const eventsAfter = readEvents(memoryDir);
    expect(eventsAfter.length).toBe(4);

    // First 2 should be imports
    const imports = eventsAfter.filter((e) => e.action === 'atom_imported');
    expect(imports.length).toBe(2);

    for (const imp of imports) {
      expect(imp.schema_version).toBe(2);
      expect(imp.atom_snapshot).toBeDefined();
      expect(imp.meta).toEqual({ bootstrap: true });
    }
  });

  it('creates backup of original events.ndjson', () => {
    createAtom({
      memoryDir,
      type: 'fact',
      slug: 'f1',
      body: 'Fact one',
      agent_id: AGENT,
      session_id: SESSION,
    });

    const result = bootstrapEvents({
      memoryDir,
      agent_id: AGENT,
      session_id: SESSION,
    });

    expect(fs.existsSync(result.backup_path)).toBe(true);
    // Backup should contain the original 1 event
    const backup = fs.readFileSync(result.backup_path, 'utf-8').trim();
    const backupEvents = backup.split('\n').map((l) => JSON.parse(l));
    expect(backupEvents.length).toBe(1);
    expect(backupEvents[0].action).toBe('atom_created');
  });

  it('import events are sorted by atom creation time', () => {
    // Create atoms — they'll get timestamps in creation order
    createAtom({
      memoryDir,
      type: 'fact',
      slug: 'first',
      body: 'First',
      agent_id: AGENT,
      session_id: SESSION,
    });
    createAtom({
      memoryDir,
      type: 'belief',
      slug: 'second',
      body: 'Second',
      agent_id: AGENT,
      session_id: SESSION,
    });

    bootstrapEvents({
      memoryDir,
      agent_id: AGENT,
      session_id: SESSION,
    });

    const events = readEvents(memoryDir);
    const imports = events.filter((e) => e.action === 'atom_imported');
    // Imports should be sorted by timestamp
    for (let i = 1; i < imports.length; i++) {
      expect(imports[i].timestamp >= imports[i - 1].timestamp).toBe(true);
    }
  });

  it('import events use atom created_at as timestamp', () => {
    const atom = createAtom({
      memoryDir,
      type: 'fact',
      slug: 'ts-check',
      body: 'Check timestamps',
      agent_id: AGENT,
      session_id: SESSION,
    });

    bootstrapEvents({
      memoryDir,
      agent_id: AGENT,
      session_id: SESSION,
    });

    const events = readEvents(memoryDir);
    const imported = events.find((e) => e.action === 'atom_imported');
    expect(imported).toBeDefined();
    expect(imported!.timestamp).toBe(atom.frontmatter.created_at);
  });

  it('import events have correct atom_refs', () => {
    const atom = createAtom({
      memoryDir,
      type: 'fact',
      slug: 'ref-check',
      body: 'Check refs',
      agent_id: AGENT,
      session_id: SESSION,
    });

    bootstrapEvents({
      memoryDir,
      agent_id: AGENT,
      session_id: SESSION,
    });

    const events = readEvents(memoryDir);
    const imported = events.find((e) => e.action === 'atom_imported');
    expect(imported!.atom_refs).toEqual([atom.frontmatter.id]);
  });

  it('preserves original events after import events', () => {
    createAtom({
      memoryDir,
      type: 'fact',
      slug: 'original',
      body: 'Original atom',
      agent_id: AGENT,
      session_id: SESSION,
    });

    bootstrapEvents({
      memoryDir,
      agent_id: AGENT,
      session_id: SESSION,
    });

    const events = readEvents(memoryDir);
    // Import event first, then original atom_created
    expect(events[0].action).toBe('atom_imported');
    expect(events[1].action).toBe('atom_created');
  });

  it('snapshots in imports can be replayed', () => {
    createAtom({
      memoryDir,
      type: 'fact',
      slug: 'replayable',
      body: 'This atom should be replayable',
      agent_id: AGENT,
      session_id: SESSION,
    });
    createAtom({
      memoryDir,
      type: 'decision',
      slug: 'also-replayable',
      body: 'This decision too',
      agent_id: AGENT,
      session_id: SESSION,
    });

    bootstrapEvents({
      memoryDir,
      agent_id: AGENT,
      session_id: SESSION,
    });

    // Replay only the import events
    const events = readEvents(memoryDir);
    const imports = events.filter((e) => e.action === 'atom_imported');

    const result = replay(imports);
    expect(result.atoms.size).toBe(2);
    expect(result.errors).toHaveLength(0);

    // Verify atom contents match disk
    const diskAtoms = listAtoms(memoryDir);
    for (const diskAtom of diskAtoms) {
      const replayed = result.atoms.get(diskAtom.frontmatter.id);
      expect(replayed).toBeDefined();
      expect(replayed!.frontmatter.type).toBe(diskAtom.frontmatter.type);
      expect(replayed!.body).toBe(diskAtom.body);
    }
  });

  it('handles empty events.ndjson gracefully', () => {
    // No atoms, no events — just the empty events file from init
    const result = bootstrapEvents({
      memoryDir,
      agent_id: AGENT,
      session_id: SESSION,
    });

    expect(result.imported).toBe(0);
    expect(result.events_written).toBe(0);
    expect(fs.existsSync(result.backup_path)).toBe(true);
  });

  it('import events use provided agent_id and session_id', () => {
    createAtom({
      memoryDir,
      type: 'fact',
      slug: 'agent-check',
      body: 'Check agent/session',
      agent_id: 'other-agent',
      session_id: 'other-session',
    });

    bootstrapEvents({
      memoryDir,
      agent_id: 'bootstrap-agent',
      session_id: 'bootstrap-session',
    });

    const events = readEvents(memoryDir);
    const imported = events.find((e) => e.action === 'atom_imported');
    expect(imported!.agent_id).toBe('bootstrap-agent');
    expect(imported!.session_id).toBe('bootstrap-session');
  });

  it('full round-trip: create → bootstrap → replay matches disk state', () => {
    // Create several atoms of different types
    createAtom({
      memoryDir,
      type: 'fact',
      slug: 'round-trip-fact',
      body: 'A fact for round-trip testing',
      agent_id: AGENT,
      session_id: SESSION,
    });
    createAtom({
      memoryDir,
      type: 'constraint',
      slug: 'round-trip-constraint',
      body: 'A constraint for round-trip testing',
      agent_id: AGENT,
      session_id: SESSION,
    });
    createAtom({
      memoryDir,
      type: 'belief',
      slug: 'round-trip-belief',
      body: 'A belief for round-trip testing',
      confidence: 0.6,
      agent_id: AGENT,
      session_id: SESSION,
    });

    // Bootstrap
    bootstrapEvents({
      memoryDir,
      agent_id: AGENT,
      session_id: SESSION,
    });

    // Replay ALL events (imports + originals)
    const allEvents = readEvents(memoryDir);
    const result = replay(allEvents);

    // Should have all 3 atoms
    expect(result.atoms.size).toBe(3);
    expect(result.errors).toHaveLength(0);

    // Verify each atom's content matches disk
    const diskAtoms = listAtoms(memoryDir);
    expect(diskAtoms.length).toBe(3);

    for (const diskAtom of diskAtoms) {
      const replayed = result.atoms.get(diskAtom.frontmatter.id);
      expect(replayed).toBeDefined();
      expect(replayed!.frontmatter.id).toBe(diskAtom.frontmatter.id);
      expect(replayed!.frontmatter.type).toBe(diskAtom.frontmatter.type);
      expect(replayed!.frontmatter.status).toBe(diskAtom.frontmatter.status);
      expect(replayed!.body).toBe(diskAtom.body);
    }
  });
});
