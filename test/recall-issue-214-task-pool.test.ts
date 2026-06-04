/**
 * Issue #214: `mk recall` fails store-wide
 *
 * Three concrete bugs from the 2026-05-31 diagnostic:
 *
 *   A. searchFts() syntax-errors on dotted queries like "192.168.1.136" —
 *      its catch block returns null, indistinguishable from "FTS unavailable".
 *
 *   B. When task is set and FTS returns 0 hits, recall returns the top-by-
 *      status atoms anyway (score-0 fallback fills the budget). Hallucination
 *      scaffold for any consumer.
 *
 *   C. Even when FTS matches some atoms, the candidate pool from queryIndex
 *      includes everything else status-filtered, and the budget fills with
 *      non-matched noise after the few matched atoms.
 *
 * Fix: when task is set, restrict the candidate pool to (ftsHits ∪ semanticHits).
 * Return empty atoms array + recall_status: "no_match" when both are empty.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  initMemoryDir,
  createAtom,
  closeAllIndexes,
  openIndex,
} from '../src/index.js';
import { recall } from '../src/recall.js';

const AGENT = 'test-agent';
const SESSION = 'test-session';
let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-issue-214-'));
  initMemoryDir(testDir);
  openIndex(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

const base = () => ({
  memoryDir: testDir,
  agent_id: AGENT,
  session_id: SESSION,
});

/**
 * Helper: seed five atoms with known keyword content. Mirrors the live
 * reproductions on Taj's + Mai's stores: each keyword appears in exactly
 * one atom body.
 */
function seedAtoms() {
  createAtom({
    ...base(),
    type: 'fact',
    slug: 'hardware-spec',
    body: '# Hardware spec\n\nGold-digger box: AMD Ryzen 7 255 with 64GB RAM.',
    confidence: 0.9,
  });
  createAtom({
    ...base(),
    type: 'fact',
    slug: 'network-identity',
    body: '# Network identity\n\nTaj current machine identity: NanoClaw deployed on 192.168.1.136.',
    confidence: 0.9,
  });
  createAtom({
    ...base(),
    type: 'fact',
    slug: 'voice-transcription',
    body: '# Voice transcription\n\nUses GROQ whisper-large-v3 endpoint for low-latency transcription.',
    confidence: 0.9,
  });
  createAtom({
    ...base(),
    type: 'fact',
    slug: 'service-config',
    body: '# Service config\n\nnanoclaw-v2 systemctl service name: nanoclaw-v2.service (id 9cc4465c).',
    confidence: 0.9,
  });
  createAtom({
    ...base(),
    type: 'fact',
    slug: 'beelink-hardware',
    body: '# Beelink hardware\n\nThe Beelink SER5 box runs at 192.168.1.19 — used for the Mai store backup.',
    confidence: 0.9,
  });
}

describe('recall: issue #214 fix — task-pool restriction', () => {
  it('returns empty atoms array when task has no FTS or semantic match', () => {
    seedAtoms();

    const result = recall(testDir, {
      task: 'NonexistentKeywordXyz42',
      max_tokens: 600,
    });

    // Failure mode B: previously returned all 5 atoms (score-0 fallback).
    expect(result.atoms).toEqual([]);
    expect(result.recall_status).toBe('no_match');
  });

  it('returns only the FTS-matched atoms when task does match (no pool pollution)', () => {
    seedAtoms();

    const result = recall(testDir, {
      task: 'NanoClaw',
      max_tokens: 600,
    });

    // Failure mode C: previously returned all 5 atoms (2 matched + 3 noise).
    // "NanoClaw" appears in network-identity AND service-config (case-insensitive,
    // stemmer-normalized).
    expect(result.atoms.length).toBe(2);
    expect(result.recall_status).toBe('match');

    const bodies = result.atoms.map((a) => a.body).join('\n');
    expect(bodies).toContain('NanoClaw');
  });

  it('does not crash on dotted IP query — surfaces atoms matching the token components', () => {
    seedAtoms();

    // Failure mode A: previously fts5: syntax error near "."  → null → fallback.
    // After fix: dots stripped from query; "192.168.1.136" → tokens [192, 168, 1, 136]
    // matched against the body where unicode61 tokenizer already split the same way.
    const result = recall(testDir, {
      task: '192.168.1.136',
      max_tokens: 600,
    });

    // Must not crash AND must return only atoms that actually contain those tokens.
    // Both network-identity (192.168.1.136) and beelink-hardware (192.168.1.19)
    // share the leading 192/168/1 tokens, so both should match the OR query.
    expect(result.recall_status).toBe('match');
    expect(result.atoms.length).toBeGreaterThan(0);
    expect(result.atoms.length).toBeLessThanOrEqual(5);

    const ids = result.atoms.map((a) => a.frontmatter.id);
    expect(ids.some((id) => id.includes('NETWORK-IDENTITY'))).toBe(true);
  });

  it('preserves no-task behaviour — full pool when task is absent', () => {
    seedAtoms();

    // No task → no FTS gate → full pool, ordered by status priority + recency.
    // recall_status should be absent or "match" (the field is task-conditional).
    const result = recall(testDir, { max_tokens: 6000 });

    expect(result.atoms.length).toBe(5);
  });

  it('matched count is independent of pool size — adding noise atoms does not change result', () => {
    seedAtoms();

    // Pile on 20 more atoms with no overlap with the test keywords.
    for (let i = 0; i < 20; i++) {
      createAtom({
        ...base(),
        type: 'fact',
        slug: `noise-${i}`,
        body: `# Noise ${i}\n\nUnrelated content about widgets and sprockets.`,
        confidence: 0.9,
      });
    }

    const result = recall(testDir, {
      task: 'NanoClaw',
      max_tokens: 600,
    });

    // Still exactly 2 matches — noise atoms don't get picked up.
    expect(result.atoms.length).toBe(2);
  });

  it('graph_boost expands pool with 1-hop neighbours of matched anchors', () => {
    // Neighbour with NO keyword overlap — included only via graph expansion.
    const neighbour = createAtom({
      ...base(),
      type: 'fact',
      slug: 'graph-neighbour',
      body: '# Unrelated body\n\nNothing about the task keyword in here.',
      confidence: 0.9,
    });

    // Anchor atom that FTS-matches the task, with a `related` edge to neighbour.
    const anchor = createAtom({
      ...base(),
      type: 'fact',
      slug: 'graph-anchor',
      body: '# Kubernetes deployment\n\nKubernetes deployment strategy notes.',
      confidence: 0.9,
      relations: [{ target: neighbour.frontmatter.id, type: 'related' }],
    });

    // Unrelated atom — must not surface regardless of graph_boost setting.
    const isolated = createAtom({
      ...base(),
      type: 'fact',
      slug: 'graph-isolated',
      body: '# Totally unrelated\n\nContent about widgets and sprockets only.',
      confidence: 0.9,
    });

    const withBoost = recall(testDir, {
      task: 'Kubernetes deployment',
      graph_boost: true,
      max_tokens: 6000,
    });
    const withoutBoost = recall(testDir, {
      task: 'Kubernetes deployment',
      graph_boost: false,
      max_tokens: 6000,
    });

    const withBoostIds = withBoost.atoms.map((a) => a.frontmatter.id);
    const withoutBoostIds = withoutBoost.atoms.map((a) => a.frontmatter.id);

    // Anchor present in both.
    expect(withBoostIds).toContain(anchor.frontmatter.id);
    expect(withoutBoostIds).toContain(anchor.frontmatter.id);

    // Neighbour surfaces only when graph_boost is on (expansion picks it up
    // via the related edge), not when graph_boost is off.
    expect(withBoostIds).toContain(neighbour.frontmatter.id);
    expect(withoutBoostIds).not.toContain(neighbour.frontmatter.id);

    // Isolated atom never surfaces — no FTS hit, no edge to the anchor.
    expect(withBoostIds).not.toContain(isolated.frontmatter.id);
    expect(withoutBoostIds).not.toContain(isolated.frontmatter.id);
  });

  it('graph expansion respects status filter — superseded neighbour does not surface', () => {
    // Reviewer's symmetric-expansion concern: if a `supersedes` chain has
    // the new atom in the anchor set, the OLD (superseded) atom is its
    // graph neighbour. The existing status filter (filterAtoms / queryIndex
    // excludes `superseded` by default) is what prevents the stale atom
    // from leaking through graph expansion. This test locks that in.
    const oldAtom = createAtom({
      ...base(),
      type: 'fact',
      slug: 'superseded-old',
      body: '# Old Kubernetes notes\n\nOutdated Kubernetes deployment notes.',
      confidence: 0.9,
      status: 'superseded',
    });

    const newAtom = createAtom({
      ...base(),
      type: 'fact',
      slug: 'supersedes-new',
      body: '# New Kubernetes notes\n\nFresh Kubernetes deployment notes.',
      confidence: 0.9,
      relations: [{ target: oldAtom.frontmatter.id, type: 'supersedes' }],
    });

    const result = recall(testDir, {
      task: 'Kubernetes deployment',
      graph_boost: true,
      max_tokens: 6000,
    });

    const ids = result.atoms.map((a) => a.frontmatter.id);
    // The new atom surfaces; the superseded old atom does NOT, even though
    // graph expansion would pull it in via the supersedes edge.
    expect(ids).toContain(newAtom.frontmatter.id);
    expect(ids).not.toContain(oldAtom.frontmatter.id);
  });
});
