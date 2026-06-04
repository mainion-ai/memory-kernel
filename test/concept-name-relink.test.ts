/**
 * Tests for concept-name extraction in relink.
 * Covers: buildConceptMap, extractConceptReferences, integration with
 * relinkAtom/relinkAll, createAtom auto-relink, and edge cases.
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
} from '../src/index.js';
import { indexAtom } from '../src/index-db.js';
import {
  buildConceptMap,
  compileConceptPatterns,
  extractConceptReferences,
  inferRelationType,
  relinkAtom,
  relinkAll,
} from '../src/relink.js';
import type { Atom, AtomFrontmatter } from '../src/types.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-concept-relink-'));
  initMemoryDir(testDir);
  openIndex(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

// Helper: create a minimal Atom object for unit tests (no disk write)
function makeAtom(id: string, body: string = ''): Atom {
  return {
    frontmatter: {
      id,
      type: 'belief',
      status: 'draft',
      confidence: 0.5,
      created_at: '2026-04-06T00:00:00Z',
      updated_at: '2026-04-06T00:00:00Z',
      ttl_days: null,
      classification: 'PUBLIC',
    } as AtomFrontmatter,
    body,
  };
}

// ---------------------------------------------------------------------------
// buildConceptMap
// ---------------------------------------------------------------------------

describe('buildConceptMap', () => {
  it('derives concept names from atom IDs', () => {
    const atoms = [
      makeAtom('BELI-2026-03-14-NOTATION-AS-ERASURE-1abc'),
      makeAtom('BELI-2026-03-15-IDENTITY-AS-REPAIR-2def'),
    ];
    const map = buildConceptMap(atoms);
    expect(map.get('notation-as-erasure')).toBe('BELI-2026-03-14-NOTATION-AS-ERASURE-1abc');
    expect(map.get('identity-as-repair')).toBe('BELI-2026-03-15-IDENTITY-AS-REPAIR-2def');
  });

  it('skips atoms with short slugs', () => {
    // Only 1 word in slug — below minimum of 2 words
    const atoms = [makeAtom('FACT-2026-03-09-SHORT-1a')];
    const map = buildConceptMap(atoms);
    expect(map.size).toBe(0);
  });

  it('handles atoms without IDs', () => {
    const atoms = [{ frontmatter: { id: '' } as AtomFrontmatter, body: '' }];
    const map = buildConceptMap(atoms);
    expect(map.size).toBe(0);
  });

  it('first atom wins on concept-name collision', () => {
    // Two atoms could theoretically produce the same concept name
    const atoms = [
      makeAtom('BELI-2026-03-14-NOTATION-AS-ERASURE-1a'),
      makeAtom('BELI-2026-04-01-NOTATION-AS-ERASURE-2b'),
    ];
    const map = buildConceptMap(atoms);
    // First one wins
    expect(map.get('notation-as-erasure')).toBe('BELI-2026-03-14-NOTATION-AS-ERASURE-1a');
  });
});

// ---------------------------------------------------------------------------
// extractConceptReferences
// ---------------------------------------------------------------------------

describe('extractConceptReferences', () => {
  it('matches hyphenated concept names in body text', () => {
    const conceptMap = new Map([
      ['notation-as-erasure', 'BELI-2026-03-14-NOTATION-AS-ERASURE-1a'],
    ]);
    const body = 'The notation-as-erasure principle suggests all notation erases.';
    const selfId = 'BELI-2026-04-06-SOME-BELIEF-2b';

    const refs = extractConceptReferences(body, selfId, conceptMap);
    expect(refs).toHaveLength(1);
    expect(refs[0].targetId).toBe('BELI-2026-03-14-NOTATION-AS-ERASURE-1a');
  });

  it('matches space-separated concept names', () => {
    const conceptMap = new Map([
      ['notation-as-erasure', 'BELI-2026-03-14-NOTATION-AS-ERASURE-1a'],
    ]);
    const body = 'The notation as erasure principle applies here.';
    const selfId = 'BELI-2026-04-06-SOME-BELIEF-2b';

    const refs = extractConceptReferences(body, selfId, conceptMap);
    expect(refs).toHaveLength(1);
  });

  it('matches underscore-separated concept names', () => {
    const conceptMap = new Map([
      ['notation-as-erasure', 'BELI-2026-03-14-NOTATION-AS-ERASURE-1a'],
    ]);
    const body = 'See notation_as_erasure for details.';
    const selfId = 'BELI-2026-04-06-SOME-BELIEF-2b';

    const refs = extractConceptReferences(body, selfId, conceptMap);
    expect(refs).toHaveLength(1);
  });

  it('is case-insensitive', () => {
    const conceptMap = new Map([
      ['notation-as-erasure', 'BELI-2026-03-14-NOTATION-AS-ERASURE-1a'],
    ]);
    const body = 'The Notation-As-Erasure principle applies.';
    const selfId = 'BELI-2026-04-06-SOME-BELIEF-2b';

    const refs = extractConceptReferences(body, selfId, conceptMap);
    expect(refs).toHaveLength(1);
  });

  it('skips self-references', () => {
    const selfId = 'BELI-2026-03-14-NOTATION-AS-ERASURE-1a';
    const conceptMap = new Map([
      ['notation-as-erasure', selfId],
    ]);
    const body = 'This is about notation-as-erasure.';

    const refs = extractConceptReferences(body, selfId, conceptMap);
    expect(refs).toHaveLength(0);
  });

  it('deduplicates multiple mentions of same concept', () => {
    const conceptMap = new Map([
      ['notation-as-erasure', 'BELI-2026-03-14-NOTATION-AS-ERASURE-1a'],
    ]);
    const body = 'First: notation-as-erasure. Second: notation-as-erasure again.';
    const selfId = 'BELI-2026-04-06-SOME-BELIEF-2b';

    const refs = extractConceptReferences(body, selfId, conceptMap);
    expect(refs).toHaveLength(1);
  });

  it('extracts multiple distinct concept references', () => {
    const conceptMap = new Map([
      ['notation-as-erasure', 'BELI-2026-03-14-NOTATION-1a'],
      ['identity-as-repair', 'BELI-2026-03-15-IDENTITY-2b'],
    ]);
    const body = 'This extends notation-as-erasure and connects to identity-as-repair.';
    const selfId = 'BELI-2026-04-06-SOURCE-3c';

    const refs = extractConceptReferences(body, selfId, conceptMap);
    expect(refs).toHaveLength(2);
  });

  it('infers relation type from context', () => {
    const conceptMap = new Map([
      ['notation-as-erasure', 'BELI-2026-03-14-NOTATION-1a'],
    ]);
    const body = 'This belief extends notation-as-erasure into color perception.';
    const selfId = 'BELI-2026-04-06-SOURCE-2b';

    const refs = extractConceptReferences(body, selfId, conceptMap);
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe('extends');
  });

  it('defaults to related when no context words match', () => {
    const conceptMap = new Map([
      ['notation-as-erasure', 'BELI-2026-03-14-NOTATION-1a'],
    ]);
    const body = 'See also notation-as-erasure for more context.';
    const selfId = 'BELI-2026-04-06-SOURCE-2b';

    const refs = extractConceptReferences(body, selfId, conceptMap);
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe('related');
  });

  it('does not match partial concept names', () => {
    const conceptMap = new Map([
      ['notation-as-erasure', 'BELI-2026-03-14-NOTATION-1a'],
    ]);
    const body = 'This mentions notation-as but not the full concept.';
    const selfId = 'BELI-2026-04-06-SOURCE-2b';

    const refs = extractConceptReferences(body, selfId, conceptMap);
    expect(refs).toHaveLength(0);
  });

  it('does not confuse similar concept names', () => {
    const conceptMap = new Map([
      ['notation-as-erasure', 'BELI-2026-03-14-ERASURE-1a'],
      ['notation-as-discovery', 'BELI-2026-03-12-DISCOVERY-2b'],
    ]);
    const body = 'Only notation-as-discovery is mentioned here.';
    const selfId = 'BELI-2026-04-06-SOURCE-3c';

    const refs = extractConceptReferences(body, selfId, conceptMap);
    expect(refs).toHaveLength(1);
    expect(refs[0].targetId).toBe('BELI-2026-03-12-DISCOVERY-2b');
  });
});

// ---------------------------------------------------------------------------
// compileConceptPatterns + precompiled-pattern path (#117 regex hoist)
// ---------------------------------------------------------------------------

describe('compileConceptPatterns (regex hoist for #117)', () => {
  it('returns the same results as the Map-input path (behavioral parity)', () => {
    const conceptMap = new Map([
      ['notation-as-erasure', 'BELI-2026-03-14-NOTATION-1a'],
      ['identity-as-repair', 'BELI-2026-03-15-IDENTITY-2b'],
      ['desire-paths', 'BELI-2026-03-16-DESIRE-3c'],
    ]);
    const selfId = 'BELI-2026-04-06-SOURCE-9z';
    const bodies = [
      'This extends notation-as-erasure and connects to identity-as-repair.',
      'See desire-paths for more.',
      'The Notation-As-Erasure principle (case-insensitive).',
      'Underscore form: notation_as_erasure works too.',
      'Space form: identity as repair also matches.',
      'No matches in this body at all.',
      'Self-ref skipped, plus desire-paths counted once even when mentioned twice: desire-paths.',
    ];

    const patterns = compileConceptPatterns(conceptMap);
    for (const body of bodies) {
      const fromMap = extractConceptReferences(body, selfId, conceptMap);
      const fromPatterns = extractConceptReferences(body, selfId, patterns);
      expect(fromPatterns).toEqual(fromMap);
    }
  });

  it('precompiled patterns are safely reusable across many bodies (lastIndex reset)', () => {
    const conceptMap = new Map([
      ['notation-as-erasure', 'BELI-2026-03-14-NOTATION-1a'],
    ]);
    const patterns = compileConceptPatterns(conceptMap);
    const selfId = 'BELI-2026-04-06-SOURCE-2b';

    // Run the same precompiled pattern set against 5 different bodies.
    // Without the lastIndex reset inside extractConceptReferences, the
    // /g flag's state would leak between calls and cause misses.
    for (let i = 0; i < 5; i++) {
      const refs = extractConceptReferences(
        'Body mentions notation-as-erasure here.',
        selfId,
        patterns,
      );
      expect(refs).toHaveLength(1);
      expect(refs[0].targetId).toBe('BELI-2026-03-14-NOTATION-1a');
    }
  });

  it('compileConceptPatterns + relinkAtom matches Map-form relinkAtom output', () => {
    const conceptMap = new Map([
      ['notation-as-erasure', 'BELI-2026-03-14-NOTATION-1a'],
      ['identity-as-repair', 'BELI-2026-03-15-IDENTITY-2b'],
    ]);
    const patterns = compileConceptPatterns(conceptMap);
    const atom: Atom = {
      frontmatter: {
        id: 'BELI-2026-04-06-SOURCE-9z',
        type: 'belief',
        slug: 'source',
        created_at: '2026-04-06T00:00:00.000Z',
        updated_at: '2026-04-06T00:00:00.000Z',
        status: 'draft',
        confidence: 0.5,
        scope: 'PUBLIC',
        tags: [],
        ttl_days: 0,
        provenance: { episodes: [], evidence: [] },
        links: { related: [] },
      } as AtomFrontmatter,
      body: 'This extends notation-as-erasure and connects to identity-as-repair.',
    };
    const knownIds = new Set<string>();

    const fromMap = relinkAtom(atom, knownIds, conceptMap);
    const fromPatterns = relinkAtom(atom, knownIds, patterns);
    expect(fromPatterns).toEqual(fromMap);
  });
});

// ---------------------------------------------------------------------------
// relinkAtom with concept map
// ---------------------------------------------------------------------------

describe('relinkAtom with concept map', () => {
  it('proposes concept-name relations alongside atom-ID relations', () => {
    // Create two targets
    const t1 = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'notation-as-erasure', body: 'A lens for analysis.',
    });
    const t2 = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'identity-as-repair', body: 'Identity is the repair process.',
    });

    // Create source that references both: one by atom ID, one by concept name
    const source = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'test-source',
      body: 'No refs yet.',
    });

    // Patch body to include references (bypassing auto-relink)
    const atom = readAtom(source.filePath!);
    atom.body = `This extends ${t1.frontmatter.id} and connects to identity-as-repair.`;
    atom.frontmatter.relations = []; // clear any auto-relink results
    writeAtom(atom, source.filePath!);
    indexAtom(testDir, { ...atom, filePath: source.filePath });

    const knownIds = new Set([t1.frontmatter.id, t2.frontmatter.id, source.frontmatter.id]);
    const conceptMap = buildConceptMap([t1, t2, source]);

    const proposed = relinkAtom(atom, knownIds, conceptMap);

    // Should find both: t1 via atom ID and t2 via concept name
    expect(proposed.length).toBeGreaterThanOrEqual(2);
    expect(proposed.some(p => p.targetId === t1.frontmatter.id)).toBe(true);
    expect(proposed.some(p => p.targetId === t2.frontmatter.id)).toBe(true);
  });

  it('deduplicates when both atom-ID and concept-name match same target', () => {
    const target = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'notation-as-erasure', body: 'A lens.',
    });

    const source = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'test-dedup',
      body: 'No refs yet.',
    });

    // Body has both atom ID AND concept name for same target
    const atom = readAtom(source.filePath!);
    atom.body = `Extends ${target.frontmatter.id}. Also extends notation-as-erasure.`;
    atom.frontmatter.relations = [];
    writeAtom(atom, source.filePath!);
    indexAtom(testDir, { ...atom, filePath: source.filePath });

    const knownIds = new Set([target.frontmatter.id, source.frontmatter.id]);
    const conceptMap = buildConceptMap([target, source]);

    const proposed = relinkAtom(atom, knownIds, conceptMap);

    // Should only have ONE relation to target (deduplicated)
    const targetRefs = proposed.filter(p => p.targetId === target.frontmatter.id);
    expect(targetRefs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// relinkAll with concept names
// ---------------------------------------------------------------------------

describe('relinkAll with concept names', () => {
  it('finds concept-name relations in batch mode', () => {
    const target = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'notation-as-erasure', body: 'A lens for analysis.',
    });

    const source = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'batch-concept-source',
      body: 'No refs yet.',
    });

    // Patch body to reference by concept name
    const atom = readAtom(source.filePath!);
    atom.body = 'This extends notation-as-erasure into new territory.';
    atom.frontmatter.relations = [];
    writeAtom(atom, source.filePath!);
    indexAtom(testDir, { ...atom, filePath: source.filePath });

    const result = relinkAll(testDir, { dryRun: true });
    expect(result.proposed.some(
      p => p.sourceId === source.frontmatter.id && p.targetId === target.frontmatter.id,
    )).toBe(true);
  });

  it('applies concept-name relations to disk', () => {
    const target = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'identity-as-repair', body: 'Identity is repair.',
    });

    const source = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'apply-concept-source',
      body: 'No refs yet.',
    });

    // Patch body
    const atom = readAtom(source.filePath!);
    atom.body = 'This confirms identity-as-repair through new evidence.';
    atom.frontmatter.relations = [];
    writeAtom(atom, source.filePath!);
    indexAtom(testDir, { ...atom, filePath: source.filePath });

    const result = relinkAll(testDir, { dryRun: false });
    expect(result.applied).toBeGreaterThan(0);

    // Verify on disk
    const updated = readAtom(source.filePath!);
    expect(updated.frontmatter.relations).toBeDefined();
    expect(updated.frontmatter.relations!.some(
      r => r.target === target.frontmatter.id,
    )).toBe(true);
  });

  it('is idempotent with concept-name relations', () => {
    const target = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'notation-as-erasure', body: 'A lens.',
    });

    const source = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'idem-concept-source',
      body: 'No refs yet.',
    });

    const atom = readAtom(source.filePath!);
    atom.body = 'See notation-as-erasure for context.';
    atom.frontmatter.relations = [];
    writeAtom(atom, source.filePath!);
    indexAtom(testDir, { ...atom, filePath: source.filePath });

    relinkAll(testDir, { dryRun: false });
    const secondRun = relinkAll(testDir, { dryRun: true });
    expect(secondRun.proposed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createAtom auto-relink with concept names
// ---------------------------------------------------------------------------

describe('createAtom auto-relink with concept names', () => {
  it('auto-creates concept-name relations at remember-time', () => {
    // Create a target atom first
    const target = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'notation-as-erasure',
      body: 'A lens for analyzing formal systems.',
    });

    // Create a new atom whose body mentions the target by concept name
    const source = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'new-belief-using-lens',
      body: 'This extends notation-as-erasure into the domain of music.',
    });

    // Read back — should have auto-created relation
    const onDisk = readAtom(source.filePath!);
    expect(onDisk.frontmatter.relations).toBeDefined();
    expect(onDisk.frontmatter.relations!.some(
      r => r.target === target.frontmatter.id && r.type === 'extends',
    )).toBe(true);

    // Also verify in index
    const { outbound } = getRelationsForAtom(testDir, source.frontmatter.id);
    expect(outbound.some(
      r => r.target_id === target.frontmatter.id && r.relation_type === 'extends',
    )).toBe(true);
  });

  it('does not auto-relink concept names when explicit relations provided', () => {
    const t1 = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'explicit-target-one', body: 'Target 1',
    });
    const t2 = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'notation-as-erasure', body: 'A lens.',
    });

    // Create with explicit relation to t1 and body reference to t2 by concept name
    const source = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'explicit-with-concept',
      body: 'See notation-as-erasure for context.',
      relations: [{ target: t1.frontmatter.id, type: 'supports' }],
    });

    // Should have the explicit relation but NOT auto-relink t2
    const onDisk = readAtom(source.filePath!);
    expect(onDisk.frontmatter.relations).toHaveLength(1);
    expect(onDisk.frontmatter.relations![0].target).toBe(t1.frontmatter.id);
  });
});
