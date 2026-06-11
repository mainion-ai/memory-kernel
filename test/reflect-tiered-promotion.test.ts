/**
 * #274 Gap 2 — tiered draft promotion in `reflect`.
 *
 * Replaces the old `belief → fact @ confidence 0.9` auto-promote (which did the
 * opposite of the monoculture-fix intent) with type-tiered rules:
 *   - fact / preference / decision: draft → active after 48h if confidence ≥ 0.7
 *     AND no reflect-flagged contradiction with an existing active atom.
 *   - belief: held in draft (overproduced + re-extraction drift; review-gated).
 *   - procedure: held in draft (interim — "executed-once" signal is a sub-task).
 *   - open_question: promoted immediately (additive, no quality risk).
 * Promotion is status-only (type unchanged) — no file rename.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  initMemoryDir, createAtom, reflect, listAtoms, readAtom, closeAllIndexes,
} from '../src/index.js';
import { writeAtom, atomFilePath } from '../src/store.js';
import { readEvents } from '../src/event-log.js';
import type { AtomType, AtomStatus } from '../src/types.js';

let testDir: string;

function base() {
  return { memoryDir: testDir, agent_id: 'a', session_id: 's' };
}

function reflectOnce() {
  return reflect({ memoryDir: testDir, agent_id: 'a', session_id: 's' });
}

const HOUR = 60 * 60 * 1000;

/**
 * Create an atom, then backdate its created_at by `ageHours` (createAtom always
 * stamps now). status defaults to 'draft'. Returns the atom's id.
 */
function seedDraft(opts: {
  type: AtomType; slug: string; body: string; confidence: number;
  ageHours?: number; status?: AtomStatus; paths?: string[];
}): string {
  const atom = createAtom({
    ...base(), type: opts.type, slug: opts.slug, body: opts.body,
    confidence: opts.confidence, status: opts.status ?? 'draft',
    ttl_days: null,
    ...(opts.paths ? { scope: { paths: opts.paths } } : {}),
  });
  if (opts.ageHours && opts.ageHours > 0) {
    const old = new Date(Date.now() - opts.ageHours * HOUR).toISOString().replace(/\.\d{3}Z$/, 'Z');
    atom.frontmatter.created_at = old;
    atom.frontmatter.updated_at = old;
    writeAtom(atom, atomFilePath(testDir, atom.frontmatter.id, atom.frontmatter.type));
  }
  return atom.frontmatter.id;
}

function statusOf(id: string): string | undefined {
  return listAtoms(testDir).find((a) => a.frontmatter.id === id)?.frontmatter.status;
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-tiered-promote-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('#274 Gap 2 — age-gated types (fact/preference/decision)', () => {
  it('promotes a fact draft that is ≥48h old with confidence ≥ 0.7', () => {
    const id = seedDraft({ type: 'fact', slug: 'old-fact', body: 'A settled fact.', confidence: 0.7, ageHours: 49 });
    const r = reflectOnce();
    expect(r.promoted).toBe(1);
    expect(statusOf(id)).toBe('active');
  });

  it('promotes preference and decision drafts under the same gate', () => {
    seedDraft({ type: 'preference', slug: 'pref', body: 'Prefers X over Y.', confidence: 0.8, ageHours: 49 });
    seedDraft({ type: 'decision', slug: 'dec', body: 'Chose A because B.', confidence: 0.8, ageHours: 49 });
    const r = reflectOnce();
    expect(r.promoted).toBe(2);
  });

  it('holds a fresh (<48h) draft', () => {
    const id = seedDraft({ type: 'fact', slug: 'fresh', body: 'Just extracted.', confidence: 0.9, ageHours: 1 });
    const r = reflectOnce();
    expect(r.promoted).toBe(0);
    expect(statusOf(id)).toBe('draft');
  });

  it('holds a low-confidence draft (< 0.7) even when old enough', () => {
    const id = seedDraft({ type: 'fact', slug: 'lowconf', body: 'Uncertain claim.', confidence: 0.6, ageHours: 72 });
    const r = reflectOnce();
    expect(r.promoted).toBe(0);
    expect(statusOf(id)).toBe('draft');
  });

  it('holds a draft that contradicts an existing active atom (same type+scope, conf gap > 0.3)', () => {
    createAtom({ ...base(), type: 'fact', slug: 'active-strong', body: 'The cache TTL is 60s.', confidence: 0.95, status: 'active', scope: { paths: ['src/cache'] } });
    const id = seedDraft({ type: 'fact', slug: 'draft-weak', body: 'The cache TTL is 300s.', confidence: 0.5, ageHours: 72, paths: ['src/cache'] });
    const r = reflectOnce();
    expect(r.promoted).toBe(0);
    expect(statusOf(id)).toBe('draft');
  });

  it('promotion is status-only — type is NOT changed (no belief→fact rename)', () => {
    const id = seedDraft({ type: 'fact', slug: 'stays-fact', body: 'Stays a fact.', confidence: 0.8, ageHours: 49 });
    reflectOnce();
    const atom = listAtoms(testDir).find((a) => a.frontmatter.id === id);
    expect(atom?.frontmatter.type).toBe('fact');
    expect(atom?.frontmatter.status).toBe('active');
  });
});

describe('#274 Gap 2 — held types (belief, procedure)', () => {
  it('does NOT auto-promote a high-confidence belief (old belief→fact@0.9 rule removed)', () => {
    const id = seedDraft({ type: 'belief', slug: 'strong-belief', body: 'A confident belief.', confidence: 0.95, ageHours: 72 });
    const r = reflectOnce();
    expect(r.promoted).toBe(0);
    expect(statusOf(id)).toBe('draft');
    expect(listAtoms(testDir).find((a) => a.frontmatter.id === id)?.frontmatter.type).toBe('belief');
  });

  it('holds a procedure draft (interim — executed-once signal not yet implemented)', () => {
    const id = seedDraft({ type: 'procedure', slug: 'proc', body: 'Steps to do X.', confidence: 0.9, ageHours: 72 });
    const r = reflectOnce();
    expect(r.promoted).toBe(0);
    expect(statusOf(id)).toBe('draft');
  });
});

describe('#274 Gap 2 — auto-extracted tag', () => {
  it('strips the auto-extracted tag on promotion (matches consolidate)', () => {
    const atom = createAtom({
      ...base(), type: 'fact', slug: 'extracted', body: 'An extracted, settled fact.',
      confidence: 0.8, status: 'draft', ttl_days: null,
      scope: { tags: ['auto-extracted', 'topic:x'] },
    });
    const old = new Date(Date.now() - 49 * HOUR).toISOString().replace(/\.\d{3}Z$/, 'Z');
    atom.frontmatter.created_at = old;
    atom.frontmatter.updated_at = old;
    writeAtom(atom, atomFilePath(testDir, atom.frontmatter.id, atom.frontmatter.type));

    const r = reflectOnce();
    expect(r.promoted).toBe(1);

    const promoted = readAtom(atomFilePath(testDir, atom.frontmatter.id, 'fact'));
    expect(promoted.frontmatter.status).toBe('active');
    expect(promoted.frontmatter.scope?.tags ?? []).not.toContain('auto-extracted');
    expect(promoted.frontmatter.scope?.tags ?? []).toContain('topic:x'); // other tags kept
  });
});

describe('#274 Gap 2 — open_question (immediate)', () => {
  it('promotes an open_question draft immediately, regardless of age/confidence', () => {
    const id = seedDraft({ type: 'open_question', slug: 'oq', body: 'Should we do X?', confidence: 0.3, ageHours: 0 });
    const r = reflectOnce();
    expect(r.promoted).toBe(1);
    expect(statusOf(id)).toBe('active');
  });
});

describe('#274 Gap 2 — promotion event', () => {
  it('emits an atom_promoted event with status (not type) transition', () => {
    seedDraft({ type: 'fact', slug: 'evt', body: 'Promotable fact.', confidence: 0.8, ageHours: 49 });
    reflectOnce();
    const events = readEvents(testDir).filter((e) => e.action === 'atom_promoted');
    expect(events.length).toBe(1);
    expect(events[0].meta).toMatchObject({ from_status: 'draft', to_status: 'active' });
  });
});
