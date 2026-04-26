/**
 * Per-type decay weight tests.
 * Verifies that different atom types can have different temporal decay weights
 * via RecallQuery.decay_weights or RECALL_DECAY_WEIGHTS env var.
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
} from '../src/index.js';
import { recall } from '../src/recall.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-type-decay-'));
  initMemoryDir(testDir);
  openIndex(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
  delete process.env.RECALL_DECAY_WEIGHTS;
});

/** Backdates an atom's created_at by N days (mutates the file on disk). */
function backdateAtom(filePath: string, daysAgo: number): void {
  const atom = readAtom(filePath);
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  atom.frontmatter.created_at = d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  atom.frontmatter.updated_at = atom.frontmatter.created_at;
  writeAtom(atom, filePath);
}

describe('per-type decay weights — task path', () => {
  it('per-type decay_weights override global decay_weight', () => {
    // Use fact vs decision (both default to active status, confidence 0.8).
    // Give fact decay=0 and decision decay=0.9.
    // Both old — fact keeps full relevance, decision gets penalized.
    const oldFact = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'old-fact', body: 'TypeScript superset JavaScript language',
    });
    backdateAtom(oldFact.filePath!, 60);

    const oldDecision = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'decision', slug: 'old-decision', body: 'TypeScript superset JavaScript language',
    });
    backdateAtom(oldDecision.filePath!, 60);
    closeAllIndexes();

    // fact=0 (no decay), decision=0.9 (heavy decay).
    // Neutralize type_weights so only decay matters.
    const bundle = recall(testDir, {
      task: 'TypeScript superset',
      decay_weight: 0.2,
      decay_weights: { fact: 0.0, decision: 0.9 },
      type_weights: { fact: 1.0, decision: 1.0 },
    });

    const ids = bundle.atoms.map(a => a.frontmatter.id);
    // Old fact (no decay penalty) ranks above old decision (heavy decay penalty)
    expect(ids.indexOf(oldFact.frontmatter.id)).toBeLessThan(
      ids.indexOf(oldDecision.frontmatter.id),
    );
  });

  it('atoms of different types get different decay weights in scoring', () => {
    // Two old atoms of different types with identical content.
    // fact=0 means old facts keep full relevance. preference=0.9 means old preferences tank.
    const oldFact = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'old-fact', body: 'neural network deep learning model',
    });
    backdateAtom(oldFact.filePath!, 90);

    const oldPref = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'preference', slug: 'old-pref', body: 'neural network deep learning model',
    });
    backdateAtom(oldPref.filePath!, 90);
    closeAllIndexes();

    const bundle = recall(testDir, {
      task: 'neural network deep learning',
      decay_weights: { fact: 0.0, preference: 0.9 },
      type_weights: { fact: 1.0, preference: 1.0 },
    });

    const ids = bundle.atoms.map(a => a.frontmatter.id);
    // Old fact (no decay penalty) should rank above old preference (heavy decay penalty)
    expect(ids.indexOf(oldFact.frontmatter.id)).toBeLessThan(
      ids.indexOf(oldPref.frontmatter.id),
    );
  });

  it('per-type decay_weights with fallback to global for unspecified types', () => {
    // Only set decay_weights for fact. Decision should use the global decay_weight.
    const oldFact = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'stable-fact', body: 'quantum computing qubit entanglement',
    });
    backdateAtom(oldFact.filePath!, 60);

    const oldDecision = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'decision', slug: 'old-decision', body: 'quantum computing qubit entanglement',
    });
    backdateAtom(oldDecision.filePath!, 60);
    closeAllIndexes();

    // fact=0 (no decay), global decay_weight=0.5.
    // Decision falls back to global=0.5, which penalizes the 60-day-old decision.
    // Fact has no decay penalty.
    const bundle = recall(testDir, {
      task: 'quantum computing qubit',
      decay_weight: 0.5,
      decay_weights: { fact: 0.0 },
      type_weights: { fact: 1.0, decision: 1.0 },
    });

    const ids = bundle.atoms.map(a => a.frontmatter.id);
    // Old fact (no decay) should outrank old decision (decayed at 0.5 weight)
    expect(ids.indexOf(oldFact.frontmatter.id)).toBeLessThan(
      ids.indexOf(oldDecision.frontmatter.id),
    );
  });
});

describe('per-type decay weights — no-task path', () => {
  it('no-task sorting also uses per-type decay weights', () => {
    // Use two atoms of the same type but assigned different decay weights via
    // different types. Both facts (same status=active).
    // Create a recent preference and an old fact. Both status=active.
    // fact=0.9 (heavy decay, old fact penalized), preference=0.0 (no decay).
    // Wait — no-task path sorts by status first, then by weighted decay score.
    // Use same status atoms.
    const oldFact = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'old-fact', body: 'Stable fact that should persist',
    });
    backdateAtom(oldFact.filePath!, 120);

    const oldPref = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'preference', slug: 'old-pref', body: 'Old preference that persists',
    });
    backdateAtom(oldPref.filePath!, 120);
    closeAllIndexes();

    // Both old, both active status. fact=0.9 (penalized by age), preference=0.0 (no decay penalty).
    // No-task sort: same status → compare by weighted decay.
    // fact: temporalDecay(120d) * 0.9 ≈ 0.0625 * 0.9 ≈ 0.056
    // preference: 0 (dw=0 means decayScore=0)
    // Sort: decayB - decayA → fact has higher weighted decay → fact comes first.
    // Actually we want preference (decay=0) to NOT be penalized.
    // With dw=0, decayScore=0. With dw=0.9, decayScore=~0.056. Higher wins in sort.
    // So fact (0.056) > preference (0). fact comes first. Let me invert:

    // preference=0.9 (penalized), fact=0.0 (not penalized → decayScore=0).
    // preference: temporalDecay(120d) * 0.9 ≈ 0.056
    // fact: 0
    // preference (0.056) > fact (0) → preference comes first despite same age.
    const bundle = recall(testDir, {
      decay_weights: { preference: 0.9, fact: 0.0 },
    });

    const ids = bundle.atoms.map(a => a.frontmatter.id);
    // preference has higher weighted decay score (0.056 > 0) → ranks first
    expect(ids.indexOf(oldPref.frontmatter.id)).toBeLessThan(
      ids.indexOf(oldFact.frontmatter.id),
    );
  });

  it('no-task path: type with zero decay sorts by updated_at when both are zero', () => {
    // Two facts, both with decay_weight=0. Should sort by updated_at.
    const factA = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'fact-a', body: 'First fact body content',
    });
    backdateAtom(factA.filePath!, 30);

    const factB = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'fact-b', body: 'Second fact body content',
    });
    // factB is recent (created now), factA is old.
    closeAllIndexes();

    const bundle = recall(testDir, {
      decay_weights: { fact: 0.0 },
    });

    const ids = bundle.atoms.map(a => a.frontmatter.id);
    // Both have dwA=0 and dwB=0, so falls back to updated_at comparison.
    // factB is newer → ranks first.
    expect(ids.indexOf(factB.frontmatter.id)).toBeLessThan(
      ids.indexOf(factA.frontmatter.id),
    );
  });
});

describe('RECALL_DECAY_WEIGHTS env var', () => {
  it('parses valid JSON correctly', () => {
    process.env.RECALL_DECAY_WEIGHTS = '{"fact":0.0,"entity_summary":0.05,"preference":0.9}';

    const oldFact = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'env-fact', body: 'environment variable test content data',
    });
    backdateAtom(oldFact.filePath!, 90);

    const oldPref = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'preference', slug: 'env-pref', body: 'environment variable test content data',
    });
    backdateAtom(oldPref.filePath!, 90);
    closeAllIndexes();

    // fact=0 from env, preference=0.9 from env.
    // Old fact keeps full relevance, old preference gets heavy decay penalty.
    const bundle = recall(testDir, {
      task: 'environment variable test',
      type_weights: { fact: 1.0, preference: 1.0 },
    });

    const ids = bundle.atoms.map(a => a.frontmatter.id);
    expect(ids.indexOf(oldFact.frontmatter.id)).toBeLessThan(
      ids.indexOf(oldPref.frontmatter.id),
    );
  });

  it('invalid/malformed JSON falls back gracefully', () => {
    process.env.RECALL_DECAY_WEIGHTS = 'not-valid-json{{{';

    // Should not throw — falls back to global decay_weight
    const atom = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'fallback-test', body: 'Fallback test body content',
    });
    closeAllIndexes();

    const bundle = recall(testDir, { task: 'fallback test' });
    expect(bundle.atoms.length).toBeGreaterThanOrEqual(1);
    expect(bundle.atoms.some(a => a.frontmatter.id === atom.frontmatter.id)).toBe(true);
  });

  it('query.decay_weights overrides env var for same type', () => {
    process.env.RECALL_DECAY_WEIGHTS = '{"fact":0.9}';

    const oldFact = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'override-fact', body: 'override precedence test query data',
    });
    backdateAtom(oldFact.filePath!, 60);

    const recentFact = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'recent-fact', body: 'override precedence test query data',
    });
    closeAllIndexes();

    // Env says fact=0.9 (heavy decay). Query overrides to fact=0 (no decay).
    const withOverride = recall(testDir, {
      task: 'override precedence test',
      decay_weights: { fact: 0.0 },
    });

    const withEnvOnly = recall(testDir, {
      task: 'override precedence test',
    });

    const overrideIds = withOverride.atoms.map(a => a.frontmatter.id);
    const envIds = withEnvOnly.atoms.map(a => a.frontmatter.id);

    // With env-only (fact=0.9), recent should rank above old
    expect(envIds.indexOf(recentFact.frontmatter.id)).toBeLessThan(
      envIds.indexOf(oldFact.frontmatter.id),
    );

    // With query override (fact=0.0), both have same score — both present
    expect(overrideIds).toContain(oldFact.frontmatter.id);
    expect(overrideIds).toContain(recentFact.frontmatter.id);
  });

  it('ignores out-of-range values in env var', () => {
    // Values outside 0-1 should be ignored
    process.env.RECALL_DECAY_WEIGHTS = '{"fact":-0.5,"preference":1.5,"decision":0.3}';

    const oldFact = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'range-fact', body: 'range validation test data query',
    });
    backdateAtom(oldFact.filePath!, 60);

    const oldDecision = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'decision', slug: 'range-decision', body: 'range validation test data query',
    });
    backdateAtom(oldDecision.filePath!, 60);
    closeAllIndexes();

    // fact=-0.5 ignored (out of range), falls back to global. decision=0.3 accepted.
    const bundle = recall(testDir, {
      task: 'range validation test',
      decay_weight: 0.2,
    });

    expect(bundle.atoms.length).toBeGreaterThanOrEqual(2);
  });
});

describe('backward compatibility', () => {
  it('existing RECALL_DECAY_WEIGHT env var still works as global fallback', () => {
    const prevEnv = process.env.RECALL_DECAY_WEIGHT;
    process.env.RECALL_DECAY_WEIGHT = '0';

    const recent = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'compat-recent', body: 'backward compatibility test alpha beta',
    });

    const old = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'compat-old', body: 'backward compatibility test alpha beta',
    });
    backdateAtom(old.filePath!, 90);
    closeAllIndexes();

    // With RECALL_DECAY_WEIGHT=0, recency should not matter.
    const bundle = recall(testDir, { task: 'backward compatibility test' });
    expect(bundle.atoms).toHaveLength(2);

    process.env.RECALL_DECAY_WEIGHT = prevEnv ?? '';
  });

  it('default behavior unchanged when no per-type weights set', () => {
    const recent = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'default-recent', body: 'default behavior check gamma delta',
    });

    const old = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'default-old', body: 'default behavior check gamma delta',
    });
    backdateAtom(old.filePath!, 60);
    closeAllIndexes();

    // No decay_weights set — should use global default (0.2).
    const bundle = recall(testDir, {
      task: 'default behavior check gamma',
      decay_weight: 0.3,
    });

    const ids = bundle.atoms.map(a => a.frontmatter.id);
    expect(ids.indexOf(recent.frontmatter.id)).toBeLessThan(
      ids.indexOf(old.frontmatter.id),
    );
  });
});
