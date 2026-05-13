import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { EntityTriple } from '../src/types.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initMemoryDir, openIndex, closeAllIndexes } from '../src/index.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-triples-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('EntityTriple type', () => {
  it('accepts a well-formed triple', () => {
    const t: EntityTriple = {
      atom_id: 'FACT-2026-05-13-CAPITAL-abc12',
      subject: 'France',
      predicate: 'has_capital',
      object: 'Paris',
      confidence: 0.95,
      created_at: '2026-05-13T00:00:00Z',
    };
    expect(t.subject).toBe('France');
    expect(t.predicate).toBe('has_capital');
    expect(t.object).toBe('Paris');
  });
});

describe('entity_triples schema', () => {
  it('creates entity_triples table on first open', () => {
    const db = openIndex(testDir);
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='entity_triples'",
    ).get();
    expect(row).toBeDefined();
  });

  it('entity_triples has expected columns', () => {
    const db = openIndex(testDir);
    const cols = db.prepare("PRAGMA table_info('entity_triples')").all() as { name: string }[];
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(['atom_id', 'confidence', 'created_at', 'object', 'predicate', 'subject', 'triple_id']);
  });

  it('schema version is 8', () => {
    const db = openIndex(testDir);
    const ver = db.pragma('user_version', { simple: true }) as number;
    expect(ver).toBe(8);
  });
});
