/**
 * Tests for mk import — markdown file → memory atoms.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  initMemoryDir,
  importFromFile,
  previewImport,
  readEventsByAction,
  listAtoms,
  closeAllIndexes,
} from '../src/index.js';
import { extractChunks } from '../src/import.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-import-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

// --- Fixture markdown content ---

const HEADING_FIXTURE = `
# Project Notes

## Architecture Decision

We decided to use SQLite for the index because it provides full-text search via FTS5.

## Constraint: No Network Calls

The system must never make outbound network requests during normal operation.

## Open Question

Why does the FTS ranking feel inconsistent for short queries?

## A Short Section

Too short.
`.trim();

const BULLET_FIXTURE = `
- We believe that atom IDs should be immutable once created
- The event log is the source of truth for all state
- Decisions should always be documented with rationale
`.trim();

const URL_FIXTURE = `
## Reference

See https://www.sqlite.org/fts5.html for FTS5 documentation.
`.trim();

const CODE_FIXTURE = `
## Usage

Call \`createAtom(opts)\` to create a new memory atom with the given options.
`.trim();

// --- Helper to write a temp fixture file ---
function writeTmp(content: string, ext = '.md'): string {
  const p = path.join(testDir, `fixture${ext}`);
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

// --- extractChunks unit tests ---

describe('extractChunks', () => {
  it('splits by H2 headings', () => {
    const chunks = extractChunks(HEADING_FIXTURE);
    // 3 substantial sections + "A Short Section" is too short → bullet fallback → empty
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });

  it('returns heading as chunk.heading', () => {
    const chunks = extractChunks(HEADING_FIXTURE);
    const first = chunks[0];
    expect(first.heading).toBe('Architecture Decision');
  });

  it('falls back to bullets when no headings found', () => {
    const chunks = extractChunks(BULLET_FIXTURE);
    expect(chunks.length).toBe(3);
    expect(chunks[0].body).toContain('atom IDs should be immutable');
  });

  it('treats whole content as one chunk as last resort', () => {
    const plain = 'This is a plain paragraph with no headings or bullets at all.';
    const chunks = extractChunks(plain);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].body).toBe(plain);
  });

  it('returns empty array for content shorter than MIN_CHUNK_LENGTH', () => {
    const chunks = extractChunks('short');
    expect(chunks).toHaveLength(0);
  });
});

// --- previewImport (dry-run) ---

describe('previewImport', () => {
  it('returns chunks without creating atoms', () => {
    const filePath = writeTmp(HEADING_FIXTURE);
    const chunks = previewImport(filePath);
    expect(chunks.length).toBeGreaterThan(0);

    // No atoms should have been created
    const atoms = listAtoms(testDir);
    expect(atoms).toHaveLength(0);
  });

  it('returns empty array for empty file', () => {
    const filePath = writeTmp('');
    const chunks = previewImport(filePath);
    expect(chunks).toHaveLength(0);
  });
});

// --- importFromFile ---

describe('importFromFile', () => {
  it('creates one atom per extracted heading section', () => {
    const filePath = writeTmp(HEADING_FIXTURE);
    const result = importFromFile({
      filePath,
      memoryDir: testDir,
      agent_id: 'test',
      session_id: 'test',
    });

    expect(result.atoms_created).toBeGreaterThanOrEqual(3);
    expect(result.atom_ids).toHaveLength(result.atoms_created);
    expect(result.source_file).toBe(filePath);
  });

  it('atoms appear in the atom store after import', () => {
    const filePath = writeTmp(HEADING_FIXTURE);
    const result = importFromFile({
      filePath,
      memoryDir: testDir,
      agent_id: 'test',
      session_id: 'test',
    });

    const atoms = listAtoms(testDir);
    expect(atoms).toHaveLength(result.atoms_created);
  });

  it('atoms appear in the event log as atom_created events', () => {
    const filePath = writeTmp(HEADING_FIXTURE);
    const result = importFromFile({
      filePath,
      memoryDir: testDir,
      agent_id: 'test',
      session_id: 'test',
    });

    const events = readEventsByAction(testDir, 'atom_created');
    expect(events).toHaveLength(result.atoms_created);
  });

  it('imports bullet-only files', () => {
    const filePath = writeTmp(BULLET_FIXTURE);
    const result = importFromFile({
      filePath,
      memoryDir: testDir,
      agent_id: 'test',
      session_id: 'test',
    });

    expect(result.atoms_created).toBe(3);
  });

  it('defaultType override sets type for all atoms', () => {
    const filePath = writeTmp(HEADING_FIXTURE);
    importFromFile({
      filePath,
      memoryDir: testDir,
      agent_id: 'test',
      session_id: 'test',
      defaultType: 'constraint',
    });

    const atoms = listAtoms(testDir);
    for (const atom of atoms) {
      expect(atom.frontmatter.type).toBe('constraint');
    }
  });

  it('defaultClassification sets classification for all atoms', () => {
    const filePath = writeTmp(HEADING_FIXTURE);
    importFromFile({
      filePath,
      memoryDir: testDir,
      agent_id: 'test',
      session_id: 'test',
      defaultClassification: 'PERSONAL',
    });

    const atoms = listAtoms(testDir);
    for (const atom of atoms) {
      expect(atom.frontmatter.classification).toBe('PERSONAL');
    }
  });

  it('defaults classification to TEAM when not specified', () => {
    const filePath = writeTmp(BULLET_FIXTURE);
    importFromFile({
      filePath,
      memoryDir: testDir,
      agent_id: 'test',
      session_id: 'test',
    });

    const atoms = listAtoms(testDir);
    for (const atom of atoms) {
      expect(atom.frontmatter.classification).toBe('TEAM');
    }
  });
});

// --- Type inference ---

describe('type inference', () => {
  it('infers decision type for "decided" keyword', () => {
    const content = '## Why SQLite\n\nWe decided to use SQLite for the index.';
    const filePath = writeTmp(content);
    importFromFile({ filePath, memoryDir: testDir, agent_id: 'a', session_id: 's' });

    const atoms = listAtoms(testDir);
    expect(atoms.some((a) => a.frontmatter.type === 'decision')).toBe(true);
  });

  it('infers constraint type for "must" keyword', () => {
    const content = '## No Outbound\n\nThe system must never make outbound network requests.';
    const filePath = writeTmp(content);
    importFromFile({ filePath, memoryDir: testDir, agent_id: 'a', session_id: 's' });

    const atoms = listAtoms(testDir);
    expect(atoms.some((a) => a.frontmatter.type === 'constraint')).toBe(true);
  });

  it('infers open_question type for "question" keyword', () => {
    const content = '## Investigation\n\nOpen question: why does the ranking feel inconsistent?';
    const filePath = writeTmp(content);
    importFromFile({ filePath, memoryDir: testDir, agent_id: 'a', session_id: 's' });

    const atoms = listAtoms(testDir);
    expect(atoms.some((a) => a.frontmatter.type === 'open_question')).toBe(true);
  });

  it('infers belief type for "believe" keyword', () => {
    const content = '- We believe that atom IDs should be immutable once created.';
    const filePath = writeTmp(content);
    importFromFile({ filePath, memoryDir: testDir, agent_id: 'a', session_id: 's' });

    const atoms = listAtoms(testDir);
    expect(atoms[0].frontmatter.type).toBe('belief');
  });

  it('defaults to fact type for plain prose', () => {
    const content = '## Notes\n\nSQLite stores data in a single file on disk.';
    const filePath = writeTmp(content);
    importFromFile({ filePath, memoryDir: testDir, agent_id: 'a', session_id: 's' });

    const atoms = listAtoms(testDir);
    expect(atoms[0].frontmatter.type).toBe('fact');
  });
});

// --- Confidence inference ---

describe('confidence inference', () => {
  it('assigns higher confidence (0.9) for URL-containing content', () => {
    const filePath = writeTmp(URL_FIXTURE);
    importFromFile({ filePath, memoryDir: testDir, agent_id: 'a', session_id: 's' });

    const atoms = listAtoms(testDir);
    expect(atoms[0].frontmatter.confidence).toBe(0.9);
  });

  it('assigns higher confidence (0.9) for inline code content', () => {
    const filePath = writeTmp(CODE_FIXTURE);
    importFromFile({ filePath, memoryDir: testDir, agent_id: 'a', session_id: 's' });

    const atoms = listAtoms(testDir);
    expect(atoms[0].frontmatter.confidence).toBe(0.9);
  });

  it('assigns lower confidence (0.5) for uncertain language', () => {
    const content = '- We probably should think about caching the index results.';
    const filePath = writeTmp(content);
    importFromFile({ filePath, memoryDir: testDir, agent_id: 'a', session_id: 's' });

    const atoms = listAtoms(testDir);
    expect(atoms[0].frontmatter.confidence).toBe(0.5);
  });
});
