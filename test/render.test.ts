/**
 * Tests for renderClaudeMd() — CLAUDE.md generation from memory atoms.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { initMemoryDir, createAtom, closeAllIndexes, openIndex } from '../src/index.js';
import { addRelation } from '../src/index-db.js';
import { renderClaudeMd } from '../src/render.js';
import { parseRenderStats, degenerateOutputWarning } from '../src/deprecations.js';

let testDir: string;

const base = () => ({
  memoryDir: testDir,
  agent_id: 'test',
  session_id: 'test-session',
});

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-render-'));
  initMemoryDir(testDir);
  openIndex(testDir); // ensure DB exists for relation indexing
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('renderClaudeMd', () => {
  it('renders empty memory dir without error', () => {
    const output = renderClaudeMd(testDir);
    expect(output).toContain('# Memory');
    expect(output).toContain('0 atoms');
  });

  it('includes metadata comment with atom count and event count', () => {
    createAtom({ ...base(), type: 'fact', slug: 'lang', body: 'TypeScript is the language of choice.' });
    const output = renderClaudeMd(testDir);
    expect(output).toMatch(/\d+ atoms, \d+ events/);
    expect(output).toContain('Last rendered:');
    expect(output).toContain(`Source: ${testDir}`);
  });

  it('renders facts under Key Facts section', () => {
    createAtom({ ...base(), type: 'fact', slug: 'sqlite', body: 'We use SQLite for the index.' });
    const output = renderClaudeMd(testDir);
    expect(output).toContain('## Key Facts');
    expect(output).toContain('We use SQLite for the index.');
  });

  it('renders decisions with confidence suffix', () => {
    createAtom({ ...base(), type: 'decision', slug: 'eventsource', body: 'Use event sourcing.', confidence: 0.9 });
    const output = renderClaudeMd(testDir);
    expect(output).toContain('## Decisions');
    expect(output).toContain('(confidence: 0.9)');
    expect(output).toContain('Use event sourcing.');
  });

  it('renders decisions section when no explicit confidence given', () => {
    // createAtom applies a default confidence, so the section heading and suffix are always present.
    createAtom({ ...base(), type: 'decision', slug: 'eventsource', body: 'Use event sourcing.' });
    const output = renderClaudeMd(testDir);
    expect(output).toContain('## Decisions');
    expect(output).toContain('Use event sourcing.');
  });

  it('renders constraints section', () => {
    createAtom({ ...base(), type: 'constraint', slug: 'nonet', body: 'No outbound network calls.' });
    const output = renderClaudeMd(testDir);
    expect(output).toContain('## Constraints');
    expect(output).toContain('No outbound network calls.');
  });

  it('renders open questions section', () => {
    createAtom({ ...base(), type: 'open_question', slug: 'mergeq', body: 'How should we handle merge conflicts?' });
    const output = renderClaudeMd(testDir);
    expect(output).toContain('## Open Questions');
    expect(output).toContain('How should we handle merge conflicts?');
  });

  it('renders preferences section', () => {
    createAtom({ ...base(), type: 'preference', slug: 'immutable', body: 'Prefer immutable data structures.' });
    const output = renderClaudeMd(testDir);
    expect(output).toContain('## Preferences');
    expect(output).toContain('Prefer immutable data structures.');
  });

  it('renders beliefs with confidence suffix', () => {
    createAtom({ ...base(), type: 'belief', slug: 'ids', body: 'Atom IDs should be immutable.', confidence: 0.7 });
    const output = renderClaudeMd(testDir);
    expect(output).toContain('## Beliefs (unverified)');
    expect(output).toContain('(confidence: 0.7)');
  });

  it('renders conflicts before other sections', () => {
    createAtom({ ...base(), type: 'fact', slug: 'somefact', body: 'Fact atom.' });
    createAtom({ ...base(), type: 'conflict', slug: 'conflict1', body: 'Conflicting information detected.' });
    const output = renderClaudeMd(testDir);
    const conflictPos = output.indexOf('## ⚠ Active Conflicts');
    const factsPos = output.indexOf('## Key Facts');
    expect(conflictPos).toBeGreaterThanOrEqual(0);
    expect(factsPos).toBeGreaterThan(conflictPos);
  });

  it('omits empty sections', () => {
    createAtom({ ...base(), type: 'fact', slug: 'onlyfact', body: 'Only a fact.' });
    const output = renderClaudeMd(testDir);
    expect(output).not.toContain('## Decisions');
    expect(output).not.toContain('## Constraints');
    expect(output).not.toContain('## Open Questions');
    expect(output).not.toContain('## ⚠ Active Conflicts');
  });

  it('respects maxTokens — atoms beyond budget are excluded', () => {
    for (let i = 0; i < 20; i++) {
      createAtom({ ...base(), type: 'fact', slug: `fact${i}`, body: `Fact number ${i} with enough text to consume tokens in the budget.` });
    }
    const unlimited = renderClaudeMd(testDir);
    const limited = renderClaudeMd(testDir, { maxTokens: 50 });
    const unlimitedCount = (unlimited.match(/^### /gm) ?? []).length;
    const limitedCount = (limited.match(/^### /gm) ?? []).length;
    expect(limitedCount).toBeLessThan(unlimitedCount);
  });

  it('excludes SECRET and PERSONAL atoms', () => {
    createAtom({ ...base(), type: 'fact', slug: 'public', body: 'Public fact.' });
    createAtom({ ...base(), type: 'fact', slug: 'secret', body: 'Secret fact.', classification: 'SECRET' });
    createAtom({ ...base(), type: 'fact', slug: 'personal', body: 'Personal fact.', classification: 'PERSONAL' });
    const output = renderClaudeMd(testDir);
    expect(output).toContain('Public fact.');
    expect(output).not.toContain('Secret fact.');
    expect(output).not.toContain('Personal fact.');
  });

  it('returns a string ending with a newline', () => {
    const output = renderClaudeMd(testDir);
    expect(output.endsWith('\n')).toBe(true);
  });

  // --- Graph-ordered belief rendering ---

  describe('belief developmental arcs', () => {
    it('renders belief extends chain as developmental arc', () => {
      const a = createAtom({ ...base(), type: 'belief', slug: 'ma-intervals', body: 'Silence between notes matters.', confidence: 0.6 });
      const b = createAtom({
        ...base(), type: 'belief', slug: 'kintsugi', body: 'Repair reveals beauty.',
        confidence: 0.7,
        relations: [{ target: a.frontmatter.id, type: 'extends' }],
      });
      createAtom({
        ...base(), type: 'belief', slug: 'notation', body: 'Writing is discovery.',
        confidence: 0.7,
        relations: [{ target: b.frontmatter.id, type: 'extends' }],
      });

      const output = renderClaudeMd(testDir);
      expect(output).toContain('## Beliefs (developmental arcs)');
      expect(output).toContain('### Arc:');
      expect(output).toContain('ma-intervals');
      expect(output).toContain('notation');
      expect(output).toContain('\u2192 **'); // arrow before child
      expect(output).toContain('Silence between notes matters.');
      expect(output).toContain('Repair reveals beauty.');
      expect(output).toContain('Writing is discovery.');
    });

    it('renders standalone beliefs separately from arcs', () => {
      const a = createAtom({ ...base(), type: 'belief', slug: 'root-idea', body: 'Root idea.' });
      createAtom({
        ...base(), type: 'belief', slug: 'child-idea', body: 'Child idea.',
        relations: [{ target: a.frontmatter.id, type: 'extends' }],
      });
      createAtom({ ...base(), type: 'belief', slug: 'lone-wolf', body: 'Standalone belief.' });

      const output = renderClaudeMd(testDir);
      expect(output).toContain('## Beliefs (developmental arcs)');
      expect(output).toContain('### Arc:');
      expect(output).toContain('### Standalone beliefs');
      expect(output).toContain('Standalone belief.');
    });

    it('belief extending non-belief shows as standalone', () => {
      const decision = createAtom({ ...base(), type: 'decision', slug: 'use-sql', body: 'Use SQL.' });
      createAtom({
        ...base(), type: 'belief', slug: 'sql-fast', body: 'SQL is fast enough.',
        relations: [{ target: decision.frontmatter.id, type: 'extends' }],
      });

      const output = renderClaudeMd(testDir);
      // Belief renders, but decision does not appear in beliefs section
      expect(output).toContain('SQL is fast enough.');
      // Single belief extending non-belief => standalone (arc needs ≥2 belief nodes)
      expect(output).toContain('## Beliefs (unverified)');
      expect(output).not.toContain('## Beliefs (developmental arcs)');
    });

    it('all beliefs standalone when no extends relations', () => {
      createAtom({ ...base(), type: 'belief', slug: 'idea-one', body: 'First idea.' });
      createAtom({ ...base(), type: 'belief', slug: 'idea-two', body: 'Second idea.' });

      const output = renderClaudeMd(testDir);
      expect(output).toContain('## Beliefs (unverified)');
      expect(output).not.toContain('## Beliefs (developmental arcs)');
      expect(output).toContain('First idea.');
      expect(output).toContain('Second idea.');
    });

    it('arc header shows correct node count', () => {
      const a = createAtom({ ...base(), type: 'belief', slug: 'step-one', body: 'Step 1.' });
      const b = createAtom({
        ...base(), type: 'belief', slug: 'step-two', body: 'Step 2.',
        relations: [{ target: a.frontmatter.id, type: 'extends' }],
      });
      createAtom({
        ...base(), type: 'belief', slug: 'step-three', body: 'Step 3.',
        relations: [{ target: b.frontmatter.id, type: 'extends' }],
      });

      const output = renderClaudeMd(testDir);
      expect(output).toContain('3 nodes');
    });

    it('arc children sorted chronologically', () => {
      const parent = createAtom({ ...base(), type: 'belief', slug: 'parent', body: 'Parent.' });
      // Create child-b first, child-a second — but child-a should still come after child-b
      // since createAtom auto-generates timestamps in order
      createAtom({
        ...base(), type: 'belief', slug: 'child-b', body: 'Child B.',
        relations: [{ target: parent.frontmatter.id, type: 'extends' }],
      });
      createAtom({
        ...base(), type: 'belief', slug: 'child-a', body: 'Child A.',
        relations: [{ target: parent.frontmatter.id, type: 'extends' }],
      });

      const output = renderClaudeMd(testDir);
      const posB = output.indexOf('Child B.');
      const posA = output.indexOf('Child A.');
      expect(posB).toBeGreaterThan(-1);
      expect(posA).toBeGreaterThan(-1);
      // B was created first, so B appears before A
      expect(posB).toBeLessThan(posA);
    });

    it('single-node arc candidate does not vanish when coexisting with valid arcs', () => {
      // Valid 2-node arc
      const arcRoot = createAtom({ ...base(), type: 'belief', slug: 'arc-root', body: 'Arc root.' });
      createAtom({
        ...base(), type: 'belief', slug: 'arc-child', body: 'Arc child.',
        relations: [{ target: arcRoot.frontmatter.id, type: 'extends' }],
      });
      // Belief extending a non-belief — single-node candidate, must appear in standalone
      const decision = createAtom({ ...base(), type: 'decision', slug: 'some-dec', body: 'A decision.' });
      createAtom({
        ...base(), type: 'belief', slug: 'orphan-belief', body: 'Orphan extending decision.',
        relations: [{ target: decision.frontmatter.id, type: 'extends' }],
      });

      const output = renderClaudeMd(testDir);
      expect(output).toContain('## Beliefs (developmental arcs)');
      expect(output).toContain('Arc root.');
      expect(output).toContain('Arc child.');
      // The orphan belief must NOT vanish — it should appear in standalone
      expect(output).toContain('### Standalone beliefs');
      expect(output).toContain('Orphan extending decision.');
    });

    it('cycle in extends does not hang', () => {
      // Create two beliefs, then manually add cyclic relations via the index
      const a = createAtom({ ...base(), type: 'belief', slug: 'cycle-a', body: 'Cycle A.' });
      const b = createAtom({
        ...base(), type: 'belief', slug: 'cycle-b', body: 'Cycle B.',
        relations: [{ target: a.frontmatter.id, type: 'extends' }],
      });
      // Add reverse edge to create cycle
      addRelation(testDir, a.frontmatter.id, b.frontmatter.id, 'extends');

      // Should return without hanging
      const output = renderClaudeMd(testDir);
      expect(output).toContain('Cycle A.');
      expect(output).toContain('Cycle B.');
    });
  });

  describe('fill mode type reservations', () => {
    it('does NOT produce a belief monoculture when many beliefs would otherwise dominate the budget', () => {
      // Reproduce the Mai / Taj scenario from issue #154 at realistic scale:
      // belief corpus exceeds budget, so a naive recency fill picks all beliefs
      // and starves facts. With reservations wired in, at least one fact must
      // appear regardless of belief volume.
      //
      // Freeze time so every atom shares the same updated_at — without this
      // the test is flaky: a slow loop spans seconds, splitting atoms into
      // recency tiers and lets some facts slip through under the old greedy
      // fill. Pinning the clock makes the bug manifestation deterministic.
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-18T00:00:00Z'));
      for (let i = 0; i < 100; i++) {
        createAtom({ ...base(), type: 'belief', slug: `b${i}`,
          body: `Belief ${i} ${'x'.repeat(400)}` });
      }
      for (let i = 0; i < 10; i++) {
        createAtom({ ...base(), type: 'fact', slug: `f${i}`,
          body: `Fact ${i} ${'y'.repeat(100)}` });
      }

      // Why these numbers:
      //   DEFAULT_FILL_TYPE_RESERVATIONS sums to 8000 raw tokens.
      //   Budget 4000 → MAX_RESERVATION_RATIO * 4000 = 1200 token reservation cap.
      //   scale = 1200 / 8000 = 0.15
      //   fact reservation: 1200 * 0.15 = 180 tokens → fits ~one 50-token fact.
      //   belief reservation: 4000 * 0.15 = 600 tokens of beliefs guaranteed.
      //   Remaining 3800 budget filled by recency from unreserved beliefs.
      // If DEFAULT_FILL_TYPE_RESERVATIONS sums change, this math drifts —
      // bump the budget or atom counts to keep the assertion meaningful.
      //
      // Budget 4000 tokens. All atoms share a second-resolution updated_at
      // so the stable sort by recency preserves file order — BELI-* files
      // sort before FACT-* files. The OLD greedy fill walks beliefs first
      // and exhausts the 4000-token budget after ~31 beliefs, never
      // reaching any fact (asymmetric body sizes — small facts, big beliefs —
      // make this even more pronounced). The new reservation logic carves a
      // fact-quota slice (~180 tokens scaled, easily fits a small fact)
      // so at least one fact must appear.
      const output = renderClaudeMd(testDir, { maxTokens: 4000 });

      expect(output).toContain('## Key Facts');
      expect(output).toMatch(/## Beliefs/);
    }, 15000);

    it('explicit typeReservations option is plumbed through to renderFill', () => {
      // Two ~165-token atoms, budget 600 tokens — only ~3 atoms fit by greedy
      // count, but the file-order/recency mechanics put BELI-* before FACT-*
      // so a naive fill would take both beliefs before reaching the facts.
      // An explicit fact reservation flips that — facts get a guaranteed slot.
      createAtom({ ...base(), type: 'fact', slug: 'f1', body: `Fact body ${'y'.repeat(400)}` });
      createAtom({ ...base(), type: 'belief', slug: 'b1', body: `Belief body ${'x'.repeat(400)}` });

      // Override: a single explicit fact reservation. 30% of 600 = 180 cap;
      // scaled fact slot = 180 tokens, comfortably fits one fact atom.
      const withOverride = renderClaudeMd(testDir, {
        maxTokens: 600,
        typeReservations: { fact: 600 },
      });
      expect(withOverride).toContain('## Key Facts');
    });

    it('explicit empty typeReservations object falls back to defaults', () => {
      // Same monoculture shape as the first test, but pass `typeReservations: {}`
      // explicitly. This must behave identically to leaving it undefined —
      // empty object means "fall back to DEFAULT_FILL_TYPE_RESERVATIONS",
      // not "no reservations at all".
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-18T00:00:00Z'));
      for (let i = 0; i < 100; i++) {
        createAtom({ ...base(), type: 'belief', slug: `b${i}`,
          body: `Belief ${i} ${'x'.repeat(400)}` });
      }
      for (let i = 0; i < 10; i++) {
        createAtom({ ...base(), type: 'fact', slug: `f${i}`,
          body: `Fact ${i} ${'y'.repeat(100)}` });
      }

      const output = renderClaudeMd(testDir, { maxTokens: 4000, typeReservations: {} });

      expect(output).toContain('## Key Facts');
    }, 15000);

    it('--no-fill (task recall path) is unaffected by fill type_reservations', () => {
      // Sanity check: task-driven recall still uses recall.ts reservations,
      // not the new fill defaults. With no query and fill=false, recall
      // returns 0 atoms — known footgun documented in render.ts. Just
      // assert the call doesn't crash and the typeReservations option is
      // not somehow leaking into the task-recall code path.
      createAtom({ ...base(), type: 'fact', slug: 'f1', body: 'a fact' });
      const output = renderClaudeMd(testDir, {
        fill: false,
        typeReservations: { fact: 999999 },
      });
      expect(output).toContain('# Memory');
    });

    it('monoculture warning is silent on a multi-type store with belief arcs', () => {
      // Realistic Mai/Taj shape at scale: belief corpus exceeds budget so the
      // pre-fix recency fill starves other types. Add a 3-node belief arc to
      // exercise Task 1's **ID** bullet parser path (parseRenderStats counts
      // arc-rendered belief atoms).
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-18T12:00:00Z'));

      // Why these numbers:
      //   80 beliefs at ~410 chars (~100 tokens each) ≈ 8000 tokens of beliefs.
      //   22 facts + 3 procedures + 2 preferences at ~110 chars (~30 tokens each)
      //   ≈ 800 tokens of non-belief content.
      //   Total corpus ≈ 8800 tokens — well over the 4000-token budget.
      //   Pre-fix: recency fill packs ~40 beliefs and zero facts → monoculture warning.
      //   Post-fix: per-type reservations carve out slots for facts/procedures/
      //   preferences while beliefs still dominate by volume.
      //   Arc atoms (3 nodes via `extends`) make the parser see **ID** bullets,
      //   exercising the Task-1 fix.
      for (let i = 0; i < 80; i++) {
        createAtom({ ...base(), type: 'belief', slug: `b${i}`,
          body: `Belief ${i} ${'x'.repeat(400)}` });
      }
      // 3-node belief arc — Task 1 fixed parseRenderStats to count these.
      const arcRoot = createAtom({ ...base(), type: 'belief', slug: 'arc-root',
        body: `Arc root ${'a'.repeat(400)}` });
      const arcMid = createAtom({ ...base(), type: 'belief', slug: 'arc-mid',
        body: `Arc mid ${'a'.repeat(400)}`,
        relations: [{ target: arcRoot.frontmatter.id, type: 'extends' }] });
      createAtom({ ...base(), type: 'belief', slug: 'arc-leaf',
        body: `Arc leaf ${'a'.repeat(400)}`,
        relations: [{ target: arcMid.frontmatter.id, type: 'extends' }] });

      for (let i = 0; i < 22; i++) {
        createAtom({ ...base(), type: 'fact', slug: `f${i}`,
          body: `Fact ${i} ${'y'.repeat(100)}` });
      }
      for (let i = 0; i < 3; i++) {
        createAtom({ ...base(), type: 'procedure', slug: `p${i}`,
          body: `Procedure ${i} ${'p'.repeat(100)}` });
      }
      for (let i = 0; i < 2; i++) {
        createAtom({ ...base(), type: 'preference', slug: `pref${i}`,
          body: `Preference ${i} ${'r'.repeat(100)}` });
      }

      const content = renderClaudeMd(testDir, { maxTokens: 4000 });
      const stats = parseRenderStats(content);
      const warning = degenerateOutputWarning(stats);

      // Multi-section render → warning is silent.
      // (bySection.length > 1 is implied by warning === null at this scale,
      // since degenerateOutputWarning fires on single-section ≥5-atom output.)
      expect(warning).toBeNull();
      // Task-1-sensitive: the arc-bulleted beliefs that survive the budget
      // must be counted under "Beliefs (developmental arcs)". With the
      // pre-Task-1 parser this bucket would be 0 and dropped by the empty-
      // bucket prune, leaving the assertion below to fail. With the
      // Task-1 fix in place, **ID** bullets are counted and the bucket
      // survives.
      const beliefArcCount = stats.bySection['Beliefs (developmental arcs)'] ?? 0;
      expect(beliefArcCount).toBeGreaterThan(0);
      // Sanity: facts survived the budget.
      expect(content).toContain('## Key Facts');
    }, 15000);
  });
});
