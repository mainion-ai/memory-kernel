/**
 * Tests for the orphan-prose-refs doctor check (#243).
 *
 * Flags atoms whose BODY prose references another atom by ID (e.g.
 * "Extends BELI-...") where that atom exists in the store but the reference is
 * not wired as a formal `frontmatter.relations[].target`. Detection-only.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { initMemoryDir, closeAllIndexes } from '../src/index.js';
import { orphanProseRefsCheck } from '../src/doctor/checks/orphan-prose-refs.js';
import type { CheckResult, DoctorContext } from '../src/doctor/types.js';

let testDir: string;

function ctx(): DoctorContext {
  return { memoryDir: testDir, kernelVersion: '1.0.0', skipCategories: new Set(), env: {} };
}

async function run(): Promise<CheckResult> {
  const r = orphanProseRefsCheck.run(ctx());
  return r instanceof Promise ? await r : r;
}

const NOW = '2026-05-24T00:00:00.000Z';

function validFm(id: string): string {
  return [
    `id: ${id}`,
    `type: belief`,
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

const entitiesDir = () => path.join(testDir, 'ENTITIES');
const archiveDir = () => path.join(testDir, 'ARCHIVE');

const orphanIssues = (r: CheckResult) => r.issues.filter((i) => i.includes('orphan-prose-ref'));

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-doctor-orphan-prose-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('orphanProseRefsCheck — clean store', () => {
  it('ok=true on empty store', async () => {
    const r = await run();
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  it('ok=true when an atom has no prose refs', async () => {
    const id = 'BELI-2026-05-24-no-refs-1abcd';
    writeAtomFile(entitiesDir(), `${id}.md`, validFm(id), 'Just a normal belief body. No references.');
    const r = await run();
    expect(r.ok).toBe(true);
  });

  it('does NOT flag a prose ref that IS formalised in relations[]', async () => {
    const idA = 'BELI-2026-05-24-source-1abcd';
    const idB = 'FACT-2026-05-24-target-2bbbb';
    writeAtomFile(entitiesDir(), `${idB}.md`, validFm(idB));
    const fmA = validFm(idA) + `relations:\n  - target: ${idB}\n    type: extends\n`;
    writeAtomFile(entitiesDir(), `${idA}.md`, fmA, `This belief extends ${idB} in spirit.`);
    const r = await run();
    expect(orphanIssues(r)).toHaveLength(0);
  });
});

describe('orphanProseRefsCheck — orphan detection', () => {
  it('flags a prose ref to an existing atom not in relations[]', async () => {
    const idA = 'BELI-2026-05-24-with-prose-1abcd';
    const idB = 'FACT-2026-05-24-target-2bbbb';
    writeAtomFile(entitiesDir(), `${idB}.md`, validFm(idB));
    // Prose ref, but NO relations: in frontmatter.
    writeAtomFile(entitiesDir(), `${idA}.md`, validFm(idA), `Extends ${idB} — see the argument there.`);
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.severity).toBe('warn');
    expect(orphanIssues(r).some((i) => i.includes(idA) && i.includes(idB))).toBe(true);
  });

  it('does NOT flag a prose ref to a non-existent atom (existence gate)', async () => {
    const idA = 'BELI-2026-05-24-dead-ref-1abcd';
    writeAtomFile(entitiesDir(), `${idA}.md`, validFm(idA), 'Extends FACT-2026-01-01-ghost-99999 which was deleted.');
    const r = await run();
    expect(orphanIssues(r)).toHaveLength(0);
  });

  it('is case-insensitive on the relation word', async () => {
    const idA = 'BELI-2026-05-24-lower-1abcd';
    const idB = 'FACT-2026-05-24-target-3cccc';
    writeAtomFile(entitiesDir(), `${idB}.md`, validFm(idB));
    writeAtomFile(entitiesDir(), `${idA}.md`, validFm(idA), `this belief contradicts ${idB} on one point.`);
    const r = await run();
    expect(orphanIssues(r).some((i) => i.includes(idB))).toBe(true);
  });

  it('captures the prose relation type in the message', async () => {
    const idA = 'BELI-2026-05-24-typed-1abcd';
    const idB = 'FACT-2026-05-24-target-4dddd';
    writeAtomFile(entitiesDir(), `${idB}.md`, validFm(idB));
    writeAtomFile(entitiesDir(), `${idA}.md`, validFm(idA), `Supports ${idB}.`);
    const r = await run();
    expect(orphanIssues(r).some((i) => i.toLowerCase().includes('supports'))).toBe(true);
  });

  it('dedupes repeated prose refs to the same target', async () => {
    const idA = 'BELI-2026-05-24-dupe-1abcd';
    const idB = 'FACT-2026-05-24-target-5eeee';
    writeAtomFile(entitiesDir(), `${idB}.md`, validFm(idB));
    writeAtomFile(entitiesDir(), `${idA}.md`, validFm(idA), `Extends ${idB}. Later again: extends ${idB}.`);
    const r = await run();
    expect(orphanIssues(r)).toHaveLength(1);
  });

  it('flags multiple distinct orphan refs from one atom', async () => {
    const idA = 'BELI-2026-05-24-multi-1abcd';
    const idB = 'FACT-2026-05-24-one-2bbbb';
    const idC = 'BELI-2026-05-24-two-3cccc';
    writeAtomFile(entitiesDir(), `${idB}.md`, validFm(idB));
    writeAtomFile(entitiesDir(), `${idC}.md`, validFm(idC));
    writeAtomFile(entitiesDir(), `${idA}.md`, validFm(idA), `Extends ${idB}. Also supports ${idC}.`);
    const r = await run();
    expect(orphanIssues(r)).toHaveLength(2);
  });

  it('does not flag a self-reference', async () => {
    const idA = 'BELI-2026-05-24-selfref-1abcd';
    writeAtomFile(entitiesDir(), `${idA}.md`, validFm(idA), `This atom extends ${idA} (itself, oddly).`);
    const r = await run();
    expect(orphanIssues(r)).toHaveLength(0);
  });

  it('resolves prose refs against ARCHIVE atoms (they exist in the store)', async () => {
    const idA = 'BELI-2026-05-24-to-archived-1abcd';
    const idArch = 'FACT-2026-05-24-archived-6ffff';
    writeAtomFile(archiveDir(), `${idArch}.md`, validFm(idArch));
    writeAtomFile(entitiesDir(), `${idA}.md`, validFm(idA), `Supersedes ${idArch} from the old design.`);
    const r = await run();
    expect(orphanIssues(r).some((i) => i.includes(idArch))).toBe(true);
  });
});

describe('orphanProseRefsCheck — shape', () => {
  it('is warn-severity and exposes no fix()', () => {
    expect(orphanProseRefsCheck.defaultSeverity).toBe('warn');
    expect(orphanProseRefsCheck.fix).toBeUndefined();
  });
});
