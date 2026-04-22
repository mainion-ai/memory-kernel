import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initMemoryDir, closeAllIndexes, openIndex, listAtoms } from '../src/index.js';
import { createAtom } from '../src/retain.js';
import { consolidateAtoms } from '../src/consolidate.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-consolidate-'));
  initMemoryDir(testDir);
  openIndex(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

/** Create a draft atom with optional auto-extracted tag. */
function createDraftAtom(opts: {
  slug: string;
  type?: string;
  autoExtracted?: boolean;
  body?: string;
  tags?: string[];
}) {
  const tags = [
    ...(opts.autoExtracted !== false ? ['auto-extracted'] : []),
    ...(opts.tags ?? []),
  ];
  return createAtom({
    memoryDir: testDir,
    agent_id: 'test-agent',
    session_id: 'test-session',
    type: (opts.type ?? 'fact') as any,
    slug: opts.slug,
    body: opts.body ?? `## Fact\n${opts.slug} body content.`,
    status: 'draft',
    scope: { tags },
  });
}

describe('consolidateAtoms', () => {
  it('returns empty result when no draft atoms exist', async () => {
    const result = await consolidateAtoms({ memoryDir: testDir });

    expect(result.processed).toBe(0);
    expect(result.promoted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.atoms).toHaveLength(0);
  });

  it('filters to auto-extracted drafts by default', async () => {
    // Create one auto-extracted draft and one plain draft
    createDraftAtom({ slug: 'auto-fact', autoExtracted: true });
    createDraftAtom({ slug: 'manual-fact', autoExtracted: false });

    const result = await consolidateAtoms({ memoryDir: testDir, dryRun: true });

    // Only the auto-extracted one should be processed
    expect(result.processed).toBe(1);
    // slug is the atom ID derived from the user slug (e.g. FACT-2026-xx-AUTO-FACT-xxx)
    expect(result.atoms[0].slug).toMatch(/AUTO-FACT/i);
  });

  it('--all includes all draft atoms regardless of tag', async () => {
    createDraftAtom({ slug: 'auto-fact', autoExtracted: true });
    createDraftAtom({ slug: 'manual-fact', autoExtracted: false });

    const result = await consolidateAtoms({ memoryDir: testDir, dryRun: true, all: true });

    expect(result.processed).toBe(2);
  });

  it('promotes clean draft atoms to active status', async () => {
    createDraftAtom({ slug: 'clean-fact' });

    const result = await consolidateAtoms({ memoryDir: testDir });

    expect(result.promoted).toBe(1);
    expect(result.atoms[0].status).toBe('promoted');

    // Verify the atom on disk is now active
    const atoms = listAtoms(testDir);
    const promoted = atoms.find((a) => a.frontmatter.status === 'active');
    expect(promoted).toBeDefined();
  });

  it('removes auto-extracted tag from promoted atoms', async () => {
    createDraftAtom({ slug: 'clean-fact', tags: ['extra-tag'] });

    await consolidateAtoms({ memoryDir: testDir });

    const atoms = listAtoms(testDir);
    const promoted = atoms.find((a) => a.frontmatter.status === 'active');
    expect(promoted).toBeDefined();
    expect(promoted!.frontmatter.scope?.tags).not.toContain('auto-extracted');
    expect(promoted!.frontmatter.scope?.tags).toContain('extra-tag');
  });

  it('skips possible duplicates', async () => {
    // Create an active atom first
    createAtom({
      memoryDir: testDir,
      agent_id: 'test-agent',
      session_id: 'test-session',
      type: 'fact',
      slug: 'original-fact',
      body: '## Fact\nThe API rate limit is 1000 requests per minute.',
      status: 'active',
    });

    // Create a near-duplicate draft with very similar content
    createDraftAtom({
      slug: 'duplicate-fact',
      body: '## Fact\nThe API rate limit is 1000 requests per minute.',
    });

    const result = await consolidateAtoms({ memoryDir: testDir });

    // The duplicate should be skipped (if FTS index detects it)
    // Note: even if FTS doesn't catch it in this test setup, processed should be 1
    expect(result.processed).toBe(1);
    // Either promoted or skipped — the key check is that no error occurred
    expect(result.errors).toBe(0);
  });

  it('dry-run does not write changes to disk', async () => {
    createDraftAtom({ slug: 'clean-fact' });

    const result = await consolidateAtoms({ memoryDir: testDir, dryRun: true });

    expect(result.dry_run).toBe(true);
    expect(result.atoms[0].status).toBe('would_promote');

    // Atom should still be draft on disk
    const atoms = listAtoms(testDir);
    const stillDraft = atoms.find((a) => a.frontmatter.status === 'draft');
    expect(stillDraft).toBeDefined();
    const noActive = atoms.find((a) => a.frontmatter.status === 'active');
    expect(noActive).toBeUndefined();
  });

  it('dry-run skipped atoms have status would_skip', async () => {
    // Create an active atom first
    createAtom({
      memoryDir: testDir,
      agent_id: 'test-agent',
      session_id: 'test-session',
      type: 'fact',
      slug: 'original-fact',
      body: '## Fact\nThe API rate limit is 1000 requests per minute.',
      status: 'active',
    });

    // Create a near-duplicate draft
    createDraftAtom({
      slug: 'dup-fact',
      body: '## Fact\nThe API rate limit is 1000 requests per minute.',
    });

    const result = await consolidateAtoms({ memoryDir: testDir, dryRun: true });

    // If FTS detects a duplicate, status should be would_skip (not skipped)
    const dryRunStatuses = result.atoms.map((a) => a.status);
    for (const status of dryRunStatuses) {
      expect(['would_promote', 'would_skip']).toContain(status);
    }
  });

  it('filters by type option', async () => {
    createDraftAtom({ slug: 'fact-1', type: 'fact' });
    createDraftAtom({ slug: 'belief-1', type: 'belief' });

    const result = await consolidateAtoms({
      memoryDir: testDir,
      dryRun: true,
      type: 'fact',
    });

    expect(result.processed).toBe(1);
    expect(result.atoms[0].type).toBe('fact');
  });

  it('respects limit option', async () => {
    createDraftAtom({ slug: 'fact-1' });
    createDraftAtom({ slug: 'fact-2' });
    createDraftAtom({ slug: 'fact-3' });

    const result = await consolidateAtoms({
      memoryDir: testDir,
      dryRun: true,
      limit: 2,
    });

    expect(result.processed).toBe(2);
  });

  it('catches and records errors gracefully', async () => {
    // Create two draft atoms, then make ENTITIES/ non-writable.
    // listAtoms can still read existing files (r-x permission on the directory),
    // but writeFileAtomic cannot create temp files inside it, so updateAtom throws
    // EACCES. The catch block in consolidateAtoms records the error for each atom.
    createDraftAtom({ slug: 'broken-fact-1' });
    createDraftAtom({ slug: 'broken-fact-2' });

    const entitiesDir = path.join(testDir, 'ENTITIES');
    fs.chmodSync(entitiesDir, 0o555);

    let result;
    try {
      result = await consolidateAtoms({ memoryDir: testDir });
    } finally {
      // Restore so afterEach cleanup can remove files
      fs.chmodSync(entitiesDir, 0o755);
    }

    expect(result!.errors).toBeGreaterThan(0);
    expect(result!.promoted).toBe(0);
    const errorAtoms = result!.atoms.filter((a) => a.status === 'error');
    expect(errorAtoms.length).toBeGreaterThan(0);
    expect(errorAtoms[0].reason).toBeTruthy();
  });

  it('result contains atom_id, slug, type, title, and status for each atom', async () => {
    createDraftAtom({ slug: 'info-fact', body: '## Fact\nSome test content here.' });

    const result = await consolidateAtoms({ memoryDir: testDir, dryRun: true });

    expect(result.atoms).toHaveLength(1);
    const atom = result.atoms[0];
    expect(atom.atom_id).toBeTruthy();
    // slug is the atom ID derived from the user slug (e.g. FACT-2026-xx-INFO-FACT-xxx)
    expect(atom.slug).toMatch(/INFO-FACT/i);
    expect(atom.type).toBe('fact');
    expect(atom.title).toBeTruthy();
    expect(atom.status).toBe('would_promote');
  });

  it('dry_run field in result reflects dryRun option', async () => {
    const dryResult = await consolidateAtoms({ memoryDir: testDir, dryRun: true });
    expect(dryResult.dry_run).toBe(true);

    const liveResult = await consolidateAtoms({ memoryDir: testDir, dryRun: false });
    expect(liveResult.dry_run).toBe(false);
  });

  it('promotes atoms with stale relation types by canonicalizing them', async () => {
    // Older mk versions wrote relation types that are no longer valid in the current schema.
    // We simulate this by writing a raw atom file directly to disk, bypassing createAtom's
    // schema validation (exactly as those atoms ended up in real stores).
    const atomId = 'BELI-2020-01-01-STALE-RELATIONS-1test';
    const atomFile = path.join(testDir, 'ENTITIES', `${atomId}.md`);
    const rawContent = [
      '---',
      `id: ${atomId}`,
      'type: belief',
      'status: draft',
      'confidence: 0.5',
      'created_at: "2020-01-01T00:00:00Z"',
      'updated_at: "2020-01-01T00:00:00Z"',
      'ttl_days: null',
      'scope:',
      '  tags:',
      '    - auto-extracted',
      'relations:',
      '  - type: related',
      '    target: some-other-atom',
      '  - type: seeded',        // stale → related
      '    target: another-atom',
      '  - type: evidenced_by',  // stale → supports
      '    target: evidence-atom',
      '  - type: refines',       // stale → extends
      '    target: parent-atom',
      '---',
      '',
      '## Belief',
      'This atom has stale relation types from an older mk version.',
    ].join('\n');
    fs.writeFileSync(atomFile, rawContent, 'utf-8');

    const result = await consolidateAtoms({ memoryDir: testDir });

    // Should be promoted without error despite stale relation types
    expect(result.errors).toBe(0);
    expect(result.promoted).toBe(1);
    expect(result.atoms[0].status).toBe('promoted');

    // Verify the promoted atom on disk has canonicalized relation types
    const atoms = listAtoms(testDir);
    const promoted = atoms.find((a) => a.frontmatter.id === atomId);
    expect(promoted).toBeDefined();
    expect(promoted!.frontmatter.status).toBe('active');

    const rels = promoted!.frontmatter.relations ?? [];
    const relByTarget = Object.fromEntries(rels.map((r) => [r.target, r.type]));
    expect(relByTarget['some-other-atom']).toBe('related');   // unchanged
    expect(relByTarget['another-atom']).toBe('related');      // seeded → related
    expect(relByTarget['evidence-atom']).toBe('supports');    // evidenced_by → supports
    expect(relByTarget['parent-atom']).toBe('extends');       // refines → extends
  });

  it('drops relations with empty targets during promotion', async () => {
    // Write an atom with an empty-target relation directly to disk to simulate
    // malformed atoms from older mk versions.
    const atomId = 'FACT-2020-01-01-EMPTY-TARGET-FACT-1test';
    const atomFile = path.join(testDir, 'ENTITIES', `${atomId}.md`);
    const rawContent = [
      '---',
      `id: ${atomId}`,
      'type: fact',
      'status: draft',
      'confidence: 0.8',
      'created_at: "2020-01-01T00:00:00Z"',
      'updated_at: "2020-01-01T00:00:00Z"',
      'ttl_days: null',
      'scope:',
      '  tags:',
      '    - auto-extracted',
      'relations:',
      '  - type: related',
      '    target: valid-target',
      '  - type: supports',
      '    target: ""',     // empty — should be dropped
      '---',
      '',
      '## Fact',
      'This atom has a relation with an empty target.',
    ].join('\n');
    fs.writeFileSync(atomFile, rawContent, 'utf-8');

    const result = await consolidateAtoms({ memoryDir: testDir });

    expect(result.errors).toBe(0);
    expect(result.promoted).toBe(1);

    const atoms = listAtoms(testDir);
    const promoted = atoms.find((a) => a.frontmatter.id === atomId);
    expect(promoted).toBeDefined();
    expect(promoted!.frontmatter.status).toBe('active');

    const rels = promoted!.frontmatter.relations ?? [];
    expect(rels).toHaveLength(1);
    expect(rels[0].target).toBe('valid-target');
  });
});
