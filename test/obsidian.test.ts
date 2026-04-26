/**
 * Tests for Obsidian-native atom compatibility.
 *
 * Covers:
 * - renderRelationsSection / stripRelationsSection pure functions
 * - Round-trip: serialize → parse preserves body without relations pollution
 * - serializeAtom includes ## Relations wikilinks when relations exist
 * - generateGraphConfig structure
 * - mk obsidian-init CLI (graph.json + --sync)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  renderRelationsSection,
  stripRelationsSection,
  RELATIONS_SENTINEL,
  generateGraphConfig,
  TYPE_COLORS,
} from '../src/obsidian.js';
import { serializeAtom, parseAtom, normalizeTags } from '../src/format.js';
import { initMemoryDir, listAtoms } from '../src/store.js';
import { createAtom } from '../src/retain.js';
import { closeAllIndexes } from '../src/index-db.js';
import type { Atom, Relation } from '../src/types.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-obsidian-test-'));
});

afterEach(async () => {
  await closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

// --- Pure functions ---

describe('renderRelationsSection', () => {
  it('returns empty string when no relations', () => {
    expect(renderRelationsSection(undefined)).toBe('');
    expect(renderRelationsSection([])).toBe('');
  });

  it('renders relations as wikilinks grouped by type', () => {
    const relations: Relation[] = [
      { type: 'extends', target: 'BELI-2026-01-01-FOO-abc' },
      { type: 'supports', target: 'FACT-2026-01-01-BAR-def' },
      { type: 'extends', target: 'BELI-2026-01-01-BAZ-ghi' },
    ];
    const result = renderRelationsSection(relations);

    expect(result).toContain(RELATIONS_SENTINEL);
    expect(result).toContain('## Relations');
    expect(result).toContain('- extends [[BELI-2026-01-01-FOO-abc]]');
    expect(result).toContain('- extends [[BELI-2026-01-01-BAZ-ghi]]');
    expect(result).toContain('- supports [[FACT-2026-01-01-BAR-def]]');
  });

  it('deduplicates targets within the same type', () => {
    const relations: Relation[] = [
      { type: 'extends', target: 'BELI-2026-01-01-FOO-abc' },
      { type: 'extends', target: 'BELI-2026-01-01-FOO-abc' },
    ];
    const result = renderRelationsSection(relations);
    const matches = result.match(/\[\[BELI-2026-01-01-FOO-abc\]\]/g);
    expect(matches).toHaveLength(1);
  });

  it('sorts targets alphabetically within a type group', () => {
    const relations: Relation[] = [
      { type: 'extends', target: 'BELI-ZZZ' },
      { type: 'extends', target: 'BELI-AAA' },
    ];
    const result = renderRelationsSection(relations);
    const zIdx = result.indexOf('BELI-ZZZ');
    const aIdx = result.indexOf('BELI-AAA');
    expect(aIdx).toBeLessThan(zIdx);
  });
});

describe('stripRelationsSection', () => {
  it('returns body unchanged when no sentinel present', () => {
    const body = 'Some text here.\n\nMore text.';
    expect(stripRelationsSection(body)).toBe(body);
  });

  it('strips everything from sentinel to end', () => {
    const body = `Some real body content.\n\n${RELATIONS_SENTINEL}\n## Relations\n\n**extends**\n- [[FOO]]`;
    expect(stripRelationsSection(body)).toBe('Some real body content.');
  });

  it('trims trailing whitespace before sentinel', () => {
    const body = `Body.\n\n\n${RELATIONS_SENTINEL}\n## Relations`;
    expect(stripRelationsSection(body)).toBe('Body.');
  });
});

// --- Round-trip: serialize → parse ---

describe('serializeAtom / parseAtom round-trip', () => {
  const makeAtom = (relations?: Relation[]): Atom => ({
    frontmatter: {
      id: 'BELI-2026-01-01-TEST-abc',
      type: 'belief',
      status: 'active',
      confidence: 0.8,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      ttl_days: null,
      relations,
    },
    body: 'This is the body of the belief.\n\nIt has multiple paragraphs.',
  });

  it('atom without relations round-trips cleanly', () => {
    const atom = makeAtom();
    const serialized = serializeAtom(atom);
    const parsed = parseAtom(serialized);

    expect(parsed.body).toBe(atom.body.trim());
    expect(parsed.frontmatter.id).toBe(atom.frontmatter.id);
    // No relations section in output
    expect(serialized).not.toContain(RELATIONS_SENTINEL);
  });

  it('atom with relations includes wikilinks in serialized output', () => {
    const relations: Relation[] = [
      { type: 'extends', target: 'BELI-2026-01-01-OTHER-xyz' },
    ];
    const atom = makeAtom(relations);
    const serialized = serializeAtom(atom);

    // File on disk has wikilinks
    expect(serialized).toContain(RELATIONS_SENTINEL);
    expect(serialized).toContain('## Relations');
    expect(serialized).toContain('[[BELI-2026-01-01-OTHER-xyz]]');
  });

  it('relations section is stripped on parse — never pollutes atom.body', () => {
    const relations: Relation[] = [
      { type: 'extends', target: 'BELI-2026-01-01-OTHER-xyz' },
      { type: 'contradicts', target: 'BELI-2026-01-01-CONTRA-def' },
    ];
    const atom = makeAtom(relations);
    const serialized = serializeAtom(atom);
    const parsed = parseAtom(serialized);

    // Body should NOT contain any of the relations section
    expect(parsed.body).not.toContain(RELATIONS_SENTINEL);
    expect(parsed.body).not.toContain('## Relations');
    expect(parsed.body).not.toContain('[[');
    expect(parsed.body).toBe(atom.body.trim());
  });

  it('multiple serialize-parse cycles are stable (idempotent)', () => {
    const relations: Relation[] = [
      { type: 'extends', target: 'BELI-2026-01-01-OTHER-xyz' },
    ];
    const atom = makeAtom(relations);

    // Round-trip 1
    const s1 = serializeAtom(atom);
    const p1 = parseAtom(s1);
    // Round-trip 2: re-serialize the parsed atom (with frontmatter including relations)
    const s2 = serializeAtom(p1);
    const p2 = parseAtom(s2);

    expect(s1).toBe(s2);
    expect(p1.body).toBe(p2.body);
  });
});

// --- generateGraphConfig ---

describe('generateGraphConfig', () => {
  it('returns valid config with colorGroups for all atom types', () => {
    const config = generateGraphConfig() as Record<string, unknown>;
    expect(config).toHaveProperty('colorGroups');
    const groups = config.colorGroups as { query: string; color: { a: number; rgb: number } }[];
    expect(groups.length).toBe(9); // 9 atom types

    // Each group should have a file: prefix query
    for (const group of groups) {
      expect(group.query).toMatch(/^file:/);
      expect(group.color.a).toBe(1);
      expect(typeof group.color.rgb).toBe('number');
    }
  });

  it('uses 4-char prefixes in path queries', () => {
    const config = generateGraphConfig() as Record<string, unknown>;
    const groups = config.colorGroups as { query: string }[];
    const queries = groups.map((g) => g.query);
    expect(queries).toContain('file:BELI');
    expect(queries).toContain('file:FACT');
    expect(queries).toContain('file:DECI');
    expect(queries).toContain('file:OPEN');
    expect(queries).toContain('file:PREF');
    expect(queries).toContain('file:CONS');
    expect(queries).toContain('file:PROC');
    expect(queries).toContain('file:ENTS');
    expect(queries).toContain('file:CONF');
  });
});

// --- Integration: write atom to disk, read back ---

describe('integration: atom files on disk are Obsidian-ready', () => {
  it('atom written with relations has wikilinks in the file', () => {
    initMemoryDir(testDir);
    createAtom({
      memoryDir: testDir,
      type: 'belief',
      slug: 'test-belief',
      body: 'Test belief body.',
      agent_id: 'test-agent',
      session_id: 'test-session',
      relations: [
        { type: 'extends', target: 'FACT-2026-01-01-OTHER-xyz' },
      ],
    });

    const atoms = listAtoms(testDir);
    expect(atoms.length).toBe(1);

    // Read raw file contents
    const rawContent = fs.readFileSync(atoms[0].filePath!, 'utf-8');
    expect(rawContent).toContain(RELATIONS_SENTINEL);
    expect(rawContent).toContain('[[FACT-2026-01-01-OTHER-xyz]]');

    // But the parsed body is clean
    expect(atoms[0].body).not.toContain(RELATIONS_SENTINEL);
    expect(atoms[0].body).not.toContain('[[');
  });

  it('atom written without relations has no sentinel in file', () => {
    initMemoryDir(testDir);
    createAtom({
      memoryDir: testDir,
      type: 'fact',
      slug: 'plain-fact',
      body: 'A plain fact.',
      agent_id: 'test-agent',
      session_id: 'test-session',
    });

    const atoms = listAtoms(testDir);
    const rawContent = fs.readFileSync(atoms[0].filePath!, 'utf-8');
    expect(rawContent).not.toContain(RELATIONS_SENTINEL);
  });
});

// --- Tag promotion / stripping ---

describe('tag promotion and stripping', () => {
  const makeAtomWithTags = (tags: string[]): Atom => ({
    frontmatter: {
      id: 'BELI-2026-01-01-TAG-TEST-abc',
      type: 'belief',
      status: 'active',
      confidence: 0.8,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      scope: { tags },
    },
    body: 'Tag test body.',
  });

  it('promotes scope.tags to top-level tags in serialized output', () => {
    const atom = makeAtomWithTags(['philosophy', 'identity']);
    const serialized = serializeAtom(atom);
    // Top-level tags should appear in the YAML
    expect(serialized).toMatch(/^tags:/m);
    // scope.tags should also still be present inside scope
    expect(serialized).toContain('scope:');
  });

  it('places top-level tags BEFORE scope in YAML output', () => {
    const atom = makeAtomWithTags(['test-tag']);
    const serialized = serializeAtom(atom);
    const tagsIdx = serialized.indexOf('\ntags:');
    const scopeIdx = serialized.indexOf('\nscope:');
    expect(tagsIdx).toBeGreaterThan(-1);
    expect(scopeIdx).toBeGreaterThan(-1);
    expect(tagsIdx).toBeLessThan(scopeIdx);
  });

  it('strips promoted tags on parse — does not leak into frontmatter', () => {
    const atom = makeAtomWithTags(['philosophy', 'identity']);
    const serialized = serializeAtom(atom);
    const parsed = parseAtom(serialized);
    expect((parsed.frontmatter as Record<string, unknown>).tags).toBeUndefined();
    expect(parsed.frontmatter.scope?.tags).toEqual(expect.arrayContaining(['philosophy', 'identity']));
  });

  it('merges Obsidian-edited tags back into scope.tags on parse', () => {
    // Simulate what happens if a user adds a tag in Obsidian
    const yaml = [
      '---',
      'id: BELI-2026-01-01-TAG-TEST-abc',
      'type: belief',
      'status: active',
      'tags:',
      '  - philosophy',
      '  - identity',
      '  - new-tag-from-obsidian',
      'scope:',
      '  tags:',
      '    - philosophy',
      '    - identity',
      '---',
      '',
      'Body text.',
    ].join('\n');
    const parsed = parseAtom(yaml);
    expect(parsed.frontmatter.scope?.tags).toContain('new-tag-from-obsidian');
    expect(parsed.frontmatter.scope?.tags).toContain('philosophy');
    expect(parsed.frontmatter.scope?.tags).toContain('identity');
    expect((parsed.frontmatter as Record<string, unknown>).tags).toBeUndefined();
  });

  it('normalizes comma-separated tags into individual items', () => {
    const yaml = [
      '---',
      'id: BELI-2026-01-01-COMMA-TAGS-abc',
      'type: belief',
      'status: active',
      'scope:',
      '  tags:',
      '    - "storytelling,amvf,memory-validation"',
      '---',
      '',
      'Body text.',
    ].join('\n');
    const parsed = parseAtom(yaml);
    expect(parsed.frontmatter.scope?.tags).toEqual(['amvf', 'memory-validation', 'storytelling']);
  });

  it('normalizeTags splits comma-separated and deduplicates', () => {
    expect(normalizeTags(['a,b,c'])).toEqual(['a', 'b', 'c']);
    expect(normalizeTags(['a', 'b,c', 'a'])).toEqual(['a', 'b', 'c']);
    expect(normalizeTags(['  x , y '])).toEqual(['x', 'y']);
    expect(normalizeTags([])).toEqual([]);
  });

  it('does not add tags field when scope.tags is empty', () => {
    const atom: Atom = {
      frontmatter: {
        id: 'BELI-2026-01-01-NOTAG-abc',
        type: 'belief',
        status: 'active',
        scope: { tags: [] },
      },
      body: 'No tags.',
    };
    const serialized = serializeAtom(atom);
    expect(serialized).not.toMatch(/^tags:/m);
  });
});

// --- TYPE_COLORS ---

describe('TYPE_COLORS', () => {
  it('has entries for all 9 atom types', () => {
    const expectedTypes = [
      'belief', 'fact', 'decision', 'open_question', 'preference',
      'constraint', 'procedure', 'entity_summary', 'conflict',
    ];
    for (const type of expectedTypes) {
      expect(TYPE_COLORS[type]).toBeDefined();
      expect(typeof TYPE_COLORS[type]).toBe('number');
    }
  });
});
