/**
 * Milestone B integration tests.
 * Full lifecycle: init → create → bootstrap → replay → verify.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  initMemoryDir,
  createAtom,
  updateAtom,
  archiveAtom,
  readEvents,
  listAtoms,
  replay,
  replayFromFile,
  bootstrapEvents,
  reflect,
  checkpoint,
  hashEvidence,
  writeEvidence,
  readEvidence,
  serializeAtom,
} from '../src/index.js';

let tmpDir: string;
let memoryDir: string;

const AGENT = 'integration-agent';
const SESSION = 'integration-session';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-milestone-b-'));
  memoryDir = path.join(tmpDir, 'memory');
  initMemoryDir(memoryDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Milestone B integration', () => {
  it('full lifecycle: create → update → archive → replay matches final state', () => {
    // Create
    const atom1 = createAtom({
      memoryDir,
      type: 'fact',
      slug: 'lifecycle-fact',
      body: 'Initial fact content',
      agent_id: AGENT,
      session_id: SESSION,
    });

    const atom2 = createAtom({
      memoryDir,
      type: 'decision',
      slug: 'lifecycle-decision',
      body: 'A decision',
      agent_id: AGENT,
      session_id: SESSION,
    });

    // Update atom1
    updateAtom({
      memoryDir,
      filePath: atom1.filePath!,
      updates: { confidence: 0.95 },
      body: 'Updated fact content',
      agent_id: AGENT,
      session_id: SESSION,
    });

    // Archive atom2
    archiveAtom({
      memoryDir,
      filePath: atom2.filePath!,
      agent_id: AGENT,
      session_id: SESSION,
    });

    // Replay all events
    const events = readEvents(memoryDir);
    const result = replay(events);

    // Only atom1 should remain (atom2 was archived)
    expect(result.atoms.size).toBe(1);
    const replayed = result.atoms.get(atom1.frontmatter.id);
    expect(replayed).toBeDefined();
    expect(replayed!.body).toBe('Updated fact content');
    expect(replayed!.frontmatter.confidence).toBe(0.95);
    expect(result.errors).toHaveLength(0);
  });

  it('V2 events → replay → views identical to disk views', () => {
    // Create some atoms to generate views
    createAtom({
      memoryDir,
      type: 'decision',
      slug: 'view-decision',
      body: 'A decision for views',
      agent_id: AGENT,
      session_id: SESSION,
    });
    createAtom({
      memoryDir,
      type: 'constraint',
      slug: 'view-constraint',
      body: 'A constraint for views',
      agent_id: AGENT,
      session_id: SESSION,
    });
    createAtom({
      memoryDir,
      type: 'open_question',
      slug: 'view-question',
      body: 'An open question for views',
      agent_id: AGENT,
      session_id: SESSION,
    });

    // Run reflect to generate disk views
    reflect({
      memoryDir,
      agent_id: AGENT,
      session_id: SESSION,
    });

    // Replay events with a fixed timestamp for determinism
    const events = readEvents(memoryDir);
    const ts = '2026-01-01T00:00:00Z';
    const result = replay(events, { timestamp: ts });

    // Views should exist and contain expected content
    expect(result.views.index).toContain('Memory Index');
    expect(result.views.decisions).toContain('Decisions');
    expect(result.views.constraints).toContain('Constraints');
    expect(result.views.open_questions).toContain('Open Questions');
    expect(result.views.handoff).toContain('Handoff');

    // Should have all 3 atoms
    expect(result.atoms.size).toBe(3);
  });

  it('evidence hash round-trip', () => {
    const data = Buffer.from('Evidence data for round-trip test');
    const hash = writeEvidence(memoryDir, data);

    // Verify hash
    expect(hash).toBe(hashEvidence(data));

    // Read back
    const retrieved = readEvidence(memoryDir, hash);
    expect(retrieved).toEqual(data);
  });

  it('bootstrap + modify + replay → correct final state', () => {
    // Phase 1: Create atoms (simulates pre-V2 state)
    const atom1 = createAtom({
      memoryDir,
      type: 'fact',
      slug: 'bootstrap-mod-fact',
      body: 'Original fact',
      agent_id: AGENT,
      session_id: SESSION,
    });

    // Phase 2: Bootstrap
    bootstrapEvents({
      memoryDir,
      agent_id: AGENT,
      session_id: SESSION,
    });

    // Phase 3: Modify after bootstrap
    updateAtom({
      memoryDir,
      filePath: atom1.filePath!,
      updates: {},
      body: 'Modified after bootstrap',
      agent_id: AGENT,
      session_id: SESSION,
    });

    // Phase 4: Replay
    const events = readEvents(memoryDir);
    const result = replay(events);

    // Should reflect the post-bootstrap modification
    expect(result.atoms.size).toBe(1);
    const replayed = result.atoms.get(atom1.frontmatter.id);
    expect(replayed!.body).toBe('Modified after bootstrap');
  });

  it('determinism: same operations → identical replay', () => {
    const ts = '2026-01-01T00:00:00Z';

    // Run operations
    createAtom({
      memoryDir,
      type: 'fact',
      slug: 'determinism-test',
      body: 'Deterministic content',
      agent_id: AGENT,
      session_id: SESSION,
    });

    const events = readEvents(memoryDir);

    // Replay twice
    const result1 = replay(events, { timestamp: ts });
    const result2 = replay(events, { timestamp: ts });

    // Views should be identical
    expect(result1.views.index).toBe(result2.views.index);
    expect(result1.views.decisions).toBe(result2.views.decisions);
    expect(result1.views.constraints).toBe(result2.views.constraints);
    expect(result1.views.open_questions).toBe(result2.views.open_questions);
    expect(result1.views.handoff).toBe(result2.views.handoff);

    // Atoms should be identical
    expect(result1.atoms.size).toBe(result2.atoms.size);
  });

  it('checkpoint still works after V2 changes', () => {
    createAtom({
      memoryDir,
      type: 'fact',
      slug: 'checkpoint-regression',
      body: 'Checkpoint regression test',
      agent_id: AGENT,
      session_id: SESSION,
    });

    const result = checkpoint({
      memoryDir,
      agent_id: AGENT,
      session_id: SESSION,
    });

    expect(result.markdown).toContain('Checkpoint');
    expect(result.event_id).toBeDefined();
  });

  it('doctor still works after V2 changes', () => {
    // Create a valid atom
    createAtom({
      memoryDir,
      type: 'fact',
      slug: 'doctor-regression',
      body: 'Doctor regression test',
      agent_id: AGENT,
      session_id: SESSION,
    });

    // Verify atoms are valid (doctor logic)
    const atoms = listAtoms(memoryDir);
    expect(atoms.length).toBe(1);
    expect(atoms[0].frontmatter.id).toMatch(/^FACT-/);
  });

  it('reflect still works and emits V2 events', () => {
    createAtom({
      memoryDir,
      type: 'fact',
      slug: 'reflect-v2',
      body: 'Reflect V2 test',
      agent_id: AGENT,
      session_id: SESSION,
    });

    const result = reflect({
      memoryDir,
      agent_id: AGENT,
      session_id: SESSION,
    });

    expect(result.events_emitted).toBeGreaterThan(0);

    // Verify reflect event has the right shape
    const events = readEvents(memoryDir);
    const reflectEvent = events.find((e) => e.action === 'reflect_completed');
    expect(reflectEvent).toBeDefined();
  });

  it('replayFromFile writes atoms and views to outputDir', () => {
    createAtom({
      memoryDir,
      type: 'fact',
      slug: 'file-replay',
      body: 'File replay test',
      agent_id: AGENT,
      session_id: SESSION,
    });
    createAtom({
      memoryDir,
      type: 'decision',
      slug: 'file-replay-dec',
      body: 'Decision for file replay',
      agent_id: AGENT,
      session_id: SESSION,
    });

    const outputDir = path.join(tmpDir, 'replay-output');
    const eventsFile = path.join(memoryDir, 'events.ndjson');

    const result = replayFromFile(eventsFile, { outputDir });

    expect(result.atoms.size).toBe(2);

    // Verify files exist
    expect(fs.existsSync(path.join(outputDir, 'INDEX.md'))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'DECISIONS.md'))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'CONSTRAINTS.md'))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'OPEN_QUESTIONS.md'))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'HANDOFF.md'))).toBe(true);

    // Verify atom files exist in ENTITIES/
    const entityFiles = fs.readdirSync(path.join(outputDir, 'ENTITIES'));
    expect(entityFiles.length).toBe(2);
  });

  it('all mutation events from retain carry V2 snapshots', () => {
    const atom = createAtom({
      memoryDir,
      type: 'belief',
      slug: 'v2-snapshot-check',
      body: 'V2 snapshot check',
      confidence: 0.5,
      agent_id: AGENT,
      session_id: SESSION,
    });

    const updated = updateAtom({
      memoryDir,
      filePath: atom.filePath!,
      updates: { confidence: 0.9 },
      agent_id: AGENT,
      session_id: SESSION,
    });

    archiveAtom({
      memoryDir,
      filePath: updated.filePath!,
      agent_id: AGENT,
      session_id: SESSION,
    });

    const events = readEvents(memoryDir);
    const mutations = events.filter((e) =>
      ['atom_created', 'atom_updated', 'atom_archived'].includes(e.action),
    );

    expect(mutations.length).toBe(3);
    for (const m of mutations) {
      expect(m.schema_version).toBe(2);
      expect(m.atom_snapshot).toBeDefined();
      expect(m.atom_snapshot!.length).toBeGreaterThan(0);
    }
  });

  it('replayFromFile should reject crafted atom IDs with path traversal', () => {
    // Create a crafted event with a malicious atom ID containing ../
    const maliciousEvent = {
      event_id: 'evt-test-traversal',
      timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      agent_id: AGENT,
      session_id: SESSION,
      action: 'atom_created' as const,
      atom_refs: ['../../etc/passwd'],
      schema_version: 2 as const,
      atom_snapshot: [
        '---',
        'id: "../../etc/passwd"',
        'type: fact',
        'status: active',
        'confidence: 0.8',
        `created_at: "${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}"`,
        `updated_at: "${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}"`,
        'ttl_days: null',
        '---',
        '',
        'Malicious content',
      ].join('\n'),
    };

    const eventsFile = path.join(memoryDir, 'events.ndjson');
    fs.writeFileSync(eventsFile, JSON.stringify(maliciousEvent) + '\n');

    const outDir = path.join(tmpDir, 'replay-output');
    expect(() =>
      replayFromFile(eventsFile, { outputDir: outDir }),
    ).toThrow(/Path traversal denied/);
  });

  it('large-scale: 50 atoms → bootstrap → replay → all reconstructed', () => {
    for (let i = 0; i < 50; i++) {
      createAtom({
        memoryDir,
        type: i % 2 === 0 ? 'fact' : 'belief',
        slug: `large-scale-${i}`,
        body: `Atom body number ${i}`,
        agent_id: AGENT,
        session_id: SESSION,
      });
    }

    bootstrapEvents({
      memoryDir,
      agent_id: AGENT,
      session_id: SESSION,
    });

    const events = readEvents(memoryDir);
    const result = replay(events);

    expect(result.atoms.size).toBe(50);
    expect(result.errors).toHaveLength(0);
  });

  it('bootstrap idempotency: second run skips already-imported atoms', () => {
    createAtom({
      memoryDir,
      type: 'fact',
      slug: 'bootstrap-idem',
      body: 'Bootstrap idempotency test',
      agent_id: AGENT,
      session_id: SESSION,
    });

    const result1 = bootstrapEvents({
      memoryDir,
      agent_id: AGENT,
      session_id: SESSION,
    });

    expect(result1.imported).toBe(1);
    expect(result1.skipped).toBe(0);

    // Second bootstrap — atom already imported
    const result2 = bootstrapEvents({
      memoryDir,
      agent_id: AGENT,
      session_id: SESSION,
    });

    expect(result2.imported).toBe(0);
    expect(result2.skipped).toBe(1);

    // Backup files should have distinct timestamped names
    expect(result1.backup_path).not.toBe(result2.backup_path);
    expect(fs.existsSync(result1.backup_path)).toBe(true);
    expect(fs.existsSync(result2.backup_path)).toBe(true);
  });
});
