/**
 * #247 backward path — detect unprovenanced writes and backfill synthetic
 * human_edit events for clearly-scattered (non-migration) edits.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  initMemoryDir,
  createAtom,
  listAtoms,
  reflect,
  closeAllIndexes,
} from '../src/index.js';
import {
  detectUnprovenancedWrites,
  backfillHumanEdits,
} from '../src/provenance.js';
import { serializeAtom } from '../src/format.js';
import { readEvents } from '../src/event-log.js';
import type { Atom, AtomFrontmatter, MemoryEvent } from '../src/types.js';

// --- Pure-fixture helpers for the detection unit (no disk needed) ---

function makeAtom(over: Partial<AtomFrontmatter> & { body?: string } = {}): Atom {
  const { body = 'body text', ...fm } = over;
  const frontmatter: AtomFrontmatter = {
    id: fm.id ?? 'FACT-2026-06-01-X-1',
    type: fm.type ?? 'fact',
    status: fm.status ?? 'active',
    confidence: fm.confidence ?? 0.8,
    created_at: fm.created_at ?? '2026-06-01T00:00:00Z',
    updated_at: fm.updated_at ?? '2026-06-01T00:00:00Z',
    ttl_days: fm.ttl_days ?? null,
    classification: fm.classification ?? 'TEAM',
    ...fm,
  };
  return { frontmatter, body, filePath: `/x/${frontmatter.id}.md` };
}

function mutationEvent(atom: Atom, over: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    event_id: over.event_id ?? `evt-${atom.frontmatter.id}`,
    timestamp: over.timestamp ?? atom.frontmatter.updated_at,
    agent_id: 'a',
    session_id: 's',
    action: 'atom_created',
    atom_refs: [atom.frontmatter.id],
    schema_version: 2,
    atom_snapshot: 'atom_snapshot' in over ? over.atom_snapshot : serializeAtom(atom),
    ...over,
  } as MemoryEvent;
}

describe('detectUnprovenancedWrites (pure)', () => {
  it('flags a content-diff when current content differs from the last snapshot', () => {
    const current = makeAtom({ body: 'EDITED off-band' });
    const stale = makeAtom({ body: 'original' }); // snapshot baseline
    const events = [mutationEvent(stale, { event_id: 'evt-1' })];

    const found = detectUnprovenancedWrites([current], events);
    expect(found).toHaveLength(1);
    expect(found[0].confidence).toBe('content-diff');
    expect(found[0].cluster).toBe(false);
  });

  it('does NOT flag an atom whose snapshot matches its current content', () => {
    const atom = makeAtom({ body: 'unchanged' });
    const events = [mutationEvent(atom)];
    expect(detectUnprovenancedWrites([atom], events)).toHaveLength(0);
  });

  it('does NOT flag an atom that predates the event log (no baseline)', () => {
    const atom = makeAtom({ body: 'orphan' });
    expect(detectUnprovenancedWrites([atom], [])).toHaveLength(0);
  });

  it('uses the timestamp heuristic for SECRET atoms (snapshot is opaque)', () => {
    const secret = makeAtom({
      classification: 'SECRET',
      updated_at: '2026-06-02T00:00:00Z', // newer than the event below
    });
    const events = [
      mutationEvent(secret, { timestamp: '2026-06-01T00:00:00Z', atom_snapshot: 'ENC...' }),
    ];
    const found = detectUnprovenancedWrites([secret], events);
    expect(found).toHaveLength(1);
    expect(found[0].confidence).toBe('timestamp-heuristic');
  });

  it('does NOT flag a SECRET atom whose updated_at is not newer than its event', () => {
    const secret = makeAtom({ classification: 'SECRET', updated_at: '2026-06-01T00:00:00Z' });
    const events = [
      mutationEvent(secret, { timestamp: '2026-06-01T00:00:00Z', atom_snapshot: 'ENC...' }),
    ];
    expect(detectUnprovenancedWrites([secret], events)).toHaveLength(0);
  });

  it('marks a same-second cluster (>=3 candidates) as migration noise', () => {
    const stamp = '2026-04-22T12:07:51Z';
    const atoms: Atom[] = [];
    const events: MemoryEvent[] = [];
    for (let i = 0; i < 4; i++) {
      const id = `FACT-2026-04-22-MIG-${i}`;
      const cur = makeAtom({ id, body: `migrated-${i}`, updated_at: stamp });
      const stale = makeAtom({ id, body: `before-${i}`, updated_at: stamp });
      atoms.push(cur);
      events.push(mutationEvent(stale, { event_id: `evt-${i}` }));
    }
    const found = detectUnprovenancedWrites(atoms, events);
    expect(found).toHaveLength(4);
    expect(found.every((f) => f.cluster)).toBe(true);
  });
});

// --- Disk-backed backfill + reflect integration ---

describe('backfillHumanEdits (disk)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-provenance-'));
    initMemoryDir(testDir);
  });
  afterEach(() => {
    closeAllIndexes();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function newFact(slug: string, body: string): Atom {
    return createAtom({
      memoryDir: testDir,
      agent_id: 'a',
      session_id: 's',
      type: 'fact',
      slug,
      body,
      confidence: 0.8,
      status: 'active',
      ttl_days: null,
    });
  }

  /** Mutate an atom file's body directly on disk, bypassing the event system. */
  function offBandEdit(atom: Atom, newBody: string): void {
    const raw = fs.readFileSync(atom.filePath!, 'utf-8');
    const parts = raw.split(/\n---\n/);
    fs.writeFileSync(atom.filePath!, `${parts[0]}\n---\n\n${newBody}\n`);
  }

  it('emits a synthetic human_edit for a scattered off-band edit, idempotently', () => {
    const atom = newFact('scattered', 'first version');
    offBandEdit(atom, 'hand-corrected version');

    const r1 = backfillHumanEdits(
      { memoryDir: testDir, agent_id: 'reflect', session_id: 's' },
      listAtoms(testDir),
      readEvents(testDir),
    );
    expect(r1.detected).toBe(1);
    expect(r1.backfilled).toBe(1);

    const human = readEvents(testDir).filter((e) => e.action === 'human_edit');
    expect(human).toHaveLength(1);
    expect(human[0].meta?.synthetic).toBe(true);
    expect(human[0].meta?.detection_confidence).toBe('content-diff');

    // Second pass detects nothing new — the synthetic event is now the baseline.
    const r2 = backfillHumanEdits(
      { memoryDir: testDir, agent_id: 'reflect', session_id: 's' },
      listAtoms(testDir),
      readEvents(testDir),
    );
    expect(r2.backfilled).toBe(0);
    expect(readEvents(testDir).filter((e) => e.action === 'human_edit')).toHaveLength(1);
  });

  it('reflect --backfill-human-edits reports detection + emits the event', () => {
    const atom = newFact('via-reflect', 'before');
    offBandEdit(atom, 'after hand edit');

    const result = reflect({
      memoryDir: testDir,
      agent_id: 'cli',
      session_id: 'cli-session',
      backfillHumanEdits: true,
    });

    expect(result.unprovenanced_writes).toBe(1);
    expect(result.human_edits_backfilled).toBe(1);
    expect(readEvents(testDir).filter((e) => e.action === 'human_edit')).toHaveLength(1);
  });

  it('plain reflect (no flag) leaves the result shape unchanged and emits no human_edit', () => {
    const atom = newFact('untouched-by-default', 'before');
    offBandEdit(atom, 'after');

    const result = reflect({ memoryDir: testDir, agent_id: 'cli', session_id: 'cli-session' });

    expect(result.unprovenanced_writes).toBeUndefined();
    expect(result.human_edits_backfilled).toBeUndefined();
    expect(readEvents(testDir).filter((e) => e.action === 'human_edit')).toHaveLength(0);
  });
});
