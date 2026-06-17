/**
 * Tests for grounding-score reconciliation — Phase 1, advisory (#245).
 *
 * The engine is pure (atoms + events in, report out), so most tests build
 * fixtures as plain objects with a fixed injected `now` for exact arithmetic.
 * The integration block exercises the real store + CLI and asserts the critical
 * safety property: running `mk grounding` does NOT modify any atom file.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  computeGrounding,
  classifyQuadrant,
  initMemoryDir,
  createAtom,
  writeAtom,
  appendEvent,
  listAtoms,
  closeAllIndexes,
} from '../src/index.js';
import type { ClassifyContext } from '../src/index.js';
import type { Atom, AtomType, AtomStatus, MemoryEvent } from '../src/types.js';

// --- Fixed clock + fixture builders ---

const NOW = Date.UTC(2026, 5, 16, 12, 0, 0); // 2026-06-16T12:00:00Z
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

let evtSeq = 0;

function makeAtom(p: {
  id?: string;
  type?: AtomType;
  status?: AtomStatus;
  confidence?: number;
  createdDaysAgo?: number;
}): Atom {
  const created = NOW - (p.createdDaysAgo ?? 10) * DAY;
  return {
    frontmatter: {
      id: p.id ?? `FACT-2026-01-01-X-${(evtSeq++).toString().padStart(5, '0')}`,
      type: p.type ?? 'fact',
      status: p.status ?? 'active',
      confidence: p.confidence ?? 0.7,
      created_at: iso(created),
      updated_at: iso(created),
      ttl_days: null,
    },
    body: 'body',
  };
}

function readEvt(atomId: string, daysAgo: number, session = 's1'): MemoryEvent {
  return {
    event_id: `evt-${evtSeq++}`,
    timestamp: iso(NOW - daysAgo * DAY),
    agent_id: 'a',
    session_id: session,
    action: 'atom_read',
    atom_refs: [atomId],
  };
}

function conflictEvt(atomIds: string[], daysAgo = 1, session = 's-conflict'): MemoryEvent {
  return {
    event_id: `evt-${evtSeq++}`,
    timestamp: iso(NOW - daysAgo * DAY),
    agent_id: 'a',
    session_id: session,
    action: 'conflict_detected',
    atom_refs: atomIds,
    schema_version: 2,
  };
}

/** n read events, all `daysAgo`, in the given session. */
function reads(atomId: string, n: number, daysAgo: number, session = 's1'): MemoryEvent[] {
  return Array.from({ length: n }, () => readEvt(atomId, daysAgo, session));
}

const opts = { now: NOW };

describe('computeGrounding() — score mechanics', () => {
  it('never-read atom sits at the floor (recency 0, frequency 0)', () => {
    const atom = makeAtom({ id: 'FACT-a', confidence: 0.7, createdDaysAgo: 5 });
    const { reports } = computeGrounding([atom], [], opts);
    expect(reports).toHaveLength(1);
    expect(reports[0].grounding_score).toBe(0.01);
    expect(reports[0].inputs.n_access).toBe(0);
    expect(reports[0].inputs.days_since_last_read).toBeNull();
    // Age must NOT lift a never-read atom: a fresh never-read atom also floors.
    const fresh = makeAtom({ id: 'FACT-fresh', createdDaysAgo: 0 });
    expect(computeGrounding([fresh], [], opts).reports[0].grounding_score).toBe(0.01);
  });

  it('read-recency decay is type-parameterized (fact decays faster than belief)', () => {
    const fact = makeAtom({ id: 'FACT-x', type: 'fact', confidence: 0.5 });
    const belief = makeAtom({ id: 'BELI-x', type: 'belief', confidence: 0.5 });
    const events = [readEvt('FACT-x', 30), readEvt('BELI-x', 30)];
    const { reports } = computeGrounding([fact, belief], events, opts);
    const byId = Object.fromEntries(reports.map((r) => [r.atom_id, r]));
    // fact H=30 → recency 0.5; belief H=180 → recency ~0.891. freq identical (n=1).
    // g = 0.5*recency + 0.5*(1-2^-0.2)
    expect(byId['FACT-x'].grounding_score).toBeCloseTo(0.3147, 3);
    expect(byId['BELI-x'].grounding_score).toBeCloseTo(0.5102, 3);
    expect(byId['FACT-x'].grounding_score).toBeLessThan(byId['BELI-x'].grounding_score);
  });

  it('frequency has diminishing returns (each extra read adds less)', () => {
    // All read today (recency = 1), single session → g = 0.5 + 0.5*frequency(n).
    const g = (n: number) => {
      const id = `FACT-n${n}`;
      const atom = makeAtom({ id, type: 'fact' });
      return computeGrounding([atom], reads(id, n, 0), opts).reports[0].grounding_score;
    };
    const g1 = g(1);
    const g2 = g(2);
    const g3 = g(3);
    const g4 = g(4);
    expect(g2 - g1).toBeGreaterThan(g3 - g2);
    expect(g3 - g2).toBeGreaterThan(g4 - g3);
    // K=5 → frequency(5) = 1 - 2^-1 = 0.5 → g = 0.75.
    expect(g(5)).toBeCloseTo(0.75, 4);
  });

  it('conflicts apply a multiplicative discount (×0.6 per conflict)', () => {
    const base = makeAtom({ id: 'FACT-c0' });
    const one = makeAtom({ id: 'FACT-c1' });
    const two = makeAtom({ id: 'FACT-c2' });
    const events = [
      ...reads('FACT-c0', 5, 0),
      ...reads('FACT-c1', 5, 0),
      conflictEvt(['FACT-c1']),
      ...reads('FACT-c2', 5, 0),
      conflictEvt(['FACT-c2']),
      conflictEvt(['FACT-c2']),
    ];
    const r = Object.fromEntries(
      computeGrounding([base, one, two], events, opts).reports.map((x) => [x.atom_id, x]),
    );
    expect(r['FACT-c0'].grounding_score).toBeCloseTo(0.75, 4);
    expect(r['FACT-c1'].grounding_score).toBeCloseTo(0.75 * 0.6, 4);
    expect(r['FACT-c2'].grounding_score).toBeCloseTo(0.75 * 0.36, 4);
    expect(r['FACT-c1'].inputs.n_conflict).toBe(1);
    expect(r['FACT-c2'].inputs.n_conflict).toBe(2);
  });

  it('clamps to [0.01, 1.0]; heavy use cannot exceed 1, conflicts keep a hot atom down', () => {
    const hot = makeAtom({ id: 'FACT-hot' });
    const hotConflicted = makeAtom({ id: 'FACT-hotc' });
    const events = [
      ...reads('FACT-hot', 1000, 0),
      ...reads('FACT-hotc', 100, 0),
      conflictEvt(['FACT-hotc']),
      conflictEvt(['FACT-hotc']),
    ];
    const r = Object.fromEntries(
      computeGrounding([hot, hotConflicted], events, opts).reports.map((x) => [x.atom_id, x]),
    );
    expect(r['FACT-hot'].grounding_score).toBeLessThanOrEqual(1.0);
    expect(r['FACT-hot'].grounding_score).toBeCloseTo(1.0, 3);
    // 100 reads but 2 conflicts → ~ (≈1)*0.36, well under 1.
    expect(r['FACT-hotc'].grounding_score).toBeLessThan(0.4);
  });

  it('reports usage inputs faithfully', () => {
    const atom = makeAtom({ id: 'FACT-in', createdDaysAgo: 20 });
    const events = [
      readEvt('FACT-in', 2, 's1'),
      readEvt('FACT-in', 5, 's2'),
      readEvt('FACT-in', 9, 's2'),
      conflictEvt(['FACT-in'], 1),
    ];
    const { reports } = computeGrounding([atom], events, opts);
    const inp = reports[0].inputs;
    expect(inp.n_access).toBe(3);
    expect(inp.n_conflict).toBe(1);
    expect(inp.session_diversity).toBe(2); // s1, s2
    expect(inp.days_since_last_read).toBeCloseTo(2, 5); // most recent read
    expect(inp.age_days).toBeCloseTo(20, 5);
  });
});

describe('classifyQuadrant() — 2×2 + actionability guards', () => {
  const base: ClassifyContext = {
    priorThreshold: 0.6,
    groundingThreshold: 0.5,
    sessionDiversity: 0,
    promoteMinSessions: 2,
    sessionsSinceCreation: 0,
    noiseSessions: 5,
  };

  it('well-grounded: high prior, high grounding — not actionable', () => {
    const v = classifyQuadrant(0.8, 0.7, base);
    expect(v.quadrant).toBe('well-grounded');
    expect(v.actionable).toBe(false);
  });

  it('review: high prior, low grounding — actionable', () => {
    const v = classifyQuadrant(0.8, 0.2, base);
    expect(v.quadrant).toBe('review');
    expect(v.actionable).toBe(true);
  });

  it('promote: low prior, high grounding — actionable only with cross-session corroboration', () => {
    const multi = classifyQuadrant(0.3, 0.7, { ...base, sessionDiversity: 3 });
    expect(multi.quadrant).toBe('promote');
    expect(multi.actionable).toBe(true);
    const single = classifyQuadrant(0.3, 0.7, { ...base, sessionDiversity: 1 });
    expect(single.quadrant).toBe('promote');
    expect(single.actionable).toBe(false);
  });

  it('noise: low/low — actionable only after enough sessions elapse', () => {
    const old = classifyQuadrant(0.3, 0.2, { ...base, sessionsSinceCreation: 6 });
    expect(old.quadrant).toBe('noise');
    expect(old.actionable).toBe(true);
    const recent = classifyQuadrant(0.3, 0.2, { ...base, sessionsSinceCreation: 2 });
    expect(recent.quadrant).toBe('noise');
    expect(recent.actionable).toBe(false);
  });

  it('thresholds are inclusive (prior/grounding exactly at τ count as high)', () => {
    expect(classifyQuadrant(0.6, 0.5, base).quadrant).toBe('well-grounded');
  });
});

describe('computeGrounding() — end-to-end quadrant assignment', () => {
  it('places atoms in all four quadrants from seeded events', () => {
    // well-grounded: high prior, read across 3 sessions recently.
    const wg = makeAtom({ id: 'FACT-wg', confidence: 0.9, createdDaysAgo: 40 });
    // review: high prior, never read.
    const rv = makeAtom({ id: 'FACT-rv', confidence: 0.9, createdDaysAgo: 60 });
    // promote: low prior, read across 3 sessions recently.
    const pr = makeAtom({ id: 'BELI-pr', type: 'belief', confidence: 0.3, createdDaysAgo: 40 });
    // noise: low prior, never read, lived through many sessions.
    const nz = makeAtom({ id: 'FACT-nz', confidence: 0.3, createdDaysAgo: 60 });

    const events: MemoryEvent[] = [
      readEvt('FACT-wg', 1, 's1'),
      readEvt('FACT-wg', 2, 's2'),
      readEvt('FACT-wg', 3, 's3'),
      readEvt('BELI-pr', 1, 's1'),
      readEvt('BELI-pr', 2, 's2'),
      readEvt('BELI-pr', 3, 's3'),
      // 5 distinct sessions of activity after creation → sessions_since_creation ≥ 5 for nz.
      readEvt('FACT-wg', 1, 's4'),
      readEvt('BELI-pr', 2, 's5'),
    ];

    const { reports, summary } = computeGrounding([wg, rv, pr, nz], events, opts);
    const q = Object.fromEntries(reports.map((r) => [r.atom_id, r]));

    expect(q['FACT-wg'].quadrant).toBe('well-grounded');
    expect(q['FACT-wg'].actionable).toBe(false);

    expect(q['FACT-rv'].quadrant).toBe('review');
    expect(q['FACT-rv'].actionable).toBe(true);

    expect(q['BELI-pr'].quadrant).toBe('promote');
    expect(q['BELI-pr'].actionable).toBe(true);
    expect(q['BELI-pr'].inputs.session_diversity).toBeGreaterThanOrEqual(2);

    expect(q['FACT-nz'].quadrant).toBe('noise');
    expect(q['FACT-nz'].inputs.sessions_since_creation).toBeGreaterThanOrEqual(5);
    expect(q['FACT-nz'].actionable).toBe(true);

    // Summary integrity.
    const sum =
      summary.by_quadrant['well-grounded'] +
      summary.by_quadrant.review +
      summary.by_quadrant.promote +
      summary.by_quadrant.noise;
    expect(sum).toBe(summary.total);
    expect(summary.total).toBe(4);
    expect(summary.actionable).toBe(reports.filter((r) => r.actionable).length);

    // Actionable atoms sort first.
    const firstInert = reports.findIndex((r) => !r.actionable);
    const lastActionable = reports.map((r) => r.actionable).lastIndexOf(true);
    expect(firstInert).toBeGreaterThan(lastActionable);
  });
});

describe('computeGrounding() — scope filtering', () => {
  it('grades only active, non-conflict atoms by default; includeAll opts in', () => {
    const active = makeAtom({ id: 'FACT-active', status: 'active' });
    const draft = makeAtom({ id: 'FACT-draft', status: 'draft' });
    const archived = makeAtom({ id: 'FACT-arch', status: 'archived' });
    const conflict = makeAtom({ id: 'CONF-x', type: 'conflict', status: 'active' });
    const atoms = [active, draft, archived, conflict];

    const def = computeGrounding(atoms, [], opts);
    expect(def.reports.map((r) => r.atom_id)).toEqual(['FACT-active']);

    const all = computeGrounding(atoms, [], { ...opts, includeAll: true });
    expect(all.reports.map((r) => r.atom_id).sort()).toEqual(
      ['CONF-x', 'FACT-active', 'FACT-arch', 'FACT-draft'].sort(),
    );
  });
});

describe('computeGrounding() — purity', () => {
  it('does not mutate the input atoms or events', () => {
    const atoms = [makeAtom({ id: 'FACT-p', confidence: 0.4 })];
    const events = [readEvt('FACT-p', 1), conflictEvt(['FACT-p'])];
    const atomsSnap = JSON.stringify(atoms);
    const eventsSnap = JSON.stringify(events);
    computeGrounding(atoms, events, opts);
    expect(JSON.stringify(atoms)).toBe(atomsSnap);
    expect(JSON.stringify(events)).toBe(eventsSnap);
  });

  it('empty store → empty report', () => {
    const { reports, summary } = computeGrounding([], [], opts);
    expect(reports).toHaveLength(0);
    expect(summary.total).toBe(0);
    expect(summary.actionable).toBe(0);
  });
});

describe('computeGrounding() — input edge cases', () => {
  it('includeAll grades a conflict-type atom from its own reads', () => {
    const conf = makeAtom({ id: 'CONF-scored', type: 'conflict', status: 'active', confidence: 0.5 });
    // 5 reads today, single session, no conflict_detected events → recency 1,
    // frequency(5)=0.5, no conflict discount → g = 0.75.
    const { reports } = computeGrounding([conf], reads('CONF-scored', 5, 0), { ...opts, includeAll: true });
    expect(reports).toHaveLength(1);
    expect(reports[0].atom_id).toBe('CONF-scored');
    expect(reports[0].grounding_score).toBeCloseTo(0.75, 4);
    expect(reports[0].inputs.n_access).toBe(5);
    expect(reports[0].inputs.n_conflict).toBe(0);
  });

  it('grades an atom whose created_at is unparseable (age_days 0, no sessions-since)', () => {
    const atom = makeAtom({ id: 'FACT-nocreate' });
    atom.frontmatter.created_at = 'not-a-date';
    const { reports } = computeGrounding([atom], reads('FACT-nocreate', 3, 0), opts);
    expect(reports).toHaveLength(1);
    expect(reports[0].inputs.age_days).toBe(0);
    expect(reports[0].inputs.sessions_since_creation).toBe(0);
    expect(reports[0].inputs.n_access).toBe(3);
  });

  it('a session-less read counts toward n_access but not session_diversity', () => {
    const atom = makeAtom({ id: 'FACT-nosess' });
    const evt = readEvt('FACT-nosess', 0);
    delete (evt as { session_id?: string }).session_id;
    const { reports } = computeGrounding([atom], [evt], opts);
    expect(reports[0].inputs.n_access).toBe(1);
    expect(reports[0].inputs.session_diversity).toBe(0);
  });

  it('a malformed-timestamp read contributes to neither n_access nor session_diversity', () => {
    const atom = makeAtom({ id: 'FACT-badts' });
    const good = readEvt('FACT-badts', 0, 's1');
    const bad = readEvt('FACT-badts', 0, 's2');
    bad.timestamp = 'garbage';
    const { reports } = computeGrounding([atom], [good, bad], opts);
    // Only the well-formed read counts → n_access 1, session_diversity 1 (s1 only).
    expect(reports[0].inputs.n_access).toBe(1);
    expect(reports[0].inputs.session_diversity).toBe(1);
  });

  it('a malformed-timestamp conflict_detected does NOT discount grounding (symmetric with reads)', () => {
    // A read we won't trust for recency shouldn't be trusted to discount the score
    // either: the conflict branch is gated on validTs just like atom_read.
    const atom = makeAtom({ id: 'FACT-badconf', type: 'fact' });
    const reads0 = reads('FACT-badconf', 5, 0); // recency 1, freq(5)=0.5 → raw 0.75
    const badConflict = conflictEvt(['FACT-badconf'], 1);
    badConflict.timestamp = 'garbage';
    const { reports } = computeGrounding([atom], [...reads0, badConflict], opts);
    expect(reports[0].inputs.n_conflict).toBe(0); // garbage-timestamp conflict dropped
    expect(reports[0].grounding_score).toBeCloseTo(0.75, 4); // no 0.6× discount applied
  });
});

describe('computeGrounding() — knob validation (public-API guards)', () => {
  const atom = makeAtom({ id: 'FACT-v' });
  // The thresholds and the actionability-guard session counts are public knobs;
  // an out-of-range value silently empties quadrants / disables a guard, so the
  // engine validates them rather than leaving it to the CLI.
  it.each([
    ['priorThreshold', { priorThreshold: 1.5 }],
    ['priorThreshold', { priorThreshold: NaN }],
    ['groundingThreshold', { groundingThreshold: -0.1 }],
    ['groundingThreshold', { groundingThreshold: NaN }],
    ['promoteMinSessions', { promoteMinSessions: -1 }],
    ['promoteMinSessions', { promoteMinSessions: NaN }],
    ['noiseSessions', { noiseSessions: -1 }],
    ['noiseSessions', { noiseSessions: NaN }],
  ])('throws RangeError for out-of-range %s', (label, override) => {
    const call = () => computeGrounding([atom], [], { ...opts, ...override });
    // Pin each case to the guard it's meant to exercise, not just "some RangeError":
    // the messages start with the knob name, so a regression that made an *earlier*
    // guard fire for the wrong reason would now be caught.
    expect(call).toThrow(RangeError);
    expect(call).toThrow(new RegExp(`^${label} must be`));
  });
});

// --- Integration: real store + CLI, no-writes invariant ---

const CLI = path.resolve('dist/cli/mk.js');

function mk(...args: string[]): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      encoding: 'utf-8',
      timeout: 15000,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return { stdout: err.stdout ?? '', exitCode: err.status ?? 1 };
  }
}

/**
 * Snapshot every regular file under `root` as {relpath → content+mtime}, so the
 * no-writes invariant can assert the *entire* store tree is untouched — not just
 * the atom files — and catch any stray write (e.g. an index db, a log append).
 */
function walkTree(root: string): Map<string, { body: string; mtime: number }> {
  const out = new Map<string, { body: string; mtime: number }>();
  const visit = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) visit(full);
      else if (ent.isFile()) {
        out.set(path.relative(root, full), {
          body: fs.readFileSync(full, 'utf-8'),
          mtime: fs.statSync(full).mtimeMs,
        });
      }
    }
  };
  visit(root);
  return out;
}

describe('mk grounding (CLI) — wiring + no-writes invariant', () => {
  let testDir: string;

  beforeAll(() => {
    // The integration block shells out to the built CLI; fail loudly with a
    // clear message rather than an opaque ENOENT if `npm run build` was skipped.
    if (!fs.existsSync(CLI)) {
      throw new Error(`dist not built — run \`npm run build\` first (expected ${CLI})`);
    }
  });

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-grounding-'));
    initMemoryDir(testDir);
  });

  afterEach(() => {
    closeAllIndexes();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function activeAtom(slug: string, type: AtomType, confidence: number): Atom {
    const atom = createAtom({
      agent_id: 'test',
      session_id: 'test-session',
      memoryDir: testDir,
      type,
      slug,
      body: `## ${slug}\nContent.`,
      confidence,
    });
    atom.frontmatter.status = 'active';
    writeAtom(atom, atom.filePath!);
    return atom;
  }

  it('runs read-only, emits JSON, and leaves every atom file byte-identical', () => {
    const a = activeAtom('alpha', 'fact', 0.9);
    const b = activeAtom('beta', 'belief', 0.3);
    activeAtom('gamma', 'decision', 0.8);

    // Seed usage on two of them across distinct sessions.
    appendEvent(testDir, 'atom_read', { agent_id: 'test', session_id: 's1', atom_refs: [a.frontmatter.id] });
    appendEvent(testDir, 'atom_read', { agent_id: 'test', session_id: 's2', atom_refs: [b.frontmatter.id] });
    appendEvent(testDir, 'atom_read', { agent_id: 'test', session_id: 's3', atom_refs: [b.frontmatter.id] });

    expect(listAtoms(testDir).length).toBe(3);

    // Snapshot the ENTIRE store tree (content + mtime), not just atom files, so a
    // stray write anywhere — an index db, an extra event append — is caught too.
    const before = walkTree(testDir);

    const json = mk('grounding', '-d', testDir, '--json');
    expect(json.exitCode).toBe(0);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.summary.total).toBe(3);
    expect(Array.isArray(parsed.reports)).toBe(true);

    // No-writes invariant: the tree is byte-identical and no file appeared/vanished.
    const after = walkTree(testDir);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [rel, snap] of before) {
      const now = after.get(rel)!;
      expect(now.body).toBe(snap.body);
      expect(now.mtime).toBe(snap.mtime);
    }

    // Human output path also works and stays exit 0.
    const human = mk('grounding', '-d', testDir);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain('Grounding report');
    expect(human.stdout).toContain('advisory');
  });

  it('reads the event log directly — never builds the SQLite index', () => {
    activeAtom('alpha', 'fact', 0.9);
    appendEvent(testDir, 'atom_read', { agent_id: 'test', session_id: 's1', atom_refs: ['x'] });

    // Store setup (createAtom) may have built an index; drop it so we can prove
    // grounding does not recreate one — the read-only path must not open it.
    closeAllIndexes();
    const indexDb = path.join(testDir, '.memory-index.db');
    fs.rmSync(indexDb, { force: true });
    expect(fs.existsSync(indexDb)).toBe(false);

    const res = mk('grounding', '-d', testDir, '--json');
    expect(res.exitCode).toBe(0);
    expect(fs.existsSync(indexDb)).toBe(false); // still absent → grounding never indexed
  });

  it('--actionable-only filters rows but keeps the full summary', () => {
    activeAtom('solo', 'fact', 0.9); // high prior, never read → review (actionable)
    activeAtom('quiet', 'fact', 0.3); // low prior, never read, fresh → noise (not actionable)

    const res = mk('grounding', '-d', testDir, '--json', '--actionable-only');
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.summary.total).toBe(2); // summary unaffected by the row filter
    expect(parsed.reports.every((r: any) => r.actionable)).toBe(true);
    expect(parsed.shown).toBe(parsed.reports.length); // filtered row-count is machine-readable
  });

  it('rejects out-of-range thresholds', () => {
    const res = mk('grounding', '-d', testDir, '--prior-threshold', '5');
    expect(res.exitCode).not.toBe(0);
  });
});
