/**
 * Concept-name citation extraction — tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  initMemoryDir,
  createAtom,
  reindex,
  closeAllIndexes,
} from '../src/index.js';
import {
  deriveConceptNames,
  extractCitations,
  indexCitations,
} from '../src/citations.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-citations-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

const base = (dir: string) => ({
  memoryDir: dir,
  agent_id: 'test',
  session_id: 'test-session',
});

describe('deriveConceptNames', () => {
  it('should extract concept name from standard atom ID', () => {
    const names = deriveConceptNames('BELI-2026-03-14-NOTATION-AS-ERASURE-1abc');
    expect(names).toContain('notation-as-erasure');
  });

  it('should extract short concept name from long slugs', () => {
    const names = deriveConceptNames('BELI-2026-03-22-THE-TWO-TIER-PATTERN-IS-NOT-ANALOGY-1z');
    expect(names).toContain('the-two-tier-pattern-is-not-analogy');
    // Should also have a shorter variant
    expect(names.some(n => n.startsWith('the-two-tier'))).toBe(true);
  });

  it('should return empty for malformed IDs', () => {
    expect(deriveConceptNames('SHORT')).toEqual([]);
    expect(deriveConceptNames('')).toEqual([]);
  });

  it('should lowercase concept names', () => {
    const names = deriveConceptNames('FACT-2026-03-09-GITHUB-SETUP-1a');
    for (const name of names) {
      expect(name).toBe(name.toLowerCase());
    }
  });
});

describe('extractCitations', () => {
  it('should find concept-name citations between atoms', () => {
    // Create a target atom with a recognizable slug
    createAtom({
      ...base(testDir),
      type: 'belief',
      slug: 'notation-as-erasure',
      body: 'Notation systems are engines of erasure.',
      scope: { tags: ['philosophy'] },
    });

    // Create a source atom that references the concept name
    createAtom({
      ...base(testDir),
      type: 'belief',
      slug: 'desire-paths',
      body: 'This extends notation-as-erasure into the physical world. The paved path erases desire paths.',
      scope: { tags: ['philosophy'] },
    });

    const citations = extractCitations(testDir);
    expect(citations.length).toBeGreaterThan(0);

    // The source should cite the target by concept name
    const citation = citations.find(c =>
      c.targetId.toLowerCase().includes('notation-as-erasure') &&
      c.sourceId.toLowerCase().includes('desire-paths')
    );
    expect(citation).toBeDefined();
    expect(citation!.type).toBe('concept_name');
    expect(citation!.count).toBeGreaterThanOrEqual(1);
  });

  it('should not count self-citations', () => {
    createAtom({
      ...base(testDir),
      type: 'belief',
      slug: 'self-referential',
      body: 'This belief about self-referential systems is self-referential.',
      scope: { tags: ['meta'] },
    });

    const citations = extractCitations(testDir);
    const selfCites = citations.filter(c => c.sourceId === c.targetId);
    expect(selfCites).toEqual([]);
  });

  it('should count multiple mentions', () => {
    createAtom({
      ...base(testDir),
      type: 'belief',
      slug: 'two-tier',
      body: 'The two-tier pattern.',
    });

    createAtom({
      ...base(testDir),
      type: 'belief',
      slug: 'applies-two-tier',
      body: 'The two-tier pattern appears in accounting. The two-tier architecture also appears in caching. And the two-tier approach generalizes further.',
    });

    const citations = extractCitations(testDir);
    const cite = citations.find(c =>
      c.targetId.toLowerCase().includes('two-tier') &&
      !c.targetId.toLowerCase().includes('applies')
    );
    expect(cite).toBeDefined();
    expect(cite!.count).toBeGreaterThanOrEqual(3);
  });

  it('should match hyphenated and space-separated forms', () => {
    createAtom({
      ...base(testDir),
      type: 'belief',
      slug: 'identity-repair',
      body: 'Identity is repair.',
    });

    createAtom({
      ...base(testDir),
      type: 'belief',
      slug: 'cites-with-spaces',
      body: 'The concept of identity repair is central to this framework.',
    });

    const citations = extractCitations(testDir);
    const cite = citations.find(c =>
      c.targetId.toLowerCase().includes('identity-repair') &&
      c.sourceId.toLowerCase().includes('cites-with-spaces')
    );
    expect(cite).toBeDefined();
  });
});

describe('indexCitations', () => {
  it('should store citations in SQLite', () => {
    createAtom({
      ...base(testDir),
      type: 'belief',
      slug: 'target-concept',
      body: 'A target concept.',
    });

    createAtom({
      ...base(testDir),
      type: 'belief',
      slug: 'source-concept',
      body: 'This references target-concept in the body text.',
    });

    reindex(testDir);
    const result = indexCitations(testDir);

    expect(result.total).toBeGreaterThan(0);
    expect(result.byType.concept_name).toBeGreaterThan(0);
    expect(result.uniqueTargets).toBeGreaterThan(0);
    expect(result.topCited.length).toBeGreaterThan(0);
  });

  it('should be idempotent', () => {
    createAtom({
      ...base(testDir),
      type: 'fact',
      slug: 'stable-fact',
      body: 'A stable fact.',
    });

    createAtom({
      ...base(testDir),
      type: 'belief',
      slug: 'citer',
      body: 'References stable-fact here.',
    });

    reindex(testDir);
    const result1 = indexCitations(testDir);
    const result2 = indexCitations(testDir);

    expect(result1.total).toBe(result2.total);
    expect(result1.byType).toEqual(result2.byType);
  });

  it('should count atom-ID citations too', () => {
    const target = createAtom({
      ...base(testDir),
      type: 'belief',
      slug: 'atom-id-target',
      body: 'Target for ID citation.',
    });

    createAtom({
      ...base(testDir),
      type: 'belief',
      slug: 'atom-id-source',
      body: `This references ${target.frontmatter.id} by atom ID.`,
    });

    reindex(testDir);
    const result = indexCitations(testDir);

    expect(result.byType.atom_id).toBeGreaterThan(0);
  });

  it('should return empty result for empty memory', () => {
    reindex(testDir);
    const result = indexCitations(testDir);
    expect(result.total).toBe(0);
    expect(result.uniqueTargets).toBe(0);
  });
});
