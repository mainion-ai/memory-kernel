/**
 * #274 Gap 1 — auto-extracted draft atoms must not surface in recall/render
 * until promoted.
 *
 * Session-end extract (#268) lands `status: draft` atoms tagged `auto-extracted`.
 * Those are unvetted and must stay out of the recall candidate pool + render
 * selection by default (they'd otherwise enter live context immediately,
 * including via #267's recall-inject). The gate is scoped to the
 * `auto-extracted` tag — NOT all drafts — so hand-authored draft beliefs (the
 * developmental-arc resting state, held in draft by Gap 2) still render.
 * Opt back in via `include_drafts` / `--include-drafts`; an explicit
 * `statuses: ['draft']` filter (inspection path) still sees them.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initMemoryDir, createAtom, reindex, recall, closeAllIndexes } from '../src/index.js';
import { renderClaudeMd } from '../src/render.js';

let testDir: string;

function base() {
  return { memoryDir: testDir, agent_id: 'a', session_id: 's' };
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-draft-vis-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

/** Active atom + an auto-extracted draft (simulating #268 extract output), both matching the task. */
function seedActiveAndExtractedDraft() {
  createAtom({ ...base(), type: 'fact', slug: 'active-deploy', body: 'The deploy pipeline takes four minutes end to end.', confidence: 0.9, status: 'active' });
  createAtom({
    ...base(), type: 'fact', slug: 'draft-deploy',
    body: 'The deploy pipeline uses a four minute cache warm step.',
    confidence: 0.8, status: 'draft',
    scope: { tags: ['auto-extracted'] },
  });
  reindex(testDir);
}

describe('#274 Gap 1 — recall: auto-extracted drafts excluded by default', () => {
  it('excludes an auto-extracted draft by default', () => {
    seedActiveAndExtractedDraft();
    const bundle = recall(testDir, { task: 'deploy pipeline four minutes' });
    const statuses = bundle.atoms.map((a) => a.frontmatter.status);
    expect(statuses).toContain('active');
    expect(statuses).not.toContain('draft');
  });

  it('includes auto-extracted drafts when include_drafts is set', () => {
    seedActiveAndExtractedDraft();
    const bundle = recall(testDir, { task: 'deploy pipeline four minutes', include_drafts: true });
    expect(bundle.atoms.some((a) => a.frontmatter.status === 'draft')).toBe(true);
  });

  it('still surfaces drafts when statuses explicitly requests them (inspection path)', () => {
    seedActiveAndExtractedDraft();
    const bundle = recall(testDir, { task: 'deploy pipeline four minutes', statuses: ['draft'] });
    expect(bundle.atoms.length).toBeGreaterThan(0);
    expect(bundle.atoms.every((a) => a.frontmatter.status === 'draft')).toBe(true);
  });

  it('does NOT exclude a hand-authored (non-auto-extracted) draft — e.g. a draft belief', () => {
    createAtom({ ...base(), type: 'fact', slug: 'anchor', body: 'Deploy pipeline anchor fact for the query.', confidence: 0.9, status: 'active' });
    // A plain draft belief (default status for beliefs), no auto-extracted tag.
    createAtom({ ...base(), type: 'belief', slug: 'held-belief', body: 'The deploy pipeline reflects a deeper architectural stance.', confidence: 0.7, status: 'draft' });
    reindex(testDir);
    const bundle = recall(testDir, { task: 'deploy pipeline architectural stance' });
    expect(bundle.atoms.some((a) => a.frontmatter.type === 'belief' && a.frontmatter.status === 'draft')).toBe(true);
  });
});

describe('#274 Gap 1 — render: auto-extracted drafts excluded, draft beliefs preserved', () => {
  it('fill-mode render excludes an auto-extracted draft', () => {
    createAtom({ ...base(), type: 'fact', slug: 'active-fact', body: 'Active fact that should render.', confidence: 0.9, status: 'active' });
    createAtom({
      ...base(), type: 'fact', slug: 'draft-fact',
      body: 'Extracted draft fact that must not render yet.',
      confidence: 0.8, status: 'draft', scope: { tags: ['auto-extracted'] },
    });
    reindex(testDir);

    const md = renderClaudeMd(testDir, { fill: true });
    expect(md).toContain('Active fact that should render');
    expect(md).not.toContain('Extracted draft fact that must not render yet');
  });

  it('fill-mode render still includes a hand-authored draft belief', () => {
    createAtom({ ...base(), type: 'belief', slug: 'arc-belief', body: 'Hand-authored draft belief that should still render.', confidence: 0.7, status: 'draft' });
    reindex(testDir);
    const md = renderClaudeMd(testDir, { fill: true });
    expect(md).toContain('Hand-authored draft belief that should still render');
  });
});
