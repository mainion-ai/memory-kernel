/**
 * Tests for the atom-relations-section doctor check (#227).
 *
 * Covers: stale <!-- mk:relations --> section detection (warn-only check,
 * separated from atom-frontmatter to avoid severity miscounting in mk.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { initMemoryDir, closeAllIndexes } from '../src/index.js';
import { atomRelationsSectionCheck } from '../src/doctor/checks/atom-relations-section.js';
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
  const r = atomRelationsSectionCheck.run(ctx());
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

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-doctor-relations-section-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Clean store
// ---------------------------------------------------------------------------

describe('atomRelationsSectionCheck — clean store', () => {
  it('returns ok=true on empty ENTITIES', async () => {
    const r = await run();
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  it('returns ok=true for atom with no relations section', async () => {
    const idA = 'BELI-2026-05-24-no-section-1abcd';
    const idB = 'FACT-2026-05-24-target-1bbbb';
    writeAtomFile(entitiesDir(), `${idB}.md`, validFm(idB));

    const fm = validFm(idA) + `relations:\n  - target: ${idB}\n    type: extends\n`;
    writeAtomFile(entitiesDir(), `${idA}.md`, fm);

    const r = await run();
    expect(r.ok).toBe(true);
  });

  it('does NOT warn when section correctly contains the frontmatter edge', async () => {
    const idA = 'BELI-2026-05-24-good-section-1abcd';
    const idB = 'FACT-2026-05-24-target-2cccc';
    writeAtomFile(entitiesDir(), `${idB}.md`, validFm(idB));

    const fm = validFm(idA) + `relations:\n  - target: ${idB}\n    type: extends\n`;
    const body = `\n<!-- mk:relations -->\n## Relations\n\n- extends [[${idB}]]\n\n`;
    writeAtomFile(entitiesDir(), `${idA}.md`, fm, body);

    const r = await run();
    expect(r.issues.filter((i) => i.includes('stale-relations-section'))).toHaveLength(0);
  });

  it('does NOT warn when section has extra incoming edges not in frontmatter', async () => {
    const idA = 'BELI-2026-05-24-with-incoming-1abcd';
    const idB = 'FACT-2026-05-24-target-3dddd';
    writeAtomFile(entitiesDir(), `${idB}.md`, validFm(idB));

    const fm = validFm(idA) + `relations:\n  - target: ${idB}\n    type: extends\n`;
    // Incoming edge (extended-by) is valid section content — not in frontmatter
    const body = `\n<!-- mk:relations -->\n## Relations\n\n- extends [[${idB}]]\n- extended-by [[SOME-OTHER-ATOM]]\n\n`;
    writeAtomFile(entitiesDir(), `${idA}.md`, fm, body);

    const r = await run();
    expect(r.issues.filter((i) => i.includes('stale-relations-section'))).toHaveLength(0);
  });

  it('does NOT warn when the section edge uses an Obsidian display alias', async () => {
    const idA = 'BELI-2026-05-24-aliased-edge-1abcd';
    const idB = 'FACT-2026-05-24-target-4eeee';
    writeAtomFile(entitiesDir(), `${idB}.md`, validFm(idB));

    const fm = validFm(idA) + `relations:\n  - target: ${idB}\n    type: extends\n`;
    const body = `\n<!-- mk:relations -->\n## Relations\n\n- extends [[${idB}|the B fact]]\n\n`;
    writeAtomFile(entitiesDir(), `${idA}.md`, fm, body);

    const r = await run();
    expect(r.issues.filter((i) => i.includes('stale-relations-section'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Stale section detection
// ---------------------------------------------------------------------------

describe('atomRelationsSectionCheck — stale section', () => {
  it('warns when section exists but is missing a frontmatter relation edge', async () => {
    const idA = 'BELI-2026-05-24-stale-section-1abcd';
    const idB = 'FACT-2026-05-24-target-5ffff';
    writeAtomFile(entitiesDir(), `${idB}.md`, validFm(idB));

    const fm = validFm(idA) + `relations:\n  - target: ${idB}\n    type: extends\n`;
    // Section present but has `related` instead of `extends`
    const body = `\n<!-- mk:relations -->\n## Relations\n\n- related [[${idB}]]\n\n`;
    writeAtomFile(entitiesDir(), `${idA}.md`, fm, body);

    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.includes('stale-relations-section') && i.includes(idB))).toBe(true);
  });

  it('warns once per missing edge (multiple missing edges)', async () => {
    const idA = 'BELI-2026-05-24-two-missing-1abcd';
    const idB = 'FACT-2026-05-24-target-6gggg';
    const idC = 'FACT-2026-05-24-target-7hhhh';
    writeAtomFile(entitiesDir(), `${idB}.md`, validFm(idB));
    writeAtomFile(entitiesDir(), `${idC}.md`, validFm(idC));

    const fm =
      validFm(idA) +
      `relations:\n  - target: ${idB}\n    type: extends\n  - target: ${idC}\n    type: supports\n`;
    // Section is completely empty (sentinel present but no edges)
    const body = `\n<!-- mk:relations -->\n## Relations\n\n`;
    writeAtomFile(entitiesDir(), `${idA}.md`, fm, body);

    const r = await run();
    expect(r.issues.filter((i) => i.includes('stale-relations-section'))).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

describe('atomRelationsSectionCheck — result shape', () => {
  it('always uses severity=warn', async () => {
    const r = await run();
    expect(r.severity).toBe('warn');
  });

  it('ok=false when warnings present, ok=true when clean', async () => {
    const idA = 'BELI-2026-05-24-stale-shape-1abcd';
    const idB = 'FACT-2026-05-24-target-8iiii';
    writeAtomFile(entitiesDir(), `${idB}.md`, validFm(idB));

    const fm = validFm(idA) + `relations:\n  - target: ${idB}\n    type: extends\n`;
    const body = `\n<!-- mk:relations -->\n## Relations\n\n- related [[${idB}]]\n\n`;
    writeAtomFile(entitiesDir(), `${idA}.md`, fm, body);

    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.issues.every((i) => i.startsWith('warning:'))).toBe(true);
  });
});
