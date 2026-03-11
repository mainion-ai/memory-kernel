/**
 * Stress tests — edge cases, boundary conditions, and invariants.
 * Promotes findings from the standalone stress runner (54/55 probes passed).
 *
 * Finding #1 (documented in "event log corruption" describe block):
 *   replay() has no schema validation on atom snapshots — invalid type, status,
 *   and out-of-range confidence values silently pass through.
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
  recall,
  reflect,
  readEvents,
  countEvents,
  compactLog,
  listAtoms,
  readAtom,
  reindex,
  queryIndex,
  closeAllIndexes,
  replay,
  replayFromFile,
  searchFts,
  indexExists,
  writeEpisode,
  readEpisode,
  listEpisodes,
  linkEpisodeToAtom,
} from '../src/index.js';
import type { MemoryEvent } from '../src/index.js';

const AGENT = 'stress-agent';
const SESSION = 'stress-session';
const base = (dir: string) => ({ memoryDir: dir, agent_id: AGENT, session_id: SESSION });

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-stress-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

/** Patch an atom file so it appears expired on next reflect. */
function patchExpiry(filePath: string): void {
  const c = fs.readFileSync(filePath, 'utf-8');
  fs.writeFileSync(
    filePath,
    c
      .replace(/ttl_days: \d+/, 'ttl_days: 0')
      .replace(/created_at: [^\n]+/, 'created_at: 2000-01-01T00:00:00Z')
      .replace(/updated_at: [^\n]+/, 'updated_at: 2000-01-01T00:00:00Z'),
  );
}

// ============================================================================
// 1. PATH TRAVERSAL
// ============================================================================

describe('path traversal', () => {
  it('updateAtom with path outside memoryDir throws', () => {
    const evilPath = path.join(testDir, '../../etc/passwd');
    expect(() =>
      updateAtom({ ...base(testDir), filePath: evilPath, updates: {} }),
    ).toThrow(/traversal|outside/i);
  });

  it('archiveAtom with path outside memoryDir throws', () => {
    const evilPath = path.join(testDir, '../evil.md');
    expect(() =>
      archiveAtom({ ...base(testDir), filePath: evilPath }),
    ).toThrow(/traversal|outside/i);
  });

  it('replayFromFile with traversal atom id does not write outside outputDir', () => {
    const traversalId = '../../evil';
    const snap = [
      '---',
      `id: "${traversalId}"`,
      'type: fact',
      'status: active',
      'confidence: 0.8',
      'created_at: 2024-01-01T00:00:00Z',
      'updated_at: 2024-01-01T00:00:00Z',
      'ttl_days: null',
      'classification: TEAM',
      '---',
      '',
      'traversal body',
    ].join('\n');
    const evt: MemoryEvent = {
      event_id: 'evt-trav-stress',
      timestamp: new Date().toISOString(),
      agent_id: 'a',
      session_id: 's',
      action: 'atom_created',
      atom_refs: [traversalId],
      schema_version: 2,
      atom_snapshot: snap,
    };
    const eventsFile = path.join(testDir, 'trav.ndjson');
    fs.writeFileSync(eventsFile, JSON.stringify(evt) + '\n');

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-out-'));
    try {
      try {
        replayFromFile(eventsFile, { outputDir: outDir });
      } catch {
        // acceptable — throws on traversal detection
      }
      // Either way, the file must NOT escape outDir
      const escapedPath = path.join(path.dirname(outDir), 'evil.md');
      expect(fs.existsSync(escapedPath)).toBe(false);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// 2. EXTREME INPUTS
// ============================================================================

describe('extreme inputs', () => {
  it('unicode/emoji slug produces safe ID (only [\\w-] chars)', () => {
    const a = createAtom({ ...base(testDir), type: 'fact', slug: '🤖-test-émoji', body: 'emoji' });
    expect(a.frontmatter.id).toMatch(/^[\w\-]+$/);
  });

  it('1000-char slug produces ID shorter than 200 chars', () => {
    const a = createAtom({ ...base(testDir), type: 'fact', slug: 'a'.repeat(1000), body: 'body' });
    expect(a.frontmatter.id.length).toBeLessThan(200);
  });

  it('empty slug does not crash', () => {
    expect(() =>
      createAtom({ ...base(testDir), type: 'fact', slug: '', body: 'body' }),
    ).not.toThrow();
  });

  it('confidence=0 is accepted', () => {
    expect(() =>
      createAtom({ ...base(testDir), type: 'fact', slug: 'conf-zero', body: 'b', confidence: 0 }),
    ).not.toThrow();
  });

  it('confidence=1 is accepted', () => {
    expect(() =>
      createAtom({ ...base(testDir), type: 'fact', slug: 'conf-one', body: 'b', confidence: 1 }),
    ).not.toThrow();
  });

  it('confidence < 0 is rejected', () => {
    expect(() =>
      createAtom({ ...base(testDir), type: 'fact', slug: 'neg', body: 'b', confidence: -0.1 }),
    ).toThrow();
  });

  it('confidence > 1 is rejected', () => {
    expect(() =>
      createAtom({ ...base(testDir), type: 'fact', slug: 'over', body: 'b', confidence: 1.1 }),
    ).toThrow();
  });

  it('256 KB body survives roundtrip without truncation', () => {
    const bigBody = 'x'.repeat(256 * 1024);
    const a = createAtom({ ...base(testDir), type: 'fact', slug: 'big', body: bigBody });
    const loaded = readAtom(a.filePath!);
    expect(loaded.body).toBe(bigBody.trim());
  });

  it('256 KB body survives reflect without expiry or dedup', () => {
    const bigBody = 'x'.repeat(256 * 1024);
    createAtom({ ...base(testDir), type: 'fact', slug: 'big-reflect', body: bigBody });
    const r = reflect({ ...base(testDir) });
    expect(r.expired).toBe(0);
    expect(r.deduped).toBe(0);
  });

  it('YAML-like content in body does not corrupt frontmatter', () => {
    const trickyBody = 'Before\n---\nid: injected\ntype: evil\n---\nAfter';
    const a = createAtom({ ...base(testDir), type: 'fact', slug: 'tricky', body: trickyBody });
    const loaded = readAtom(a.filePath!);
    expect(loaded.frontmatter.id).toBe(a.frontmatter.id);
    expect(loaded.body).toBe(trickyBody.trim());
  });

  it('special chars (tab, backslash, quote) survive roundtrip', () => {
    const specialBody = 'tab:\there\tbackslash:\\ quote:"hello"';
    const a = createAtom({ ...base(testDir), type: 'fact', slug: 'special', body: specialBody });
    const loaded = readAtom(a.filePath!);
    expect(loaded.body).toBe(specialBody.trim());
  });
});

// ============================================================================
// 3. DEDUP EDGE CASES
// ============================================================================

describe('dedup edge cases', () => {
  it('5 identical atoms → 4 archived by dedup', () => {
    for (let i = 0; i < 5; i++) {
      createAtom({ ...base(testDir), type: 'fact', slug: `dup-${i}`, body: 'identical body' });
    }
    const r = reflect({ ...base(testDir) });
    expect(r.deduped).toBe(4);
  });

  it('3 dups interleaved with 3 unique → 2 deduped, 4 atoms remain', () => {
    for (let i = 0; i < 3; i++) {
      createAtom({ ...base(testDir), type: 'fact', slug: `dup-${i}`, body: 'dup body' });
      createAtom({ ...base(testDir), type: 'fact', slug: `uniq-${i}`, body: `unique body ${i}` });
    }
    const r = reflect({ ...base(testDir) });
    expect(r.deduped).toBe(2);
    expect(listAtoms(testDir).length).toBe(4);
  });

  it('same body, different types → NOT deduped', () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'f1', body: 'shared content' });
    createAtom({ ...base(testDir), type: 'belief', slug: 'b1', body: 'shared content' });
    const r = reflect({ ...base(testDir) });
    expect(r.deduped).toBe(0);
    expect(listAtoms(testDir).length).toBe(2);
  });

  it('body.trim() is dedup key: whitespace-only diff dedupes', () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'no-ws', body: 'trim body' });
    createAtom({ ...base(testDir), type: 'fact', slug: 'with-ws', body: '  trim body  ' });
    const r = reflect({ ...base(testDir) });
    expect(r.deduped).toBe(1);
  });
});

// ============================================================================
// 4. TTL / EXPIRY
// ============================================================================

describe('TTL / expiry', () => {
  it('ttl_days=0 + past created_at expires on reflect', () => {
    const a = createAtom({ ...base(testDir), type: 'preference', slug: 'ephemeral', body: 'b' });
    patchExpiry(a.filePath!);
    const r = reflect({ ...base(testDir) });
    expect(r.expired).toBe(1);
  });

  it('ttl_days=null (decision) never expires even with far-past created_at', () => {
    const a = createAtom({ ...base(testDir), type: 'decision', slug: 'd1', body: 'b' });
    // Patch only timestamps; ttl_days stays null (regex targets digits only)
    const c = fs.readFileSync(a.filePath!, 'utf-8');
    fs.writeFileSync(
      a.filePath!,
      c
        .replace(/created_at: [^\n]+/, 'created_at: 2000-01-01T00:00:00Z')
        .replace(/updated_at: [^\n]+/, 'updated_at: 2000-01-01T00:00:00Z'),
    );
    const r = reflect({ ...base(testDir) });
    expect(r.expired).toBe(0);
  });

  it('already-expired atom not re-expired on second reflect', () => {
    const a = createAtom({ ...base(testDir), type: 'preference', slug: 'once', body: 'b' });
    patchExpiry(a.filePath!);
    const r1 = reflect({ ...base(testDir) });
    expect(r1.expired).toBe(1);
    const r2 = reflect({ ...base(testDir) });
    expect(r2.expired).toBe(0);
  });
});

// ============================================================================
// 5. AUTO-PROMOTION BOUNDARY
// ============================================================================

describe('auto-promotion boundary', () => {
  it('belief with confidence=0.9 IS promoted (threshold is >=0.9)', () => {
    createAtom({ ...base(testDir), type: 'belief', slug: 'high', body: 'b', confidence: 0.9 });
    const r = reflect({ ...base(testDir) });
    expect(r.promoted).toBe(1);
  });

  it('belief with confidence=0.899 is NOT promoted', () => {
    createAtom({ ...base(testDir), type: 'belief', slug: 'low', body: 'b', confidence: 0.899 });
    const r = reflect({ ...base(testDir) });
    expect(r.promoted).toBe(0);
  });

  it('belief with status=accepted is NOT promoted even at confidence=1', () => {
    const a = createAtom({ ...base(testDir), type: 'belief', slug: 'acc', body: 'b', confidence: 1.0 });
    const c = fs.readFileSync(a.filePath!, 'utf-8');
    fs.writeFileSync(a.filePath!, c.replace(/status: draft/, 'status: accepted'));
    const r = reflect({ ...base(testDir) });
    expect(r.promoted).toBe(0);
  });
});

// ============================================================================
// 6. COMPACT + REPLAY INVARIANT
// ============================================================================

describe('compact + replay invariant', () => {
  it('state before compact === state after (body and archived set)', () => {
    const a1 = createAtom({ ...base(testDir), type: 'fact', slug: 'a1', body: 'body v1' });
    const a2 = createAtom({ ...base(testDir), type: 'fact', slug: 'a2', body: 'body 2' });
    updateAtom({ ...base(testDir), filePath: a1.filePath!, updates: { confidence: 0.9 }, body: 'body v2' });
    archiveAtom({ ...base(testDir), filePath: a2.filePath! });
    compactLog(testDir);

    const r = replayFromFile(path.join(testDir, 'events.ndjson'));
    expect(r.atoms.get(a1.frontmatter.id)?.body).toBe('body v2');
    // Archived atoms are deleted from the replay map
    expect(r.atoms.has(a2.frontmatter.id)).toBe(false);
  });

  it('double compact: second run removes 0 events', () => {
    const a = createAtom({ ...base(testDir), type: 'fact', slug: 'f1', body: 'b' });
    updateAtom({ ...base(testDir), filePath: a.filePath!, updates: { confidence: 0.9 } });
    compactLog(testDir);
    const r2 = compactLog(testDir);
    expect(r2.removed).toBe(0);
  });

  it('reflect_completed (non-mutation) events preserved after compact', () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'f1', body: 'b' });
    reflect({ ...base(testDir) });
    compactLog(testDir);
    const events = readEvents(testDir);
    const reflectEvents = events.filter((e) => e.action === 'reflect_completed');
    expect(reflectEvents.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// 7. EVENT LOG CORRUPTION
// ============================================================================

describe('event log corruption', () => {
  it('binary noise mid-log: valid events still readable, countEvents === readEvents.length', () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'f1', body: 'b1' });
    createAtom({ ...base(testDir), type: 'fact', slug: 'f2', body: 'b2' });
    const logPath = path.join(testDir, 'events.ndjson');
    const log = fs.readFileSync(logPath, 'utf-8');
    const lines = log.trim().split('\n');
    lines.splice(1, 0, '\x00\x01CORRUPT\x03');
    fs.writeFileSync(logPath, lines.join('\n') + '\n');

    const events = readEvents(testDir);
    const count = countEvents(testDir);
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(count).toBe(events.length);
  });

  it('truncated JSON at EOF: no crash, valid events still returned', () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'f1', body: 'b1' });
    const logPath = path.join(testDir, 'events.ndjson');
    fs.appendFileSync(logPath, '{"event_id":"trunc","truncated-no-close');
    expect(() => readEvents(testDir)).not.toThrow();
    const events = readEvents(testDir);
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it('all-whitespace log returns empty array', () => {
    fs.writeFileSync(path.join(testDir, 'events.ndjson'), '   \n\n\t  \n');
    const events = readEvents(testDir);
    expect(events).toEqual([]);
  });

  it('invalid atom type in snapshot is rejected by replay with a validation error', () => {
    const snap = [
      '---',
      'id: FACT-BADTYPE-STRESS',
      'type: NOTATYPE',
      'status: active',
      'confidence: 0.8',
      'created_at: 2024-01-01T00:00:00Z',
      'updated_at: 2024-01-01T00:00:00Z',
      'ttl_days: null',
      'classification: TEAM',
      '---',
      '',
      'bad type atom',
    ].join('\n');
    const evt: MemoryEvent = {
      event_id: 'evt-bad-type-stress',
      timestamp: new Date().toISOString(),
      agent_id: 'a',
      session_id: 's',
      action: 'atom_created',
      atom_refs: ['FACT-BADTYPE-STRESS'],
      schema_version: 2,
      atom_snapshot: snap,
    };
    const r = replay([evt]);
    // Schema validation at replay layer — invalid type produces an error and atom is excluded
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toMatch(/evt-bad-type-stress/);
    expect(r.atoms.has('FACT-BADTYPE-STRESS')).toBe(false);
  });

  it('duplicate event_ids: both events loaded, replay does not crash', () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'f1', body: 'b1' });
    const events = readEvents(testDir);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const dup = { ...events[0], timestamp: new Date().toISOString() };
    fs.appendFileSync(path.join(testDir, 'events.ndjson'), JSON.stringify(dup) + '\n');
    const all = readEvents(testDir);
    expect(all.length).toBe(events.length + 1);
    expect(() => replay(all)).not.toThrow();
  });
});

// ============================================================================
// 8. INDEX / FILE DIVERGENCE
// ============================================================================

describe('index / file divergence', () => {
  it('stale index (file deleted externally): recall does not crash', () => {
    const a = createAtom({ ...base(testDir), type: 'fact', slug: 'f1', body: 'b1' });
    reindex(testDir);
    fs.unlinkSync(a.filePath!);
    expect(() => recall(testDir, {})).not.toThrow();
  });

  it('reindex on empty dir: indexed=0, no crash', () => {
    const r = reindex(testDir);
    expect(r.indexed).toBe(0);
  });

  it('queryIndex({ limit: 2 }) returns at most 2 results', () => {
    for (let i = 0; i < 5; i++) {
      createAtom({ ...base(testDir), type: 'fact', slug: `f${i}`, body: `body ${i}` });
    }
    reindex(testDir);
    const results = queryIndex(testDir, {}, { limit: 2 });
    expect(results?.length).toBeLessThanOrEqual(2);
    expect(results?.length).toBeGreaterThan(0);
  });

  it('queryIndex({ limit: -1 }) treated as no-limit (returns all, no crash)', () => {
    for (let i = 0; i < 3; i++) {
      createAtom({ ...base(testDir), type: 'fact', slug: `g${i}`, body: `body ${i}` });
    }
    reindex(testDir);
    expect(() => queryIndex(testDir, {}, { limit: -1 })).not.toThrow();
    const results = queryIndex(testDir, {}, { limit: -1 });
    expect(results?.length).toBe(3);
  });
});

// ============================================================================
// 9. ARCHIVEATOM IDEMPOTENCY
// ============================================================================

describe('archiveAtom idempotency', () => {
  it('double-archive: no crash, archive file still exists', () => {
    const a = createAtom({ ...base(testDir), type: 'fact', slug: 'idem', body: 'b' });
    archiveAtom({ ...base(testDir), filePath: a.filePath! });
    const archPath = path.join(testDir, 'ARCHIVE', path.basename(a.filePath!));
    expect(fs.existsSync(archPath)).toBe(true);
    // Second call with the archive path — status is 'archived', returns early (idempotent)
    expect(() => archiveAtom({ ...base(testDir), filePath: archPath })).not.toThrow();
    expect(fs.existsSync(archPath)).toBe(true);
  });

  it('updateAtom on a path within ARCHIVE/ works correctly', () => {
    const a = createAtom({ ...base(testDir), type: 'fact', slug: 'upd-arch', body: 'original' });
    archiveAtom({ ...base(testDir), filePath: a.filePath! });
    const archPath = path.join(testDir, 'ARCHIVE', path.basename(a.filePath!));
    expect(() =>
      updateAtom({ ...base(testDir), filePath: archPath, updates: {}, body: 'updated' }),
    ).not.toThrow();
    const loaded = readAtom(archPath);
    expect(loaded.body).toBe('updated');
  });
});

// ============================================================================
// 10. UPDATEATOM NO-OP
// ============================================================================

describe('updateAtom no-op', () => {
  it('updates: {} with no body change emits no new event', () => {
    const a = createAtom({ ...base(testDir), type: 'fact', slug: 'noop', body: 'body' });
    const countBefore = countEvents(testDir);
    updateAtom({ ...base(testDir), filePath: a.filePath!, updates: {} });
    const countAfter = countEvents(testDir);
    expect(countAfter).toBe(countBefore);
  });

  it('updates with new body emits event and updates content', () => {
    const a = createAtom({ ...base(testDir), type: 'fact', slug: 'rewrite', body: 'original' });
    const countBefore = countEvents(testDir);
    updateAtom({ ...base(testDir), filePath: a.filePath!, updates: {}, body: 'updated body' });
    const countAfter = countEvents(testDir);
    expect(countAfter).toBeGreaterThan(countBefore);
    const loaded = readAtom(a.filePath!);
    expect(loaded.body).toBe('updated body');
  });
});

// ============================================================================
// 11. RECALL EDGE CASES
// ============================================================================

describe('recall edge cases', () => {
  it('SECRET and PERSONAL atoms excluded from default recall', () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'secret', body: 'secret', classification: 'SECRET' });
    createAtom({ ...base(testDir), type: 'fact', slug: 'personal', body: 'personal', classification: 'PERSONAL' });
    createAtom({ ...base(testDir), type: 'fact', slug: 'pub', body: 'public', classification: 'TEAM' });
    const bundle = recall(testDir, {});
    expect(bundle.atoms.some((a) => a.frontmatter.classification === 'SECRET')).toBe(false);
    expect(bundle.atoms.some((a) => a.frontmatter.classification === 'PERSONAL')).toBe(false);
    expect(bundle.atoms.length).toBe(1);
  });

  it('max_tokens=1 returns 0 atoms', () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'f1', body: 'some body text' });
    const bundle = recall(testDir, { max_tokens: 1 });
    expect(bundle.atoms.length).toBe(0);
  });

  it('src/comp does NOT match src/components (path boundary check)', () => {
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'btn',
      body: 'b',
      scope: { paths: ['src/components/Button'] },
    });
    const bundle = recall(testDir, { paths: ['src/comp'] });
    expect(bundle.atoms.length).toBe(0);
  });

  it('prefix path src matches src/components/Button', () => {
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'btn',
      body: 'b',
      scope: { paths: ['src/components/Button'] },
    });
    const bundle = recall(testDir, { paths: ['src'] });
    expect(bundle.atoms.length).toBe(1);
  });

  it('empty memoryDir: all reflect counts are 0', () => {
    const r = reflect({ ...base(testDir) });
    expect(r.expired).toBe(0);
    expect(r.deduped).toBe(0);
    expect(r.promoted).toBe(0);
    expect(r.archived).toBe(0);
  });
});

// ============================================================================
// 12. SPECIAL ATOM TYPES
// ============================================================================

describe('special atom types', () => {
  it('conflict atoms are stored in CONFLICTS/ not ENTITIES/', () => {
    const a = createAtom({ ...base(testDir), type: 'conflict', slug: 'c1', body: 'conflict body' });
    expect(a.filePath).toContain(path.sep + 'CONFLICTS' + path.sep);
    expect(fs.existsSync(a.filePath!)).toBe(true);
    expect(
      fs.existsSync(path.join(testDir, 'ENTITIES', path.basename(a.filePath!))),
    ).toBe(false);
  });

  it('conflict atoms are counted by detectConflicts in reflect', () => {
    createAtom({ ...base(testDir), type: 'conflict', slug: 'c1', body: 'conflict 1' });
    createAtom({ ...base(testDir), type: 'conflict', slug: 'c2', body: 'conflict 2' });
    const r = reflect({ ...base(testDir) });
    expect(r.conflicts_found).toBeGreaterThanOrEqual(2);
  });

  it('scope with empty arrays does not crash on recall', () => {
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'empty-scope',
      body: 'b',
      scope: { paths: [], tags: [] },
    });
    expect(() => recall(testDir, {})).not.toThrow();
  });
});

// ============================================================================
// 13. REPLAY EDGE CASES
// ============================================================================

describe('replay edge cases', () => {
  it('replay([]) returns empty atom map with no errors', () => {
    const r = replay([]);
    expect(r.atoms.size).toBe(0);
    expect(r.errors.length).toBe(0);
  });

  it('V1 archive event (no snapshot) removes atom without error', () => {
    const evt: MemoryEvent = {
      event_id: 'evt-v1-arch-stress',
      timestamp: '2026-01-01T00:00:00Z',
      agent_id: 'a',
      session_id: 's',
      action: 'atom_archived',
      atom_refs: ['FACT-NONEXISTENT'],
      schema_version: 1,
    };
    expect(() => replay([evt])).not.toThrow();
    const r = replay([evt]);
    expect(r.errors.length).toBe(0);
  });

  it('replayFromFile with non-existent file returns empty state', () => {
    const r = replayFromFile('/tmp/does-not-exist-mk-stress-99999.ndjson');
    expect(r.atoms.size).toBe(0);
    expect(r.errors.length).toBe(0);
  });

  it('full create→update→update lifecycle: v3 body and confidence reconstructed', () => {
    const a = createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'lifecycle',
      body: 'v1',
      confidence: 0.5,
    });
    updateAtom({ ...base(testDir), filePath: a.filePath!, updates: { confidence: 0.7 }, body: 'v2' });
    updateAtom({ ...base(testDir), filePath: a.filePath!, updates: { confidence: 0.9 }, body: 'v3' });
    const r = replayFromFile(path.join(testDir, 'events.ndjson'));
    const atom = r.atoms.get(a.frontmatter.id);
    expect(atom?.body).toBe('v3');
    expect(atom?.frontmatter.confidence).toBe(0.9);
  });
});

// ============================================================================
// 14. LARGE-SCALE PERFORMANCE
// ============================================================================

describe('large-scale performance', () => {
  it('500 atoms: reflect completes in < 15s', { timeout: 30000 }, () => {
    for (let i = 0; i < 500; i++) {
      createAtom({ ...base(testDir), type: 'fact', slug: `fact-${i}`, body: `body ${i}` });
    }
    const start = Date.now();
    reflect({ ...base(testDir) });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(15000);
  });

  it('50 × create→update→archive: 150 events, 0 active atoms, 50 in ARCHIVE', { timeout: 30000 }, () => {
    for (let i = 0; i < 50; i++) {
      const a = createAtom({ ...base(testDir), type: 'fact', slug: `stress-${i}`, body: `body ${i}` });
      updateAtom({ ...base(testDir), filePath: a.filePath!, updates: { confidence: 0.9 } });
      archiveAtom({ ...base(testDir), filePath: a.filePath! });
    }
    expect(countEvents(testDir)).toBe(150);
    expect(listAtoms(testDir).length).toBe(0);
    expect(fs.readdirSync(path.join(testDir, 'ARCHIVE')).length).toBe(50);
  });
});

// ============================================================================
// 15. FTS5 EDGE CASES
// ============================================================================

describe('FTS5 edge cases', () => {
  it('searchFts returns null before reindex (no index file)', () => {
    // No reindex called — .memory-index.db does not exist
    const result = searchFts(testDir, 'anything');
    expect(result).toBeNull();
  });

  it('searchFts returns [] (not null) for a query with no matches after reindex', () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'redis', body: '## Fact\nRedis is fast.' });
    reindex(testDir);
    const result = searchFts(testDir, 'completelymadeupword99999');
    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(true);
    expect(result!.length).toBe(0);
  });

  it('searchFts handles FTS5 special chars without throwing', () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'safe', body: '## Fact\nSafe body text.' });
    reindex(testDir);
    // These would normally be FTS5 syntax errors if passed raw
    expect(() => searchFts(testDir, '"unclosed')).not.toThrow();
    expect(() => searchFts(testDir, 'AND OR NOT')).not.toThrow();
    expect(() => searchFts(testDir, '* wildcard *')).not.toThrow();
    expect(() => searchFts(testDir, '(unbalanced')).not.toThrow();
  });

  it('reindex called twice is idempotent — same searchFts results on second call', () => {
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'pagination',
      body: '## Fact\nCursor pagination replaces offset.',
    });
    reindex(testDir);
    const first = searchFts(testDir, 'pagination');
    reindex(testDir);
    const second = searchFts(testDir, 'pagination');
    expect(second).not.toBeNull();
    expect(second!.length).toBe(first!.length);
    expect(second![0].atom_id).toBe(first![0].atom_id);
  });
});

// ============================================================================
// 16. TASK-AWARE RECALL EDGE CASES
// ============================================================================

describe('task-aware recall edge cases', () => {
  it('same recall({ task }) called twice → identical atom ordering (determinism)', () => {
    for (let i = 0; i < 5; i++) {
      createAtom({
        ...base(testDir),
        type: 'fact',
        slug: `fact-${i}`,
        body: `## Fact\nFact number ${i} about various topics.`,
      });
    }
    createAtom({
      ...base(testDir),
      type: 'decision',
      slug: 'pagination',
      body: '## Decision\nUse cursor-based pagination for all list endpoints.',
    });
    reindex(testDir);
    const bundle1 = recall(testDir, { task: 'pagination' });
    const bundle2 = recall(testDir, { task: 'pagination' });
    expect(bundle1.atoms.map((a) => a.frontmatter.id)).toEqual(
      bundle2.atoms.map((a) => a.frontmatter.id),
    );
  });

  it('recall({ task }) without prior reindex falls back gracefully (no throw)', () => {
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'cache',
      body: '## Fact\nRedis cache improves performance.',
    });
    // Deliberately no reindex — index file absent
    expect(() => recall(testDir, { task: 'redis performance' })).not.toThrow();
    const bundle = recall(testDir, { task: 'redis performance' });
    expect(bundle.atoms.length).toBeGreaterThanOrEqual(1);
  });

  it('recall({ task: "" }) does not crash and returns same result as no-task recall', () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'f1', body: '## Fact\nSome fact.' });
    reindex(testDir);
    expect(() => recall(testDir, { task: '' })).not.toThrow();
    const withEmptyTask = recall(testDir, { task: '' });
    const withNoTask = recall(testDir, {});
    expect(withEmptyTask.atoms.length).toBe(withNoTask.atoms.length);
  });
});

// ============================================================================
// 17. EPISODE STORE EDGE CASES
// ============================================================================

describe('episode store edge cases', () => {
  it('session IDs with slashes and spaces are sanitized to kebab-case', () => {
    const epId = writeEpisode(
      testDir,
      'session/with spaces and/slashes',
      '## Summary\nTest session.',
    );
    // ID must be safe as a filename (kebab-case, no slashes or spaces)
    expect(epId).toMatch(/^EP-/);
    expect(epId).not.toContain('/');
    expect(epId).not.toContain(' ');
    const filePath = path.join(testDir, 'EPISODES', `${epId}.md`);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('writeEpisode called twice with same session ID → one file in EPISODES/ (last-write-wins)', () => {
    const sessionId = 'idempotent-session';
    writeEpisode(testDir, sessionId, '## Summary\nFirst write.');
    writeEpisode(testDir, sessionId, '## Summary\nSecond write.');
    const episodesDir = path.join(testDir, 'EPISODES');
    const files = fs.readdirSync(episodesDir).filter((f) => f.endsWith('.md'));
    expect(files.length).toBe(1);
    const ep = readEpisode(testDir, `EP-${sessionId}`);
    expect(ep?.summary).toContain('Second write');
  });

  it('listEpisodes({ limit: 0 }) returns empty array', () => {
    writeEpisode(testDir, 'session-a', '## Summary\nA.');
    writeEpisode(testDir, 'session-b', '## Summary\nB.');
    const result = listEpisodes(testDir, { limit: 0 });
    expect(result).toEqual([]);
  });

  it('linkEpisodeToAtom on an archived atom filePath does not throw', () => {
    const a = createAtom({ ...base(testDir), type: 'fact', slug: 'link-test', body: 'body' });
    archiveAtom({ ...base(testDir), filePath: a.filePath! });
    const epId = writeEpisode(testDir, 'link-session', '## Summary\nLinked.');
    // archiveAtom moves the file — find new path
    const archivedPath = path.join(testDir, 'ARCHIVE', path.basename(a.filePath!));
    expect(() => linkEpisodeToAtom(testDir, archivedPath, epId)).not.toThrow();
  });

  it('readEpisode returns null for a non-existent episode ID', () => {
    const result = readEpisode(testDir, 'EP-does-not-exist-99999');
    expect(result).toBeNull();
  });
});

// ============================================================================
// 18. CONFLICT DETECTION HEURISTIC
// ============================================================================

describe('conflict detection heuristic', () => {
  it('two facts with overlapping scope paths and confidence diff > 0.3 → conflict created', () => {
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'high-confidence',
      body: '## Fact\nServer runs on port 8080.',
      confidence: 0.95,
      scope: { paths: ['/services/api'] },
    });
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'low-confidence',
      body: '## Fact\nServer runs on port 3000.',
      confidence: 0.5,
      scope: { paths: ['/services/api'] },
    });
    const r = reflect({ ...base(testDir) });
    expect(r.conflicts_found).toBeGreaterThanOrEqual(1);
    const conflictsDir = path.join(testDir, 'CONFLICTS');
    expect(fs.readdirSync(conflictsDir).length).toBeGreaterThanOrEqual(1);
  });

  it('two facts with same scope paths but confidence diff ≤ 0.3 → no conflict created', () => {
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'close-high',
      body: '## Fact\nLatency is 50ms.',
      confidence: 0.8,
      scope: { paths: ['/services/metrics'] },
    });
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'close-low',
      body: '## Fact\nLatency is 60ms.',
      confidence: 0.6,
      scope: { paths: ['/services/metrics'] },
    });
    const r = reflect({ ...base(testDir) });
    // confidence diff = 0.2, below threshold → no new conflict
    const conflictsDir = path.join(testDir, 'CONFLICTS');
    const newConflicts = fs.readdirSync(conflictsDir).filter((f) => f.endsWith('.md'));
    expect(newConflicts.length).toBe(0);
    expect(r.conflicts_found).toBe(0);
  });

  it('reflect twice on same conflicting pair does not duplicate conflict atoms', () => {
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'dup-high',
      body: '## Fact\nPort is 8080.',
      confidence: 0.95,
      scope: { paths: ['/services/web'] },
    });
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'dup-low',
      body: '## Fact\nPort is 3000.',
      confidence: 0.5,
      scope: { paths: ['/services/web'] },
    });
    const r1 = reflect({ ...base(testDir) });
    const countAfterFirst = fs.readdirSync(path.join(testDir, 'CONFLICTS')).filter((f) => f.endsWith('.md')).length;
    const r2 = reflect({ ...base(testDir) });
    const countAfterSecond = fs.readdirSync(path.join(testDir, 'CONFLICTS')).filter((f) => f.endsWith('.md')).length;
    // No new conflict atoms created on second reflect
    expect(countAfterSecond).toBe(countAfterFirst);
    expect(r2.conflicts_found).toBe(r1.conflicts_found);
  });
});
