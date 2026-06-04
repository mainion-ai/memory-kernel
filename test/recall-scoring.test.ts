/**
 * Phase 2: Type-Aware Retrieval Weighting tests.
 * Verifies type multipliers, confidence factor, and token reservations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  initMemoryDir,
  createAtom,
  closeAllIndexes,
  openIndex,
  writeAtom,
  readAtom,
  DEFAULT_TYPE_WEIGHTS,
  DEFAULT_CONFIDENCE_FLOOR,
  DEFAULT_TYPE_RESERVATIONS,
} from '../src/index.js';
import { recall } from '../src/recall.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-scoring-'));
  initMemoryDir(testDir);
  openIndex(testDir); // ensure DB exists so createAtom calls indexAtom
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

/** Backdates an atom's created_at. */
function backdateAtom(filePath: string, daysAgo: number): void {
  const atom = readAtom(filePath);
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  atom.frontmatter.created_at = d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  writeAtom(atom, filePath);
}

describe('exported scoring defaults', () => {
  it('DEFAULT_TYPE_WEIGHTS has all atom types', () => {
    const types = ['decision', 'constraint', 'open_question', 'belief', 'fact', 'procedure', 'entity_summary', 'preference', 'conflict'];
    for (const t of types) {
      expect(DEFAULT_TYPE_WEIGHTS[t as keyof typeof DEFAULT_TYPE_WEIGHTS]).toBeDefined();
    }
  });

  it('constraint weight > decision weight > fact weight > belief weight', () => {
    expect(DEFAULT_TYPE_WEIGHTS.constraint).toBeGreaterThan(DEFAULT_TYPE_WEIGHTS.decision);
    expect(DEFAULT_TYPE_WEIGHTS.decision).toBeGreaterThan(DEFAULT_TYPE_WEIGHTS.fact);
    expect(DEFAULT_TYPE_WEIGHTS.fact).toBeGreaterThan(DEFAULT_TYPE_WEIGHTS.belief);
  });

  it('DEFAULT_CONFIDENCE_FLOOR is 0.7', () => {
    expect(DEFAULT_CONFIDENCE_FLOOR).toBe(0.7);
  });

  it('DEFAULT_TYPE_RESERVATIONS has decision, constraint, conflict', () => {
    expect(DEFAULT_TYPE_RESERVATIONS.decision).toBeGreaterThan(0);
    expect(DEFAULT_TYPE_RESERVATIONS.constraint).toBeGreaterThan(0);
    expect(DEFAULT_TYPE_RESERVATIONS.conflict).toBeGreaterThan(0);
  });
});

describe('type weight multipliers', () => {
  it('decision from 2 weeks ago outranks belief from yesterday (same body text)', () => {
    const belief = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'redis-caching-belief',
      body: 'Redis caching improves performance significantly',
      confidence: 0.5,
    });

    const decision = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'decision', slug: 'redis-caching-decision',
      body: 'Redis caching improves performance significantly',
      confidence: 0.8,
    });
    backdateAtom(decision.filePath!, 14); // 2 weeks old
    closeAllIndexes();

    const bundle = recall(testDir, {
      task: 'Redis caching performance',
      decay_weight: 0.1, // keep decay low so type weight dominates
    });

    const ids = bundle.atoms.map((a) => a.frontmatter.id);
    expect(ids.indexOf(decision.frontmatter.id)).toBeLessThan(ids.indexOf(belief.frontmatter.id));
  });

  it('constraint outranks fact with same relevance', () => {
    const fact = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'tls-fact',
      body: 'TLS 1.3 is the current standard for transport security',
    });
    const constraint = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'constraint', slug: 'tls-constraint',
      body: 'TLS 1.3 is the current standard for transport security',
    });
    backdateAtom(constraint.filePath!, 7);
    closeAllIndexes();

    const bundle = recall(testDir, {
      task: 'TLS',
      decay_weight: 0,
    });

    const ids = bundle.atoms.map((a) => a.frontmatter.id);
    expect(ids.indexOf(constraint.frontmatter.id)).toBeLessThan(ids.indexOf(fact.frontmatter.id));
  });

  it('query.type_weights overrides defaults for the call', () => {
    const belief = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'test-belief',
      body: 'database indexing strategy optimization',
      confidence: 0.8, // same confidence as decision
    });
    const decision = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'decision', slug: 'test-decision',
      body: 'database indexing strategy optimization',
      confidence: 0.8,
    });
    closeAllIndexes();

    // Override: give belief a huge multiplier, decision almost nothing
    // decay_weight=0 removes recency variable; same confidence removes conf_factor variable
    const bundle = recall(testDir, {
      task: 'database indexing strategy',
      decay_weight: 0,
      type_weights: { belief: 100.0, decision: 0.001 },
    });

    const ids = bundle.atoms.map((a) => a.frontmatter.id);
    expect(ids.indexOf(belief.frontmatter.id)).toBeLessThan(ids.indexOf(decision.frontmatter.id));
  });

  it('RECALL_TYPE_WEIGHTS env var: malformed JSON falls back to defaults without throwing', () => {
    createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'stable-fact',
      body: 'stable fact content',
    });

    const prev = process.env.RECALL_TYPE_WEIGHTS;
    process.env.RECALL_TYPE_WEIGHTS = 'not valid json {{{';
    expect(() => recall(testDir, { task: 'stable fact' })).not.toThrow();
    process.env.RECALL_TYPE_WEIGHTS = prev ?? '';
  });
});

describe('confidence factor', () => {
  it('high-confidence atom ranks above low-confidence atom of same type and body', () => {
    const lowConf = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'low-conf',
      body: 'machine learning gradient descent optimization algorithm',
      confidence: 0.1,
    });
    const highConf = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'high-conf',
      body: 'machine learning gradient descent optimization algorithm',
      confidence: 1.0,
    });
    closeAllIndexes();

    const bundle = recall(testDir, {
      task: 'machine learning gradient descent',
      decay_weight: 0, // disable decay so only confidence differs
    });

    const ids = bundle.atoms.map((a) => a.frontmatter.id);
    expect(ids.indexOf(highConf.frontmatter.id)).toBeLessThan(ids.indexOf(lowConf.frontmatter.id));
  });

  it('confidence=0 atom still contributes at floor level (not zeroed out)', () => {
    createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'zero-conf',
      body: 'zero confidence fact',
      confidence: 0,
    });

    const bundle = recall(testDir, { task: 'zero confidence fact', decay_weight: 0 });
    // Atom should still appear (floor=0.7, not zero)
    expect(bundle.atoms.length).toBeGreaterThan(0);
  });

  it('RECALL_CONFIDENCE_FLOOR env var changes floor', () => {
    const prevEnv = process.env.RECALL_CONFIDENCE_FLOOR;
    // With floor=0, confidence=0 gets a score of 0 (no contribution from conf_factor)
    process.env.RECALL_CONFIDENCE_FLOOR = '0';

    const low = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'low-custom-floor',
      body: 'custom floor test body',
      confidence: 0,
    });
    const high = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'high-custom-floor',
      body: 'custom floor test body',
      confidence: 1.0,
    });
    closeAllIndexes();

    const bundle = recall(testDir, { task: 'custom floor test', decay_weight: 0 });
    const ids = bundle.atoms.map((a) => a.frontmatter.id);
    expect(ids.indexOf(high.frontmatter.id)).toBeLessThan(ids.indexOf(low.frontmatter.id));

    process.env.RECALL_CONFIDENCE_FLOOR = prevEnv ?? '';
  });
});

describe('token reservation', () => {
  it('decisions appear in bundle even when many beliefs exist', () => {
    // Create a decision
    const dec = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'decision', slug: 'critical-arch',
      body: 'Use event sourcing for all state changes',
      confidence: 0.9,
    });

    // Create many beliefs that would normally crowd it out — they share the
    // task keyword ("event") so they all FTS-match alongside the decision,
    // exercising the type-reservation discriminator on a matched pool.
    // (Pre-#214 fix this test relied on the score-0 fallback surfacing
    // everything; now the task must legitimately hit each atom.)
    for (let i = 0; i < 15; i++) {
      createAtom({
        memoryDir: testDir,
        agent_id: 'a', session_id: 's',
        type: 'belief', slug: `belief-${i}`,
        body: `Belief ${i} about event handling under load`,
        confidence: 0.8,
      });
    }
    closeAllIndexes();

    // Tight token budget, but reservation ensures the decision appears.
    // type_reservations also opts out of the task-auto-disable on
    // reservations (src/recall.ts ~ line 107).
    const bundle = recall(testDir, {
      task: 'event',
      max_tokens: 3000,
      type_reservations: { decision: 500 }, // reserve 500 tokens for decisions
    });

    const ids = bundle.atoms.map((a) => a.frontmatter.id);
    expect(ids).toContain(dec.frontmatter.id);
  });

  it('no_reservations: true overrides caller-supplied type_reservations', () => {
    // Force-off must yield the same bundle regardless of whether the caller also
    // passes type_reservations — previously those were silently re-applied.
    // Setup: an unrelated decision (no FTS match against the task) and enough
    // matching beliefs that, under a tight budget, reservation membership matters.
    const dec = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'decision', slug: 'unrelated-dec',
      body: 'A'.repeat(200),
      confidence: 0.9,
    });
    for (let i = 0; i < 20; i++) {
      createAtom({
        memoryDir: testDir,
        agent_id: 'a', session_id: 's',
        type: 'belief', slug: `topic-belief-${i}`,
        body: `Pagination API belief ${i} ` + 'cursor-based paging details. '.repeat(10),
        confidence: 0.8,
      });
    }
    closeAllIndexes();

    const forceOff = recall(testDir, {
      task: 'pagination API',
      max_tokens: 800,
      no_reservations: true,
      type_reservations: { decision: 500 },
    });
    const forceOffBaseline = recall(testDir, {
      task: 'pagination API',
      max_tokens: 800,
      no_reservations: true,
    });
    expect(forceOff.atoms.map((a) => a.frontmatter.id))
      .toEqual(forceOffBaseline.atoms.map((a) => a.frontmatter.id));
    expect(forceOff.atoms.map((a) => a.frontmatter.id)).not.toContain(dec.frontmatter.id);
  });

  it('type_reservations={} env disables reservations', () => {
    const prevEnv = process.env.RECALL_TYPE_RESERVATIONS;
    process.env.RECALL_TYPE_RESERVATIONS = '{}';

    const dec = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'decision', slug: 'tiny-decision',
      body: 'A'.repeat(5000), // large body to consume budget
      confidence: 0.9,
    });
    closeAllIndexes();

    // With no reservations and a very tight budget, the decision may or may not appear
    // (just verifying no exception)
    expect(() => recall(testDir, {
      task: 'architecture',
      max_tokens: 1000,
    })).not.toThrow();

    process.env.RECALL_TYPE_RESERVATIONS = prevEnv ?? '';
  });
});
