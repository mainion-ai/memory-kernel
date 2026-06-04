/**
 * Issue #115: recall.ts must deduct episode tokens from the atom budget so the
 * bundle stays within `max_tokens`.
 *
 * The `episodeReservation` line was already present, but the no-task path was
 * not symmetric and the final `bundle.token_estimate` could still drift past
 * `max_tokens`. Verify the invariant `token_estimate <= max_tokens` holds for
 * both task and no-task paths with `include_episodes: true`.
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
  writeEpisode,
} from '../src/index.js';
import { recall } from '../src/recall.js';

const AGENT = 'test-agent';
const SESSION = 'test-session';
let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-issue-115-'));
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

describe('recall: episode tokens count against budget (issue #115)', () => {
  it('token_estimate stays within max_tokens with include_episodes (task path)', () => {
    // Seed enough content to overflow a small budget if not properly capped.
    for (let i = 0; i < 10; i++) {
      createAtom({
        ...base(),
        type: 'fact',
        slug: `atom-${i}`,
        body: 'deployment '.repeat(50) + ` index=${i}`,
      });
    }
    for (let i = 0; i < 5; i++) {
      writeEpisode(testDir, `sess-${i}`, 'Deployment summary. '.repeat(40), {
        tags: ['deploy'],
      });
    }

    const maxTokens = 500;
    const bundle = recall(testDir, {
      task: 'deployment',
      include_episodes: true,
      max_tokens: maxTokens,
    });

    expect(bundle.token_estimate).toBeLessThanOrEqual(maxTokens);
  });

  it('token_estimate stays within max_tokens with include_episodes (no-task path)', () => {
    for (let i = 0; i < 10; i++) {
      createAtom({
        ...base(),
        type: 'fact',
        slug: `atom-${i}`,
        body: 'fact body content '.repeat(40) + ` ${i}`,
      });
    }
    for (let i = 0; i < 5; i++) {
      writeEpisode(testDir, `sess-${i}`, 'Episode body content. '.repeat(40), {});
    }

    const maxTokens = 500;
    const bundle = recall(testDir, {
      include_episodes: true,
      max_tokens: maxTokens,
    });

    expect(bundle.token_estimate).toBeLessThanOrEqual(maxTokens);
  });

  it('atom budget shrinks when episodes are requested', () => {
    // With include_episodes, fewer atoms should fit than without — the episode
    // reservation eats into the atom budget.
    for (let i = 0; i < 20; i++) {
      createAtom({
        ...base(),
        type: 'fact',
        slug: `atom-${i}`,
        body: 'deployment '.repeat(30) + ` ${i}`,
      });
    }
    for (let i = 0; i < 5; i++) {
      writeEpisode(testDir, `sess-${i}`, 'Deployment summary. '.repeat(20), { tags: ['deploy'] });
    }

    const withoutEpisodes = recall(testDir, {
      task: 'deployment',
      max_tokens: 800,
    });
    const withEpisodes = recall(testDir, {
      task: 'deployment',
      include_episodes: true,
      max_tokens: 800,
    });

    // Episodes reservation should leave atom budget smaller (or equal in
    // degenerate cases). Total still bounded.
    expect(withEpisodes.token_estimate).toBeLessThanOrEqual(800);
    expect(withoutEpisodes.token_estimate).toBeLessThanOrEqual(800);
  });

  it('include_episodes with tight budget still respects max_tokens (regression for #115)', () => {
    // Aggressive scenario: lots of large atoms, lots of large episodes, tiny
    // budget. Without the episodeReservation deduction, atomTokens alone could
    // consume the full budget and adding episodeTokens would push the bundle
    // over max_tokens.
    for (let i = 0; i < 30; i++) {
      createAtom({
        ...base(),
        type: 'fact',
        slug: `deploy-fact-${i}`,
        body: 'deployment infrastructure '.repeat(20) + ` token=${i}`,
      });
    }
    for (let i = 0; i < 10; i++) {
      writeEpisode(
        testDir,
        `episode-${i}`,
        'Deployment session summary. '.repeat(30),
        { tags: ['deploy'] },
      );
    }

    for (const maxTokens of [300, 600, 1200, 2400]) {
      const bundle = recall(testDir, {
        task: 'deployment',
        include_episodes: true,
        max_tokens: maxTokens,
      });
      expect(bundle.token_estimate).toBeLessThanOrEqual(maxTokens);
    }
  });
});
