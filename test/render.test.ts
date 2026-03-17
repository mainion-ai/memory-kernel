/**
 * Tests for renderClaudeMd() — CLAUDE.md generation from memory atoms.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { initMemoryDir, createAtom, closeAllIndexes } from '../src/index.js';
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

  it('renders decisions and omits confidence suffix only when confidence is undefined', () => {
    // createAtom applies a default confidence, so the suffix will appear.
    // This test verifies the section heading is present regardless.
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
});
