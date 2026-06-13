/**
 * Tests for the atom-frontmatter doctor check (#227).
 *
 * Covers: broken relation refs, id/filename mismatch, duplicate ids,
 * and stale <!-- mk:relations --> section warnings.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { initMemoryDir, closeAllIndexes } from '../src/index.js';
import { atomFrontmatterCheck } from '../src/doctor/checks/atom-frontmatter.js';
import type { CheckResult, DoctorContext } from '../src/doctor/types.js';

let testDir: string;

function ctx(): DoctorContext {
  return {
    memoryDir: testDir,
    kernelVersion: '1.0.0',
    skipCategories: new Set(),
    env: {},
  };
}

async function run(): Promise<CheckResult> {
  const r = atomFrontmatterCheck.run(ctx());
  return r instanceof Promise ? await r : r;
}

const NOW = '2026-05-24T00:00:00.000Z';

function validFm(id: string): string {
  return [
    `id: ${id}`,
    `type: fact`,
    `status: active`,
    `confidence: 0.9`,
    `created_at: "${NOW}"`,
    `updated_at: "${NOW}"`,
    `ttl_days: null`,
    `classification: TEAM`,
    '',
  ].join('\n');
}

function writeAtomFile(dir: string, filename: string, frontmatterYaml: string, body = ''): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, `---\n${frontmatterYaml}---\n${body}\n`);
  return filePath;
}

function entitiesDir(): string {
  return path.join(testDir, 'ENTITIES');
}

function archiveDir(): string {
  return path.join(testDir, 'ARCHIVE');
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-doctor-frontmatter-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Clean store
// ---------------------------------------------------------------------------

describe('atomFrontmatterCheck — clean store', () => {
  it('returns ok=true on empty ENTITIES', async () => {
    const r = await run();
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  it('returns ok=true for a single valid atom', async () => {
    const id = 'FACT-2026-05-24-valid-1abcd';
    writeAtomFile(entitiesDir(), `${id}.md`, validFm(id));
    const r = await run();
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  it('returns ok=true for valid atom with relations pointing to existing atom', async () => {
    const idA = 'FACT-2026-05-24-atom-a-1abcd';
    const idB = 'FACT-2026-05-24-atom-b-2abcd';
    const fmA = validFm(idA) + `relations:\n  - target: ${idB}\n    type: extends\n`;
    writeAtomFile(entitiesDir(), `${idA}.md`, fmA);
    writeAtomFile(entitiesDir(), `${idB}.md`, validFm(idB));
    const r = await run();
    expect(r.ok).toBe(true);
  });

  it('returns ok=true for relation pointing to an ARCHIVE atom', async () => {
    const idA = 'FACT-2026-05-24-main-1abcd';
    const idB = 'FACT-2026-05-24-archived-2abcd';
    const fmA = validFm(idA) + `relations:\n  - target: ${idB}\n    type: supersedes\n`;
    writeAtomFile(entitiesDir(), `${idA}.md`, fmA);
    writeAtomFile(archiveDir(), `${idB}.md`, validFm(idB));
    const r = await run();
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Broken relation refs
// ---------------------------------------------------------------------------

describe('atomFrontmatterCheck — broken relation refs', () => {
  it('reports error for a relation pointing to a non-existent atom', async () => {
    const id = 'BELI-2026-05-24-with-bad-ref-1abcd';
    const fm = validFm(id) + `relations:\n  - target: BELI-2026-01-01-does-not-exist-xxxxx\n    type: extends\n`;
    writeAtomFile(entitiesDir(), `${id}.md`, fm);
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.severity).toBe('error');
    expect(r.issues.some((i) => i.includes('broken-relation-ref') && i.includes('BELI-2026-01-01-does-not-exist-xxxxx'))).toBe(true);
  });

  it('reports one error per broken ref (multiple broken refs)', async () => {
    const id = 'BELI-2026-05-24-two-bad-refs-1abcd';
    const fm =
      validFm(id) +
      `relations:\n  - target: MISSING-A-1\n    type: extends\n  - target: MISSING-B-2\n    type: related\n`;
    writeAtomFile(entitiesDir(), `${id}.md`, fm);
    const r = await run();
    expect(r.issues.filter((i) => i.includes('broken-relation-ref'))).toHaveLength(2);
  });

  it('does NOT flag a relation to a valid ENTITIES atom', async () => {
    const idA = 'FACT-2026-05-24-source-1aaaa';
    const idB = 'FACT-2026-05-24-target-2bbbb';
    const fmA = validFm(idA) + `relations:\n  - target: ${idB}\n    type: related\n`;
    writeAtomFile(entitiesDir(), `${idA}.md`, fmA);
    writeAtomFile(entitiesDir(), `${idB}.md`, validFm(idB));
    const r = await run();
    expect(r.issues.filter((i) => i.includes('broken-relation-ref'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ID / filename mismatch
// ---------------------------------------------------------------------------

describe('atomFrontmatterCheck — id/filename mismatch', () => {
  it('reports error when filename does not match frontmatter id', async () => {
    const frontmatterId = 'FACT-2026-05-24-real-id-1abcd';
    const wrongFilename = 'FACT-2026-05-24-wrong-name-1abcd.md';
    writeAtomFile(entitiesDir(), wrongFilename, validFm(frontmatterId));
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.includes('id-mismatch'))).toBe(true);
  });

  it('does NOT report mismatch when filename matches id exactly', async () => {
    const id = 'FACT-2026-05-24-match-1abcd';
    writeAtomFile(entitiesDir(), `${id}.md`, validFm(id));
    const r = await run();
    expect(r.issues.filter((i) => i.includes('id-mismatch'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Duplicate IDs
// ---------------------------------------------------------------------------

describe('atomFrontmatterCheck — duplicate ids', () => {
  it('reports error when two files declare the same id', async () => {
    const sharedId = 'FACT-2026-05-24-shared-1abcd';
    writeAtomFile(entitiesDir(), `${sharedId}.md`, validFm(sharedId));
    // Second file with a different filename but same id in frontmatter
    writeAtomFile(entitiesDir(), `FACT-2026-05-24-shared-2xxxx.md`, validFm(sharedId));
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.includes('duplicate-id') && i.includes(sharedId))).toBe(true);
  });

  it('does NOT report duplicate when all ids are unique', async () => {
    writeAtomFile(entitiesDir(), 'FACT-2026-05-24-one-1aaaa.md', validFm('FACT-2026-05-24-one-1aaaa'));
    writeAtomFile(entitiesDir(), 'FACT-2026-05-24-two-2bbbb.md', validFm('FACT-2026-05-24-two-2bbbb'));
    const r = await run();
    expect(r.issues.filter((i) => i.includes('duplicate-id'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Per-agent isolation: shared-namespace refs are valid
// ---------------------------------------------------------------------------

describe('atomFrontmatterCheck — isolation shared refs', () => {
  it('does NOT flag a relation pointing to an atom in the shared namespace', async () => {
    // Simulate the baseDir/agents/<id> + baseDir/shared isolation layout.
    const agentDir = path.join(testDir, 'agents', 'alice');
    const idA = 'FACT-2026-05-24-agent-atom-1abcd';
    const idShared = 'FACT-2026-05-24-shared-atom-2bbbb';
    const fmA = validFm(idA) + `relations:\n  - target: ${idShared}\n    type: supports\n`;
    writeAtomFile(path.join(agentDir, 'ENTITIES'), `${idA}.md`, fmA);
    writeAtomFile(path.join(testDir, 'shared', 'ENTITIES'), `${idShared}.md`, validFm(idShared));

    const r = atomFrontmatterCheck.run({
      memoryDir: agentDir,
      kernelVersion: '1.0.0',
      skipCategories: new Set(),
      env: {},
    });
    const result = r instanceof Promise ? await r : r;
    expect(result.issues.filter((i) => i.includes('broken-relation-ref'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

describe('atomFrontmatterCheck — result shape', () => {
  it('uses severity=error and ok=false when errors are present', async () => {
    const id = 'BELI-2026-05-24-broken-ref-1abcd';
    const fm = validFm(id) + `relations:\n  - target: MISSING-ATOM-99999\n    type: extends\n`;
    writeAtomFile(entitiesDir(), `${id}.md`, fm);
    const r = await run();
    expect(r.severity).toBe('error');
    expect(r.ok).toBe(false);
  });

  it('uses severity=error and ok=true when store is clean', async () => {
    const r = await run();
    expect(r.severity).toBe('error');
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  it('prefixes all issues with "error:"', async () => {
    const id = 'BELI-2026-05-24-prefix-check-1abcd';
    const fm = validFm(id) + `relations:\n  - target: MISSING-ATOM-99999\n    type: extends\n`;
    writeAtomFile(entitiesDir(), `${id}.md`, fm);
    const r = await run();
    expect(r.issues.every((i) => i.startsWith('error:'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #327 — known IDs come from frontmatter id, not filename
// ---------------------------------------------------------------------------

describe('atomFrontmatterCheck — id resolved from frontmatter, not filename (#327)', () => {
  it('does not falsely error on a relation to an atom whose archive file is doubled-named', async () => {
    const realId = 'OPEN-2026-03-10-SEMANTIC-SEARCH-GAP-169qr';
    // Legacy archive-rename bug: filename is the id DOUBLED, frontmatter id is the real id.
    writeAtomFile(
      archiveDir(),
      `${realId}-${realId}.md`,
      [
        `id: ${realId}`,
        'type: open_question',
        'status: expired',
        'confidence: 0.5',
        `created_at: "${NOW}"`,
        `updated_at: "${NOW}"`,
        'ttl_days: null',
        'classification: TEAM',
        '',
      ].join('\n'),
    );
    // Active atom with an inbound relation to the real id.
    const srcId = 'BELI-2026-03-25-PRINCIPLE-EVOLUTION-1d705';
    writeAtomFile(
      entitiesDir(),
      `${srcId}.md`,
      [
        `id: ${srcId}`,
        'type: belief',
        'status: active',
        'confidence: 0.8',
        `created_at: "${NOW}"`,
        `updated_at: "${NOW}"`,
        'ttl_days: null',
        'classification: TEAM',
        'relations:',
        '  - type: related',
        `    target: ${realId}`,
        '',
      ].join('\n'),
    );

    const r = await run();
    // Before #327: buildAllIds knew only the doubled basename, so the relation
    // to the real id was a false broken-relation-ref (error). Now the real id
    // is registered from frontmatter → no false error.
    const brokenToReal = r.issues.filter((i) => i.includes('broken-relation-ref') && i.includes(realId));
    expect(brokenToReal).toEqual([]);
  });

  it('still flags a genuinely missing relation target', async () => {
    const srcId = 'BELI-2026-03-25-DANGLING-REF-2a2a2';
    writeAtomFile(
      entitiesDir(),
      `${srcId}.md`,
      [
        `id: ${srcId}`,
        'type: belief',
        'status: active',
        'confidence: 0.8',
        `created_at: "${NOW}"`,
        `updated_at: "${NOW}"`,
        'ttl_days: null',
        'classification: TEAM',
        'relations:',
        '  - type: related',
        '    target: FACT-2026-01-01-DOES-NOT-EXIST-zzzzz',
        '',
      ].join('\n'),
    );
    const r = await run();
    expect(r.issues.some((i) => i.includes('broken-relation-ref') && i.includes('DOES-NOT-EXIST'))).toBe(true);
  });
});
