/**
 * Tests for renderClaudeMd() — CLAUDE.md generation from memory atoms.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { initMemoryDir, createAtom, closeAllIndexes, openIndex } from '../src/index.js';
import { addRelation } from '../src/index-db.js';
import { renderClaudeMd } from '../src/render.js';

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
});
