/**
 * Compaction-loss torture tests — PRD v1.2 §12.4 PR gates.
 *
 * Verifies that all "compaction-resistant" field types from PRD §7.3 survive
 * reflect cycles, that replay is deterministic, and that reflect is idempotent.
 *
 * Tests 1-5:  Individual compaction-resistant sections survive reflect
 * Tests 6-7:  Full rich atom over N reflect cycles
 * Tests 8-9:  Replay determinism
 * Tests 10-11: Reflect idempotence
 * Tests 12-13: Recall correctness after reflect
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  initMemoryDir,
  createAtom,
  updateAtom,
  reflect,
  recall,
  readView,
  readEvents,
  replayFromFile,
  compactLog,
  listAtoms,
  closeAllIndexes,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const AGENT = 'compaction-agent';
const SESSION = 'compaction-session';
const base = (dir: string) => ({ memoryDir: dir, agent_id: AGENT, session_id: SESSION });

/**
 * Build a body that exercises all 5 compaction-resistant section types from
 * PRD §7.3. Any compaction cycle that corrupts this body is detectable by the
 * structural checks below.
 */
function richBody(tag: string): string {
  return [
    `## Decision`,
    ``,
    `Use ${tag} as the canonical approach.`,
    ``,
    `## Numbers`,
    `- Port: 8080`,
    `- Timeout: 30s`,
    `- Max retries: 3`,
    ``,
    `## Conditional Logic`,
    `- If production: use TLS`,
    `- If staging: allow HTTP`,
    `- If retries exhausted: circuit-break for 60s`,
    ``,
    `## Why`,
    `Rationale: ${tag} chosen after benchmarking three alternatives.`,
    `Evidence: load test at 1000 rps confirmed p95 < 50ms.`,
    ``,
    `## Cross-links`,
    `- Related: FACT-2026-AUTH-CONFIG`,
    `- Supersedes: DECI-OLD`,
    ``,
    `## Open Questions`,
    `- [ ] Does ${tag} handle IPv6?`,
    `- [ ] Fallback when primary fails?`,
  ].join('\n');
}

/**
 * Strip the YAML frontmatter block from a view file.
 * Views embed `updated_at: <wall-clock>` in their frontmatter, which changes
 * on every reflect call. Stripping it allows body-level idempotence checks.
 */
function stripFrontmatter(view: string): string {
  const lines = view.split('\n');
  if (lines[0] !== '---') return view;
  const end = lines.indexOf('---', 1);
  return end === -1 ? view : lines.slice(end + 1).join('\n');
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-compaction-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Block 1 — Individual compaction-resistant sections survive reflect (5 tests)
// ---------------------------------------------------------------------------

describe('compaction-resistant field sections survive reflect', () => {
  it('1. numbers section survives reflect', () => {
    createAtom({
      ...base(testDir),
      type: 'decision',
      slug: 'numbers-test',
      body: [
        '## Decision',
        'Use cursor pagination.',
        '',
        '## Numbers',
        '- Port: 8080',
        '- Timeout: 30s',
        '- Max retries: 3',
      ].join('\n'),
    });

    reflect(base(testDir));

    const atoms = listAtoms(testDir);
    expect(atoms).toHaveLength(1);
    const body = atoms[0]!.body;
    expect(body).toContain('Port: 8080');
    expect(body).toContain('Timeout: 30s');
    expect(body).toContain('Max retries: 3');
  });

  it('2. conditional logic section survives reflect', () => {
    createAtom({
      ...base(testDir),
      type: 'constraint',
      slug: 'conditional-test',
      body: [
        '## Constraint',
        'TLS enforcement rules.',
        '',
        '## Conditional Logic',
        '- If production: use TLS',
        '- If staging: allow HTTP',
        '- If retries exhausted: circuit-break for 60s',
      ].join('\n'),
    });

    reflect(base(testDir));

    const atoms = listAtoms(testDir);
    expect(atoms).toHaveLength(1);
    const body = atoms[0]!.body;
    expect(body).toContain('If production: use TLS');
    expect(body).toContain('If staging: allow HTTP');
    expect(body).toContain('If retries exhausted: circuit-break for 60s');
  });

  it('3. rationale section survives reflect', () => {
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'rationale-test',
      body: [
        '## Fact',
        'Cursor pagination is the chosen approach.',
        '',
        '## Why',
        'Rationale: offset pagination regressed beyond 1M rows.',
        'Evidence: load test at 1000 rps confirmed p95 < 50ms.',
      ].join('\n'),
    });

    reflect(base(testDir));

    const atoms = listAtoms(testDir);
    expect(atoms).toHaveLength(1);
    const body = atoms[0]!.body;
    expect(body).toContain('Rationale: offset pagination regressed beyond 1M rows.');
    expect(body).toContain('Evidence: load test at 1000 rps confirmed p95 < 50ms.');
  });

  it('4. cross-links section survives reflect', () => {
    createAtom({
      ...base(testDir),
      type: 'decision',
      slug: 'crosslinks-test',
      body: [
        '## Decision',
        'Use cursor-based pagination.',
        '',
        '## Cross-links',
        '- Related: FACT-2026-AUTH-CONFIG',
        '- Supersedes: DECI-OLD',
      ].join('\n'),
    });

    reflect(base(testDir));

    const atoms = listAtoms(testDir);
    expect(atoms).toHaveLength(1);
    const body = atoms[0]!.body;
    expect(body).toContain('Related: FACT-2026-AUTH-CONFIG');
    expect(body).toContain('Supersedes: DECI-OLD');
  });

  it('5. open questions section survives two reflect cycles', () => {
    createAtom({
      ...base(testDir),
      type: 'constraint',
      slug: 'openq-test',
      body: [
        '## Constraint',
        'Pagination rules.',
        '',
        '## Open Questions',
        '- [ ] Does the approach handle IPv6?',
        '- [ ] What is the fallback when the primary fails?',
      ].join('\n'),
    });

    // Double-reflect is the torture: must survive two consecutive cycles
    reflect(base(testDir));
    reflect(base(testDir));

    const atoms = listAtoms(testDir);
    expect(atoms).toHaveLength(1);
    const body = atoms[0]!.body;
    expect(body).toContain('Does the approach handle IPv6?');
    expect(body).toContain('What is the fallback when the primary fails?');
  });
});

// ---------------------------------------------------------------------------
// Block 2 — Full rich atom over N reflect cycles (2 tests)
// ---------------------------------------------------------------------------

describe('full rich atom over N reflect cycles', () => {
  it('6. full rich atom body survives 5 reflect cycles byte-identically', () => {
    createAtom({
      ...base(testDir),
      type: 'decision',
      slug: 'rich-atom',
      body: richBody('cursor-pagination'),
    });

    // Capture initial body
    const originalBody = listAtoms(testDir)[0]!.body;

    // Run 5 reflect cycles
    for (let i = 0; i < 5; i++) {
      reflect(base(testDir));
    }

    // Body must be byte-identical after all cycles
    const finalBody = listAtoms(testDir)[0]!.body;
    expect(finalBody).toBe(originalBody);
  });

  it('7. all 5 view files contain expected sections after 5 reflect cycles', () => {
    // Create one atom per view-relevant type
    createAtom({
      ...base(testDir),
      type: 'decision',
      slug: 'view-decision',
      body: '## Decision\nUse cursor pagination.',
    });
    createAtom({
      ...base(testDir),
      type: 'constraint',
      slug: 'view-constraint',
      body: '## Constraint\nMust use TLS.',
    });
    createAtom({
      ...base(testDir),
      type: 'open_question',
      slug: 'view-question',
      body: '## Question\nWhich protocol to use?',
    });
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'view-fact',
      body: '## Fact\nSystem uses port 8080.',
      confidence: 0.9,
    });
    // Belief below promotion threshold (0.85 < 0.9) — must NOT be promoted
    createAtom({
      ...base(testDir),
      type: 'belief',
      slug: 'view-belief',
      body: '## Belief\nCaching improves performance.',
      confidence: 0.85,
    });

    // Run 5 reflect cycles
    for (let i = 0; i < 5; i++) {
      reflect(base(testDir));
    }

    // All 5 views must contain their expected structural headings
    expect(readView(testDir, 'INDEX.md')).toContain('# Memory Index');
    expect(readView(testDir, 'DECISIONS.md')).toContain('# Decisions');
    expect(readView(testDir, 'CONSTRAINTS.md')).toContain('# Constraints');
    expect(readView(testDir, 'OPEN_QUESTIONS.md')).toContain('# Open Questions');
    expect(readView(testDir, 'HANDOFF.md')).toContain('# Handoff');

    // Belief with confidence < 0.9 must NOT have been promoted to fact
    const atoms = listAtoms(testDir);
    const beliefs = atoms.filter((a) => a.frontmatter.type === 'belief');
    expect(beliefs).toHaveLength(1);
    expect(beliefs[0]!.frontmatter.status).not.toBe('archived');
  });
});

// ---------------------------------------------------------------------------
// Block 3 — Replay determinism (2 tests)
// ---------------------------------------------------------------------------

describe('replay determinism', () => {
  const FIXED_TS = '2026-01-01T00:00:00Z';

  it('8. replay with fixed timestamp produces byte-identical views on repeated calls', () => {
    createAtom({
      ...base(testDir),
      type: 'decision',
      slug: 'det-dec',
      body: richBody('det'),
    });
    createAtom({
      ...base(testDir),
      type: 'constraint',
      slug: 'det-con',
      body: '## Constraint\nMust use TLS in production.',
    });
    createAtom({
      ...base(testDir),
      type: 'open_question',
      slug: 'det-oq',
      body: '## Question\nWhich protocol?',
    });

    const eventsFile = path.join(testDir, 'events.ndjson');

    const r1 = replayFromFile(eventsFile, { timestamp: FIXED_TS });
    const r2 = replayFromFile(eventsFile, { timestamp: FIXED_TS });

    // All 5 views must be byte-identical
    expect(r1.views.index).toBe(r2.views.index);
    expect(r1.views.decisions).toBe(r2.views.decisions);
    expect(r1.views.constraints).toBe(r2.views.constraints);
    expect(r1.views.open_questions).toBe(r2.views.open_questions);
    expect(r1.views.handoff).toBe(r2.views.handoff);

    // Atom map must have identical keys
    expect([...r1.atoms.keys()].sort()).toEqual([...r2.atoms.keys()].sort());

    // No replay errors
    expect(r1.errors).toHaveLength(0);
    expect(r2.errors).toHaveLength(0);
  });

  it('9. compact then replay: views byte-identical to pre-compact replay', () => {
    // Create 3 atoms, each updated once (adds intermediate mutation events)
    const a1 = createAtom({
      ...base(testDir),
      type: 'decision',
      slug: 'compact-dec',
      body: richBody('compact-dec'),
    });
    updateAtom({ ...base(testDir), filePath: a1.filePath!, updates: {}, body: 'Updated: ' + richBody('compact-dec-v2') });

    const a2 = createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'compact-fact',
      body: '## Fact\nSystem uses port 8080.',
      confidence: 0.9,
    });
    updateAtom({ ...base(testDir), filePath: a2.filePath!, updates: { confidence: 0.95 } });

    const a3 = createAtom({
      ...base(testDir),
      type: 'constraint',
      slug: 'compact-con',
      body: '## Constraint\nMust use TLS.',
    });
    updateAtom({ ...base(testDir), filePath: a3.filePath!, updates: {}, body: '## Constraint\nMust use TLS v1.3+.' });

    const eventsFile = path.join(testDir, 'events.ndjson');

    // Pre-compact replay
    const before = replayFromFile(eventsFile, { timestamp: FIXED_TS });

    // Compact removes intermediate mutation events
    compactLog(testDir);

    // Post-compact replay
    const after = replayFromFile(eventsFile, { timestamp: FIXED_TS });

    // State-derived views must be byte-identical before and after compaction.
    // HANDOFF is excluded: its "Recent Activity" section is event-history-based,
    // and compactLog intentionally removes intermediate events (atom_created for
    // atoms that were later updated), which changes that section. This is correct
    // behavior — HANDOFF reflects current session activity, not all-time history.
    expect(after.views.index).toBe(before.views.index);
    expect(after.views.decisions).toBe(before.views.decisions);
    expect(after.views.constraints).toBe(before.views.constraints);
    expect(after.views.open_questions).toBe(before.views.open_questions);

    // Same atom IDs before and after
    expect([...after.atoms.keys()].sort()).toEqual([...before.atoms.keys()].sort());
  });
});

// ---------------------------------------------------------------------------
// Block 4 — Reflect idempotence (2 tests)
// ---------------------------------------------------------------------------

describe('reflect idempotence', () => {
  it('10. reflect(reflect(x)) view bodies equal reflect(x) view bodies', () => {
    createAtom({
      ...base(testDir),
      type: 'decision',
      slug: 'idem-dec',
      body: richBody('idem'),
    });
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'idem-fact',
      body: '## Fact\nThe system is stable.',
      confidence: 0.9,
    });
    createAtom({
      ...base(testDir),
      type: 'constraint',
      slug: 'idem-con',
      body: '## Constraint\nMust validate all inputs.',
    });

    // First reflect
    reflect(base(testDir));
    const afterFirst = {
      index: stripFrontmatter(readView(testDir, 'INDEX.md')),
      decisions: stripFrontmatter(readView(testDir, 'DECISIONS.md')),
      constraints: stripFrontmatter(readView(testDir, 'CONSTRAINTS.md')),
      questions: stripFrontmatter(readView(testDir, 'OPEN_QUESTIONS.md')),
      // HANDOFF excluded: its body contains Last event: <timestamp> which changes per reflect
    };

    // Second reflect on the same unchanged atoms
    reflect(base(testDir));
    const afterSecond = {
      index: stripFrontmatter(readView(testDir, 'INDEX.md')),
      decisions: stripFrontmatter(readView(testDir, 'DECISIONS.md')),
      constraints: stripFrontmatter(readView(testDir, 'CONSTRAINTS.md')),
      questions: stripFrontmatter(readView(testDir, 'OPEN_QUESTIONS.md')),
    };

    expect(afterSecond.index).toBe(afterFirst.index);
    expect(afterSecond.decisions).toBe(afterFirst.decisions);
    expect(afterSecond.constraints).toBe(afterFirst.constraints);
    expect(afterSecond.questions).toBe(afterFirst.questions);
  });

  it('11. reflect result counts are zero on second reflect when no atoms change', () => {
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'idem-f1',
      body: '## Fact\nSystem uses port 8080.',
      confidence: 0.9,
    });
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'idem-f2',
      body: '## Fact\nDefault timeout is 30s.',
      confidence: 0.9,
    });
    // Belief below promotion threshold (0.85 < 0.9) — must NOT be promoted
    createAtom({
      ...base(testDir),
      type: 'belief',
      slug: 'idem-b1',
      body: '## Belief\nCaching will reduce latency.',
      confidence: 0.85,
    });

    // First reflect: may do initial work
    const r1 = reflect(base(testDir));
    expect(r1.promoted).toBe(0); // confidence 0.85 < 0.9

    // Second reflect: no atoms have changed — all counts must be zero
    const r2 = reflect(base(testDir));
    expect(r2.deduped).toBe(0);
    expect(r2.expired).toBe(0);
    expect(r2.promoted).toBe(0);

    // Atom count unchanged
    const atoms = listAtoms(testDir);
    expect(atoms.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Block 5 — Recall correctness after reflect (2 tests)
// ---------------------------------------------------------------------------

describe('recall correctness after reflect', () => {
  it('12. recall returns a promoted draft fact as active after reflect', () => {
    // Aged, confident fact draft → promoted draft→active (status-only, #274 Gap 2).
    const draft = createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'promotable',
      body: '## Fact\nThe system scales horizontally.',
      confidence: 0.95,
      status: 'draft',
      ttl_days: null,
    });
    // Backdate >48h so the promotion age gate passes.
    const old = '2026-01-01T00:00:00Z';
    const backdated = fs.readFileSync(draft.filePath!, 'utf-8')
      .replace(/created_at: .*/, `created_at: "${old}"`)
      .replace(/updated_at: .*/, `updated_at: "${old}"`);
    fs.writeFileSync(draft.filePath!, backdated);

    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'baseline-fact',
      body: '## Fact\nSystem uses port 8080.',
      confidence: 0.9,
    });

    const r = reflect(base(testDir));
    expect(r.promoted).toBe(1); // the aged draft fact was promoted

    // Recall with type filter: only facts
    const bundle = recall(testDir, { types: ['fact'] });

    // Both the original fact and the promoted belief must appear as facts
    expect(bundle.atoms.length).toBe(2);
    expect(bundle.atoms.every((a) => a.frontmatter.type === 'fact')).toBe(true);

    // No beliefs in the result
    const beliefAtoms = bundle.atoms.filter((a) => a.frontmatter.type === 'belief');
    expect(beliefAtoms).toHaveLength(0);
  });

  it('13. recall after compact+reflect returns same atom IDs as before compact', () => {
    createAtom({ ...base(testDir), type: 'decision', slug: 'cr-dec1', body: '## Decision\nUse cursor pagination.' });
    createAtom({ ...base(testDir), type: 'decision', slug: 'cr-dec2', body: '## Decision\nUse JWT tokens.' });
    createAtom({ ...base(testDir), type: 'fact', slug: 'cr-fact1', body: '## Fact\nSystem port is 8080.', confidence: 0.9 });

    // Reflect to generate views + index
    reflect(base(testDir));

    // Capture atom IDs before compact
    const idsBefore = recall(testDir, {})
      .atoms.map((a) => a.frontmatter.id)
      .sort();

    // Compact log + re-reflect
    compactLog(testDir);
    reflect(base(testDir));

    // Atom IDs must be identical after compact+reflect
    const idsAfter = recall(testDir, {})
      .atoms.map((a) => a.frontmatter.id)
      .sort();

    expect(idsAfter).toEqual(idsBefore);
  });
});
