/**
 * Memory Kernel — integration tests.
 * Tests the full lifecycle: init → retain → recall → reflect.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  initMemoryDir,
  createAtom,
  recall,
  reflect,
  readEvents,
  listAtoms,
  readView,
  validateAtomFrontmatter,
  parseAtom,
  serializeAtom,
  normalizeTimestamp,
  countEvents,
} from '../src/index.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-test-'));
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('initMemoryDir', () => {
  it('creates canonical directory layout', () => {
    initMemoryDir(testDir);

    expect(fs.existsSync(path.join(testDir, 'INDEX.md'))).toBe(true);
    expect(fs.existsSync(path.join(testDir, 'HANDOFF.md'))).toBe(true);
    expect(fs.existsSync(path.join(testDir, 'DECISIONS.md'))).toBe(true);
    expect(fs.existsSync(path.join(testDir, 'CONSTRAINTS.md'))).toBe(true);
    expect(fs.existsSync(path.join(testDir, 'OPEN_QUESTIONS.md'))).toBe(true);
    expect(fs.existsSync(path.join(testDir, 'ENTITIES'))).toBe(true);
    expect(fs.existsSync(path.join(testDir, 'EPISODES'))).toBe(true);
    expect(fs.existsSync(path.join(testDir, 'EVIDENCE'))).toBe(true);
    expect(fs.existsSync(path.join(testDir, 'CONFLICTS'))).toBe(true);
    expect(fs.existsSync(path.join(testDir, 'ARCHIVE'))).toBe(true);
    expect(fs.existsSync(path.join(testDir, 'events.ndjson'))).toBe(true);
  });

  it('is idempotent — running twice does not overwrite', () => {
    initMemoryDir(testDir);
    const indexBefore = fs.readFileSync(path.join(testDir, 'INDEX.md'), 'utf-8');
    initMemoryDir(testDir);
    const indexAfter = fs.readFileSync(path.join(testDir, 'INDEX.md'), 'utf-8');
    expect(indexBefore).toBe(indexAfter);
  });
});

describe('createAtom', () => {
  it('creates an atom file with valid frontmatter', () => {
    initMemoryDir(testDir);
    const atom = createAtom({
      memoryDir: testDir,
      agent_id: 'test-agent',
      session_id: 'test-session',
      type: 'decision',
      slug: 'use-typescript',
      body: '## Decision\nWe will use TypeScript.\n\n## Why\nType safety.',
    });

    expect(atom.frontmatter.id).toMatch(/^DECI-\d{4}-\d{2}-\d{2}-USE-TYPESCRIPT-[a-z0-9]+$/);
    expect(atom.frontmatter.type).toBe('decision');
    expect(atom.frontmatter.status).toBe('active');
    expect(atom.filePath).toBeTruthy();
    expect(fs.existsSync(atom.filePath!)).toBe(true);

    // Validate frontmatter
    const result = validateAtomFrontmatter(atom.frontmatter);
    expect(result.success).toBe(true);
  });

  it('emits an event on create', () => {
    initMemoryDir(testDir);
    createAtom({
      memoryDir: testDir,
      agent_id: 'test-agent',
      session_id: 'test-session',
      type: 'fact',
      slug: 'pi-is-rpi5',
      body: 'The hardware is a Raspberry Pi 5.',
    });

    const events = readEvents(testDir);
    expect(events.length).toBe(1);
    expect(events[0].action).toBe('atom_created');
  });

  it('beliefs default to draft status with 0.5 confidence', () => {
    initMemoryDir(testDir);
    const atom = createAtom({
      memoryDir: testDir,
      agent_id: 'test-agent',
      session_id: 'test-session',
      type: 'belief',
      slug: 'typescript-is-better',
      body: 'TypeScript might be better than JavaScript for this project.',
    });

    expect(atom.frontmatter.status).toBe('draft');
    expect(atom.frontmatter.confidence).toBe(0.5);
    expect(atom.frontmatter.ttl_days).toBeNull();
  });
});

describe('serializeAtom + parseAtom roundtrip', () => {
  it('roundtrips correctly', () => {
    initMemoryDir(testDir);
    const atom = createAtom({
      memoryDir: testDir,
      agent_id: 'test-agent',
      session_id: 'test-session',
      type: 'constraint',
      slug: 'max-200-lines-index',
      body: '## Constraint\nINDEX.md must be under 200 lines.',
    });

    const serialized = serializeAtom(atom);
    const parsed = parseAtom(serialized);

    expect(parsed.frontmatter.id).toBe(atom.frontmatter.id);
    expect(parsed.frontmatter.type).toBe(atom.frontmatter.type);
    expect(parsed.body).toBe(atom.body);
  });
});

describe('recall', () => {
  it('returns core views even with no atoms', () => {
    initMemoryDir(testDir);
    const bundle = recall(testDir);

    expect(bundle.index).toContain('Memory Index');
    expect(bundle.handoff).toContain('Handoff');
    expect(bundle.constraints).toContain('Constraints');
    expect(bundle.atoms.length).toBe(0);
    expect(bundle.token_estimate).toBeGreaterThan(0);
  });

  it('returns relevant atoms filtered by type', () => {
    initMemoryDir(testDir);
    const base = { memoryDir: testDir, agent_id: 'a', session_id: 's' };

    createAtom({ ...base, type: 'decision', slug: 'dec-1', body: 'Decision 1' });
    createAtom({ ...base, type: 'fact', slug: 'fact-1', body: 'Fact 1' });
    createAtom({ ...base, type: 'belief', slug: 'belief-1', body: 'Belief 1' });

    const bundle = recall(testDir, { types: ['decision'] });
    expect(bundle.atoms.length).toBe(1);
    expect(bundle.atoms[0].frontmatter.type).toBe('decision');
  });

  it('excludes archived atoms', () => {
    initMemoryDir(testDir);
    const base = { memoryDir: testDir, agent_id: 'a', session_id: 's' };

    const atom = createAtom({ ...base, type: 'fact', slug: 'old-fact', body: 'Old' });

    // Manually archive it
    const parsed = parseAtom(fs.readFileSync(atom.filePath!, 'utf-8'));
    parsed.frontmatter.status = 'archived';
    fs.writeFileSync(atom.filePath!, serializeAtom(parsed));

    const bundle = recall(testDir);
    expect(bundle.atoms.length).toBe(0);
  });
});

describe('reflect', () => {
  it('regenerates INDEX.md with atom summaries', () => {
    initMemoryDir(testDir);
    const base = { memoryDir: testDir, agent_id: 'a', session_id: 's' };

    createAtom({ ...base, type: 'decision', slug: 'use-ndjson', body: 'Use NDJSON for events' });
    createAtom({ ...base, type: 'open_question', slug: 'which-crdt', body: 'Which CRDT library?' });

    const result = reflect({ memoryDir: testDir, agent_id: 'a', session_id: 's' });

    expect(result.events_emitted).toBeGreaterThan(0);

    const index = readView(testDir, 'INDEX.md');
    expect(index).toContain('Decisions (1)');
    expect(index).toContain('Open Questions (1)');
  });

  it('regenerates all 5 views', () => {
    initMemoryDir(testDir);
    const base = { memoryDir: testDir, agent_id: 'a', session_id: 's' };

    createAtom({ ...base, type: 'decision', slug: 'use-ts', body: 'Use TypeScript' });
    createAtom({ ...base, type: 'constraint', slug: 'max-lines', body: 'Max 200 lines' });
    createAtom({ ...base, type: 'open_question', slug: 'which-crdt', body: 'Which CRDT?' });

    reflect({ memoryDir: testDir, agent_id: 'a', session_id: 's' });

    // All views should exist and contain real content
    const index = readView(testDir, 'INDEX.md');
    expect(index).toContain('# Memory Index');
    expect(index).toContain('Decisions (1)');

    const decisions = readView(testDir, 'DECISIONS.md');
    expect(decisions).toContain('# Decisions');
    expect(decisions).toContain('USE-TS');

    const constraints = readView(testDir, 'CONSTRAINTS.md');
    expect(constraints).toContain('# Constraints');
    expect(constraints).toContain('MAX-LINES');

    const openQuestions = readView(testDir, 'OPEN_QUESTIONS.md');
    expect(openQuestions).toContain('# Open Questions');
    expect(openQuestions).toContain('WHICH-CRDT');

    const handoff = readView(testDir, 'HANDOFF.md');
    expect(handoff).toContain('# Handoff');
    expect(handoff).toContain('3 active atoms');
  });

  it('auto-promotes high-confidence beliefs to facts', () => {
    initMemoryDir(testDir);
    const base = { memoryDir: testDir, agent_id: 'a', session_id: 's' };

    const atom = createAtom({
      ...base,
      type: 'belief',
      slug: 'ts-is-good',
      body: 'TypeScript is good',
      confidence: 0.95,
    });

    reflect({ memoryDir: testDir, agent_id: 'a', session_id: 's' });

    // Re-read the atom
    const updated = parseAtom(fs.readFileSync(atom.filePath!, 'utf-8'));
    expect(updated.frontmatter.type).toBe('fact');
    expect(updated.frontmatter.status).toBe('active');
  });

  it('deduplicates identical atoms', () => {
    initMemoryDir(testDir);
    const base = { memoryDir: testDir, agent_id: 'a', session_id: 's' };

    createAtom({ ...base, type: 'fact', slug: 'same-thing-1', body: 'Identical content' });
    // Small delay to ensure different timestamp
    createAtom({ ...base, type: 'fact', slug: 'same-thing-2', body: 'Identical content' });

    const result = reflect({ memoryDir: testDir, agent_id: 'a', session_id: 's' });
    expect(result.deduped).toBe(1);

    // Only one should remain in ENTITIES
    const remaining = listAtoms(testDir);
    const active = remaining.filter((a) => a.frontmatter.status !== 'archived');
    expect(active.length).toBe(1);
  });
});

describe('normalizeTimestamp', () => {
  it('drops milliseconds', () => {
    const ts = normalizeTimestamp(new Date('2026-03-09T15:30:00.123Z'));
    expect(ts).toBe('2026-03-09T15:30:00Z');
  });
});

describe('event log', () => {
  it('tracks event count correctly', () => {
    initMemoryDir(testDir);
    const base = { memoryDir: testDir, agent_id: 'a', session_id: 's' };

    createAtom({ ...base, type: 'fact', slug: 'f1', body: 'Fact 1' });
    createAtom({ ...base, type: 'fact', slug: 'f2', body: 'Fact 2' });

    expect(countEvents(testDir)).toBe(2);
  });
});
