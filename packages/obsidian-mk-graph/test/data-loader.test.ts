import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readVault, resolveMemoryDir } from '../src/data-loader.js';

const sampleAtom = (id: string) => `---
id: ${id}
type: fact
status: active
confidence: 0.9
created_at: "2026-04-29T10:00:00Z"
updated_at: "2026-04-29T10:00:00Z"
ttl_days: null
classification: TEAM
---

Body for ${id}.
`;

describe('readVault', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mk-graph-test-'));
    mkdirSync(path.join(dir, 'ENTITIES'), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('reads .md files from ENTITIES/ and returns ParsedAtoms', async () => {
    writeFileSync(
      path.join(dir, 'ENTITIES', 'FACT-2026-04-29-A-aa00.md'),
      sampleAtom('FACT-2026-04-29-A-aa00'),
    );
    writeFileSync(
      path.join(dir, 'ENTITIES', 'FACT-2026-04-29-B-bb00.md'),
      sampleAtom('FACT-2026-04-29-B-bb00'),
    );
    const atoms = await readVault(dir);
    expect(atoms).toHaveLength(2);
    expect(atoms.map((a) => a.id).sort()).toEqual([
      'FACT-2026-04-29-A-aa00',
      'FACT-2026-04-29-B-bb00',
    ]);
  });

  it('skips non-.md files and dotfiles', async () => {
    writeFileSync(path.join(dir, 'ENTITIES', '.hidden.md'), sampleAtom('X'));
    writeFileSync(path.join(dir, 'ENTITIES', 'README.txt'), 'not an atom');
    writeFileSync(
      path.join(dir, 'ENTITIES', 'FACT-2026-04-29-OK-aa00.md'),
      sampleAtom('FACT-2026-04-29-OK-aa00'),
    );
    const atoms = await readVault(dir);
    expect(atoms.map((a) => a.id)).toEqual(['FACT-2026-04-29-OK-aa00']);
  });

  it('silently skips malformed atoms', async () => {
    writeFileSync(path.join(dir, 'ENTITIES', 'broken.md'), '---\n[invalid yaml\n---\nbody\n');
    writeFileSync(
      path.join(dir, 'ENTITIES', 'FACT-2026-04-29-OK-aa00.md'),
      sampleAtom('FACT-2026-04-29-OK-aa00'),
    );
    const atoms = await readVault(dir);
    expect(atoms.map((a) => a.id)).toEqual(['FACT-2026-04-29-OK-aa00']);
  });

  it('returns empty array if ENTITIES/ is missing', async () => {
    rmSync(path.join(dir, 'ENTITIES'), { recursive: true });
    const atoms = await readVault(dir);
    expect(atoms).toEqual([]);
  });

  it('returns empty array when memoryDir/ENTITIES is a file, not a dir', async () => {
    rmSync(path.join(dir, 'ENTITIES'), { recursive: true });
    writeFileSync(path.join(dir, 'ENTITIES'), 'not a directory');
    const atoms = await readVault(dir);
    expect(atoms).toEqual([]);
  });
});

describe('resolveMemoryDir', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mk-graph-resolve-'));
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('returns base dir in shared mode (no agentId)', () => {
    expect(resolveMemoryDir(dir)).toBe(dir);
    expect(resolveMemoryDir(dir, '')).toBe(dir);
  });

  it('returns agents/<id>/ when it exists', () => {
    const agentDir = path.join(dir, 'agents', 'alice');
    mkdirSync(agentDir, { recursive: true });
    expect(resolveMemoryDir(dir, 'alice')).toBe(agentDir);
  });

  it('falls back to base dir when agents/<id>/ does not exist', () => {
    expect(resolveMemoryDir(dir, 'missing')).toBe(dir);
  });

  it('rejects path-traversal-shaped agent IDs and falls back to base', () => {
    // Even if a hostile-looking agent dir happens to exist on disk, the
    // resolver should not route to it because the input id is suspicious.
    mkdirSync(path.join(dir, 'agents', 'evil'), { recursive: true });
    expect(resolveMemoryDir(dir, '../escape')).toBe(dir);
    expect(resolveMemoryDir(dir, '..\\escape')).toBe(dir);
    expect(resolveMemoryDir(dir, '..')).toBe(dir);
    expect(resolveMemoryDir(dir, '.')).toBe(dir);
    expect(resolveMemoryDir(dir, 'sub/dir')).toBe(dir);
  });
});
