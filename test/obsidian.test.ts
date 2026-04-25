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
import { serializeAtom, parseAtom } from '../src/format.js';
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
    expect(result).toContain('**extends**');
    expect(result).toContain('- [[BELI-2026-01-01-FOO-abc]]');
    expect(result).toContain('- [[BELI-2026-01-01-BAZ-ghi]]');
    expect(result).toContain('**supports**');
    expect(result).toContain('- [[FACT-2026-01-01-BAR-def]]');
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

    // Each group should have a path: prefix query
    for (const group of groups) {
      expect(group.query).toMatch(/^path:/);
      expect(group.color.a).toBe(1);
      expect(typeof group.color.rgb).toBe('number');
    }
  });

  it('uses 4-char prefixes in path queries', () => {
    const config = generateGraphConfig() as Record<string, unknown>;
    const groups = config.colorGroups as { query: string }[];
    const queries = groups.map((g) => g.query);
    expect(queries).toContain('path:BELI');
    expect(queries).toContain('path:FACT');
    expect(queries).toContain('path:DECI');
    expect(queries).toContain('path:OPEN');
    expect(queries).toContain('path:PREF');
    expect(queries).toContain('path:CONS');
    expect(queries).toContain('path:PROC');
    expect(queries).toContain('path:ENTS');
    expect(queries).toContain('path:CONF');
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
