/**
 * Issue #116: isolation-recall.ts must subtract view tokens from maxTokens.
 *
 * `recallIsolated()` and `mergeIsolatedBundles()` use `query.max_tokens` (or
 * `DEFAULT_RENDER_CONFIG.max_tokens`) as a budget cap for the greedy fill
 * over merged atoms, but the agent's view files (INDEX/HANDOFF/CONSTRAINTS)
 * already consume tokens. The returned `token_estimate` could exceed
 * `maxTokens` once the views are added in. Mirror the `baseTokens` subtraction
 * from `recall.ts`.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  initIsolatedBase,
  initAgentStore,
  createAtom,
  closeAllIndexes,
  openIndex,
  writeView,
} from '../src/index.js';
import { recallIsolated, recallIsolatedWithEmbeddings } from '../src/isolation-recall.js';
import { estimateTokens } from '../src/budget.js';

const AGENT = 'test-agent';
const SESSION = 'test-session';
let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-issue-116-'));
  initIsolatedBase(testDir, 'huston');
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

const agentDir = (agent: string) => path.join(testDir, 'agents', agent);

const base = (dir: string) => ({
  memoryDir: dir,
  agent_id: AGENT,
  session_id: SESSION,
});

describe('recallIsolated: view tokens count against budget (issue #116)', () => {
  it('full bundle (views + atoms) stays within max_tokens when views fit (issue #116)', () => {
    const hustonDir = agentDir('huston');
    openIndex(hustonDir);

    // Moderate views (under the cap) — exercises the new view-token subtraction.
    const moderateViewBody = '# View\n\n' + 'view body line. '.repeat(40);
    writeView(hustonDir, 'INDEX.md', moderateViewBody);
    writeView(hustonDir, 'HANDOFF.md', moderateViewBody);
    writeView(hustonDir, 'CONSTRAINTS.md', moderateViewBody);

    // Seed several atoms that would otherwise fill the budget.
    for (let i = 0; i < 10; i++) {
      createAtom({
        ...base(hustonDir),
        type: 'fact',
        slug: `atom-${i}`,
        body: 'deployment '.repeat(40) + ` ${i}`,
      });
    }

    const maxTokens = 2000;
    const bundle = recallIsolated(hustonDir, testDir, { max_tokens: maxTokens });

    // Pre-fix: tokenCount (atoms-only) was capped at maxTokens, then views
    // pushed actual delivered context past the user's cap.
    // Post-fix: atom budget = maxTokens - viewTokens, so the full bundle fits.
    const viewTokens = estimateTokens(bundle.index + bundle.handoff + bundle.constraints);
    expect(viewTokens).toBeLessThan(maxTokens); // sanity: views fit under cap
    const fullBundleTokens = viewTokens + bundle.token_estimate;
    expect(fullBundleTokens).toBeLessThanOrEqual(maxTokens);
  });

  it('async recallIsolatedWithEmbeddings also respects view tokens', async () => {
    const hustonDir = agentDir('huston');
    openIndex(hustonDir);

    const moderateViewBody = '# View\n\n' + 'view body content line. '.repeat(40);
    writeView(hustonDir, 'INDEX.md', moderateViewBody);
    writeView(hustonDir, 'HANDOFF.md', moderateViewBody);
    writeView(hustonDir, 'CONSTRAINTS.md', moderateViewBody);

    for (let i = 0; i < 10; i++) {
      createAtom({
        ...base(hustonDir),
        type: 'fact',
        slug: `atom-${i}`,
        body: 'deployment '.repeat(40) + ` ${i}`,
      });
    }

    const maxTokens = 2000;
    const bundle = await recallIsolatedWithEmbeddings(hustonDir, testDir, {
      max_tokens: maxTokens,
    });

    const viewTokens = estimateTokens(bundle.index + bundle.handoff + bundle.constraints);
    expect(viewTokens).toBeLessThan(maxTokens);
    const fullBundleTokens = viewTokens + bundle.token_estimate;
    expect(fullBundleTokens).toBeLessThanOrEqual(maxTokens);
  });

  it('budget tight enough that view tokens alone push atoms out', () => {
    const hustonDir = agentDir('huston');
    openIndex(hustonDir);

    // Very large views, very small max_tokens — budget must squeeze the atoms.
    const heavyViewBody = '# Heavy view\n\n' + 'view body content line. '.repeat(400);
    writeView(hustonDir, 'INDEX.md', heavyViewBody);
    writeView(hustonDir, 'HANDOFF.md', heavyViewBody);
    writeView(hustonDir, 'CONSTRAINTS.md', heavyViewBody);

    for (let i = 0; i < 5; i++) {
      createAtom({
        ...base(hustonDir),
        type: 'fact',
        slug: `atom-${i}`,
        body: 'x'.repeat(400) + ` ${i}`,
      });
    }

    // max_tokens < views alone (~9600 chars / 4 ≈ 2400 per view × 3 ≈ 7200)
    const maxTokens = 1000;
    const bundle = recallIsolated(hustonDir, testDir, { max_tokens: maxTokens });

    // Views alone exceed maxTokens — atom budget should clamp to ~0, so no
    // atoms (or at most one, since the loop allows the first atom regardless).
    expect(bundle.atoms.length).toBeLessThanOrEqual(1);
  });
});
