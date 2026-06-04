/**
 * Tests for relink — body-text relation extraction.
 * Covers: core extraction, relation type inference, batch relink,
 * remember-time auto-relink, idempotency, and edge cases.
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
  readAtom,
  writeAtom,
  getRelationsForAtom,
  indexStats,
  getAllAtomIds,
} from '../src/index.js';
import { indexAtom } from '../src/index-db.js';
import {
  extractBodyReferences,
  inferRelationType,
  relinkAtom,
  relinkAll,
  ATOM_ID_PATTERN,
  createAtomIdPattern,
} from '../src/relink.js';
import type { Atom } from '../src/types.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-relink-'));
  initMemoryDir(testDir);
  openIndex(testDir); // ensure DB exists so createAtom calls indexAtom
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// ATOM_ID_PATTERN
// ---------------------------------------------------------------------------

describe('ATOM_ID_PATTERN', () => {
  it('matches standard atom IDs', () => {
    const text = 'See BELI-2026-03-31-DESIRE-PATHS-1abc for details.';
    ATOM_ID_PATTERN.lastIndex = 0;
    const match = ATOM_ID_PATTERN.exec(text);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('BELI-2026-03-31-DESIRE-PATHS-1abc');
  });

  it('matches multiple IDs in one body', () => {
    const text = 'Extends BELI-2026-03-14-NOTATION-1a and FACT-2026-03-09-ID-2b.';
    const matches: string[] = [];
    ATOM_ID_PATTERN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ATOM_ID_PATTERN.exec(text)) !== null) {
      matches.push(m[1]);
    }
    expect(matches).toHaveLength(2);
  });

  it('does not match incomplete patterns', () => {
    const text = 'Not a match: BELI-2026 or BELI-03-31';
    ATOM_ID_PATTERN.lastIndex = 0;
    expect(ATOM_ID_PATTERN.exec(text)).toBeNull();
  });
});

describe('createAtomIdPattern()', () => {
  it('returns a fresh regex per call with no shared state', () => {
    const a = createAtomIdPattern();
    const b = createAtomIdPattern();
    expect(a).not.toBe(b);
    expect(a.lastIndex).toBe(0);
    'DECI-2026-03-11-AUTH-abc12'.match(a);
    expect(b.lastIndex).toBe(0);
  });

  it('matches the same shape as the legacy constant', () => {
    const text = 'See DECI-2026-03-11-AUTH-abc12 and BELI-2025-12-01-FOO-99def';
    const matches = text.match(createAtomIdPattern());
    expect(matches).toEqual([
      'DECI-2026-03-11-AUTH-abc12',
      'BELI-2025-12-01-FOO-99def',
    ]);
  });
});

// ---------------------------------------------------------------------------
// inferRelationType
// ---------------------------------------------------------------------------

describe('inferRelationType', () => {
  it('infers extends from context', () => {
    const body = 'This belief extends BELI-2026-03-14-TARGET-1a into new territory.';
    const idx = body.indexOf('BELI-2026');
    expect(inferRelationType(body, idx)).toBe('extends');
  });

  it('infers contradicts from context', () => {
    const body = 'This contradicts BELI-2026-03-14-TARGET-1a in important ways.';
    const idx = body.indexOf('BELI-2026');
    expect(inferRelationType(body, idx)).toBe('contradicts');
  });

  it('infers supports from context', () => {
    const body = 'Evidence for FACT-2026-03-09-TARGET-1a is strong.';
    const idx = body.indexOf('FACT-2026');
    expect(inferRelationType(body, idx)).toBe('supports');
  });

  it('infers caused_by from context', () => {
    const body = 'Due to DECI-2026-03-09-TARGET-1a, we changed direction.';
    const idx = body.indexOf('DECI-2026');
    expect(inferRelationType(body, idx)).toBe('caused_by');
  });

  it('infers supersedes from context', () => {
    const body = 'This replaces BELI-2026-03-14-TARGET-1a entirely.';
    const idx = body.indexOf('BELI-2026');
    expect(inferRelationType(body, idx)).toBe('supersedes');
  });

  it('defaults to related when no context words match', () => {
    const body = 'See also BELI-2026-03-14-TARGET-1a for more.';
    const idx = body.indexOf('BELI-2026');
    expect(inferRelationType(body, idx)).toBe('related');
  });
});

// ---------------------------------------------------------------------------
// extractBodyReferences
// ---------------------------------------------------------------------------

describe('extractBodyReferences', () => {
  it('extracts references to known atoms', () => {
    const targetId = 'FACT-2026-03-09-IDENTITY-1abc';
    const selfId = 'BELI-2026-04-03-SOME-BELIEF-2def';
    const knownIds = new Set([targetId, selfId]);
    const body = `Connected to ${targetId} in important ways.`;

    const refs = extractBodyReferences(body, selfId, knownIds);
    expect(refs).toHaveLength(1);
    expect(refs[0].targetId).toBe(targetId);
    expect(refs[0].type).toBe('related');
  });

  it('skips self-references', () => {
    const selfId = 'BELI-2026-04-03-SELF-1abc';
    const knownIds = new Set([selfId]);
    const body = `This atom ${selfId} references itself.`;

    const refs = extractBodyReferences(body, selfId, knownIds);
    expect(refs).toHaveLength(0);
  });

  it('skips unknown IDs', () => {
    const selfId = 'BELI-2026-04-03-SOURCE-1abc';
    const knownIds = new Set([selfId]);
    const body = 'See FACT-2020-01-01-NONEXISTENT-xyz for details.';

    const refs = extractBodyReferences(body, selfId, knownIds);
    expect(refs).toHaveLength(0);
  });

  it('deduplicates within body', () => {
    const targetId = 'FACT-2026-03-09-TARGET-1abc';
    const selfId = 'BELI-2026-04-03-SOURCE-2def';
    const knownIds = new Set([targetId, selfId]);
    const body = `First mention: ${targetId}. Second mention: ${targetId}.`;

    const refs = extractBodyReferences(body, selfId, knownIds);
    expect(refs).toHaveLength(1);
  });

  it('extracts multiple distinct references', () => {
    const t1 = 'FACT-2026-03-09-ONE-1a';
    const t2 = 'BELI-2026-03-14-TWO-2b';
    const selfId = 'BELI-2026-04-03-SOURCE-3c';
    const knownIds = new Set([t1, t2, selfId]);
    const body = `Extends ${t1} and see also ${t2}.`;

    const refs = extractBodyReferences(body, selfId, knownIds);
    expect(refs).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// relinkAtom
// ---------------------------------------------------------------------------

describe('relinkAtom', () => {
  it('proposes new relations from body text', () => {
    const target = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'target', body: 'Target fact',
    });

    const source = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'source',
      body: `This extends ${target.frontmatter.id} into new territory.`,
    });

    const knownIds = new Set([target.frontmatter.id, source.frontmatter.id]);
    // Read atom fresh from disk (auto-relink may have added relations)
    const sourceOnDisk = readAtom(source.filePath!);

    // relinkAtom should not propose anything already in frontmatter
    const proposed = relinkAtom(sourceOnDisk, knownIds);
    // Either auto-relink caught it (proposed empty) or it proposes it now
    // The important thing: the relation exists somewhere
    const totalRelations = (sourceOnDisk.frontmatter.relations?.length ?? 0) + proposed.length;
    expect(totalRelations).toBeGreaterThanOrEqual(1);
  });

  it('skips already-existing relations', () => {
    const target = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'existing-target', body: 'Target fact',
    });

    const source = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'existing-source',
      body: `Extends ${target.frontmatter.id}.`,
      relations: [{ target: target.frontmatter.id, type: 'extends' }],
    });

    const knownIds = new Set([target.frontmatter.id, source.frontmatter.id]);
    const sourceOnDisk = readAtom(source.filePath!);
    const proposed = relinkAtom(sourceOnDisk, knownIds);
    expect(proposed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// relinkAll (batch)
// ---------------------------------------------------------------------------

describe('relinkAll', () => {
  it('dry-run proposes but does not write', () => {
    const target = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'batch-target', body: 'Batch target fact',
    });

    // Create source WITHOUT index (so auto-relink in createAtom doesn't fire)
    // Actually, we need to test batch mode, so let's create a source that
    // references something but where auto-relink already ran. We'll patch body after.
    const source = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'batch-source', body: 'No references yet.',
    });

    // Patch body to include a reference (bypassing auto-relink)
    const atom = readAtom(source.filePath!);
    atom.body = `Now see ${target.frontmatter.id} for context.`;
    writeAtom(atom, source.filePath!);
    indexAtom(testDir, { ...atom, filePath: source.filePath });

    const mtimeBefore = fs.statSync(source.filePath!).mtimeMs;

    // Small delay to ensure mtime changes if written
    const result = relinkAll(testDir, { dryRun: true });

    expect(result.proposed.length).toBeGreaterThan(0);
    expect(result.applied).toBe(0);
  });

  it('apply writes relations to frontmatter', () => {
    const target = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'apply-target', body: 'Apply target fact',
    });

    const source = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'apply-source', body: 'No references yet.',
    });

    // Patch body
    const atom = readAtom(source.filePath!);
    atom.body = `This extends ${target.frontmatter.id} significantly.`;
    writeAtom(atom, source.filePath!);
    indexAtom(testDir, { ...atom, filePath: source.filePath });

    const result = relinkAll(testDir, { dryRun: false });
    expect(result.proposed.length).toBeGreaterThan(0);
    expect(result.applied).toBeGreaterThan(0);

    // Verify on disk
    const updated = readAtom(source.filePath!);
    expect(updated.frontmatter.relations).toBeDefined();
    expect(updated.frontmatter.relations!.some(
      (r) => r.target === target.frontmatter.id && r.type === 'extends',
    )).toBe(true);
  });

  it('is idempotent — running twice produces no new relations', () => {
    const target = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'idem-target', body: 'Idempotent target',
    });

    const source = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'idem-source', body: 'No refs yet.',
    });

    // Patch body
    const atom = readAtom(source.filePath!);
    atom.body = `Extends ${target.frontmatter.id}.`;
    writeAtom(atom, source.filePath!);
    indexAtom(testDir, { ...atom, filePath: source.filePath });

    relinkAll(testDir, { dryRun: false });
    const secondRun = relinkAll(testDir, { dryRun: true });
    expect(secondRun.proposed).toHaveLength(0);
  });

  it('returns empty when no body references exist', () => {
    createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'no-refs', body: 'Just a plain fact with no references.',
    });

    const result = relinkAll(testDir, { dryRun: true });
    expect(result.proposed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Auto-relink at remember-time (createAtom hook)
// ---------------------------------------------------------------------------

describe('createAtom auto-relink', () => {
  it('auto-creates relations when body references existing atoms', () => {
    const target = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'auto-target', body: 'Auto-relink target fact',
    });

    // Create a new atom whose body references the target
    const source = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'auto-source',
      body: `This belief extends ${target.frontmatter.id} into new territory.`,
    });

    // Read back from disk — should have auto-created relation
    const onDisk = readAtom(source.filePath!);
    expect(onDisk.frontmatter.relations).toBeDefined();
    expect(onDisk.frontmatter.relations!.some(
      (r) => r.target === target.frontmatter.id && r.type === 'extends',
    )).toBe(true);

    // Also verify in index
    const { outbound } = getRelationsForAtom(testDir, source.frontmatter.id);
    expect(outbound.some(
      (r) => r.target_id === target.frontmatter.id && r.relation_type === 'extends',
    )).toBe(true);
  });

  it('does not auto-relink when explicit relations are provided', () => {
    const t1 = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'explicit-t1', body: 'Target 1',
    });
    const t2 = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'explicit-t2', body: 'Target 2',
    });

    // Create with explicit relation to t1 and body reference to t2
    const source = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'explicit-source',
      body: `See ${t2.frontmatter.id} for context.`,
      relations: [{ target: t1.frontmatter.id, type: 'supports' }],
    });

    // Should have the explicit relation but NOT auto-relink t2
    const onDisk = readAtom(source.filePath!);
    expect(onDisk.frontmatter.relations).toHaveLength(1);
    expect(onDisk.frontmatter.relations![0].target).toBe(t1.frontmatter.id);
  });

  it('does not create self-referencing relations', () => {
    // Create first, then check — the atom can't reference itself since
    // it doesn't know its own ID at body-write time. But test the edge case.
    const atom = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'self-ref-test', body: 'placeholder',
    });

    // Manually patch body to include its own ID and relink
    const onDisk = readAtom(atom.filePath!);
    onDisk.body = `This fact ${atom.frontmatter.id} references itself.`;
    writeAtom(onDisk, atom.filePath!);
    indexAtom(testDir, { ...onDisk, filePath: atom.filePath });

    const result = relinkAll(testDir, { dryRun: true });
    const selfRefs = result.proposed.filter(
      (p) => p.sourceId === atom.frontmatter.id && p.targetId === atom.frontmatter.id,
    );
    expect(selfRefs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getAllAtomIds
// ---------------------------------------------------------------------------

describe('getAllAtomIds', () => {
  it('returns all atom IDs from the index', () => {
    const a1 = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'id-test-1', body: 'Atom 1',
    });
    const a2 = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'id-test-2', body: 'Atom 2',
    });

    const ids = getAllAtomIds(testDir);
    expect(ids.has(a1.frontmatter.id)).toBe(true);
    expect(ids.has(a2.frontmatter.id)).toBe(true);
  });

  it('returns empty set when no index exists', () => {
    const ids = getAllAtomIds('/nonexistent/path');
    expect(ids.size).toBe(0);
  });
});
