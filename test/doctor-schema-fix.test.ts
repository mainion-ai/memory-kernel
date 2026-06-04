/**
 * Tests for atom-schema migrations apply path + .bak writer (#191 Phase 2).
 *
 * The seeded migrations table lives in src/doctor/checks/schema-migrations.ts.
 * These tests pin the behaviour of the apply path: planned migrations
 * rewrite frontmatter via writeAtom() (body preserved), a .bak is written
 * before each modified atom, dry-run mode never touches disk, and unknown
 * / structural failures stay in `remaining[]`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { initMemoryDir, closeAllIndexes } from '../src/index.js';
import { readAtom } from '../src/store.js';
import { schemaCheck } from '../src/doctor/checks/schema.js';
import type { CheckResult, DoctorContext } from '../src/doctor/types.js';

let testDir: string;

function ctx(): DoctorContext {
  return {
    memoryDir: testDir,
    kernelVersion: '1.25.0',
    skipCategories: new Set(),
    env: {},
  };
}

async function asResult(p: CheckResult | Promise<CheckResult>): Promise<CheckResult> {
  return await p;
}

function writeRawAtom(memoryDir: string, id: string, frontmatterYaml: string, body = 'Body line.'): string {
  const entitiesDir = path.join(memoryDir, 'ENTITIES');
  fs.mkdirSync(entitiesDir, { recursive: true });
  const filePath = path.join(entitiesDir, `${id}.md`);
  const content = `---\n${frontmatterYaml}---\n${body}\n`;
  fs.writeFileSync(filePath, content);
  return filePath;
}

const NOW = '2026-05-24T00:00:00.000Z';

function validFm(id: string, type = 'fact'): string {
  return [
    `id: ${id}`,
    `type: ${type}`,
    `status: active`,
    `confidence: 0.9`,
    `created_at: "${NOW}"`,
    `updated_at: "${NOW}"`,
    `ttl_days: null`,
    `classification: TEAM`,
    ``,
  ].join('\n');
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-doctor-schema-fix-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('schemaCheck.fix — apply mode with registered migrations', () => {
  it('migrates classification PUBLIC_FRIENDLY → PUBLIC and writes .bak', async () => {
    const id = 'FACT-2026-05-24-mig-class-aaaaa';
    const fp = writeRawAtom(testDir, id,
      validFm(id).replace('classification: TEAM', 'classification: PUBLIC_FRIENDLY'),
      'Important fact body.');
    const originalBytes = fs.readFileSync(fp);

    const outcome = await schemaCheck.fix!(ctx(), await asResult(schemaCheck.run(ctx())), { dryRun: false });

    expect(outcome.applied.length).toBeGreaterThanOrEqual(1);
    expect(outcome.applied.join('\n')).toMatch(/migrated/);
    expect(outcome.applied.join('\n')).toContain('"PUBLIC_FRIENDLY" → "PUBLIC"');

    // The .bak holds the original bytes verbatim.
    expect(fs.existsSync(fp + '.bak')).toBe(true);
    expect(fs.readFileSync(fp + '.bak').equals(originalBytes)).toBe(true);

    // The migrated atom now parses cleanly.
    const after = readAtom(fp);
    expect(after.frontmatter.classification).toBe('PUBLIC');
    // Body preserved.
    expect(after.body).toContain('Important fact body.');
  });

  it('migrates status deprecated → archived (taj survey)', async () => {
    const id = 'FACT-2026-05-24-mig-status-dep-mmmmm';
    const fp = writeRawAtom(testDir, id,
      validFm(id).replace('status: active', 'status: deprecated'));

    const outcome = await schemaCheck.fix!(ctx(), await asResult(schemaCheck.run(ctx())), { dryRun: false });

    expect(outcome.applied.join('\n')).toContain('"deprecated" → "archived"');
    expect(readAtom(fp).frontmatter.status).toBe('archived');
  });

  it('migrates classification PRIVATE → PERSONAL (taj survey)', async () => {
    const id = 'FACT-2026-05-24-mig-class-priv-nnnnn';
    const fp = writeRawAtom(testDir, id,
      validFm(id).replace('classification: TEAM', 'classification: PRIVATE'));

    const outcome = await schemaCheck.fix!(ctx(), await asResult(schemaCheck.run(ctx())), { dryRun: false });

    expect(outcome.applied.join('\n')).toContain('"PRIVATE" → "PERSONAL"');
    expect(readAtom(fp).frontmatter.classification).toBe('PERSONAL');
  });

  it('migrates relations[].type kebab-case → underscore (caused-by + applied-to)', async () => {
    // Cover both kebab→underscore relations migrations in one fixture so
    // the table coverage isn't biased toward `caused-by` alone.
    const id = 'FACT-2026-05-24-mig-rel-bbbbb';
    const target = 'FACT-2026-05-24-target-zzzzz';
    const fm = validFm(id)
      + `relations:\n  - target: ${target}\n    type: caused-by\n  - target: ${target}\n    type: applied-to\n`;
    writeRawAtom(testDir, id, fm);

    const outcome = await schemaCheck.fix!(ctx(), await asResult(schemaCheck.run(ctx())), { dryRun: false });

    expect(outcome.applied.join('\n')).toContain('"caused-by" → "caused_by"');
    expect(outcome.applied.join('\n')).toContain('"applied-to" → "applied_to"');

    const after = readAtom(path.join(testDir, 'ENTITIES', `${id}.md`));
    expect(after.frontmatter.relations?.[0]?.type).toBe('caused_by');
    expect(after.frontmatter.relations?.[1]?.type).toBe('applied_to');
  });

  it('applies multiple migrations to the same atom in one write with one .bak', async () => {
    const id = 'FACT-2026-05-24-multi-mig-ccccc';
    const fm = validFm(id)
      .replace('status: active', 'status: obsolete')
      .replace('classification: TEAM', 'classification: PUBLIC_FRIENDLY');
    const fp = writeRawAtom(testDir, id, fm);

    const outcome = await schemaCheck.fix!(ctx(), await asResult(schemaCheck.run(ctx())), { dryRun: false });

    expect(outcome.applied.join('\n')).toContain('"obsolete" → "archived"');
    expect(outcome.applied.join('\n')).toContain('"PUBLIC_FRIENDLY" → "PUBLIC"');

    // Exactly one canonical .bak (no timestamped fallback was needed).
    expect(fs.existsSync(fp + '.bak')).toBe(true);
    const baks = fs.readdirSync(path.dirname(fp)).filter((n) => n.startsWith(path.basename(fp) + '.bak'));
    expect(baks).toHaveLength(1);

    const after = readAtom(fp);
    expect(after.frontmatter.status).toBe('archived');
    expect(after.frontmatter.classification).toBe('PUBLIC');
  });

  it('dry-run does not write the atom or the .bak', async () => {
    const id = 'FACT-2026-05-24-dry-ddddd';
    const fp = writeRawAtom(testDir, id,
      validFm(id).replace('classification: TEAM', 'classification: PUBLIC_FRIENDLY'));
    const originalBytes = fs.readFileSync(fp);
    const originalMtime = fs.statSync(fp).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));

    const outcome = await schemaCheck.fix!(ctx(), await asResult(schemaCheck.run(ctx())), { dryRun: true });

    expect(outcome.applied.join('\n')).toMatch(/would migrate/);
    expect(outcome.applied.join('\n')).toContain('"PUBLIC_FRIENDLY" → "PUBLIC"');
    expect(fs.existsSync(fp + '.bak')).toBe(false);
    expect(fs.readFileSync(fp).equals(originalBytes)).toBe(true);
    expect(fs.statSync(fp).mtimeMs).toBe(originalMtime);
  });

  it('does not overwrite a pre-existing .bak — uses a timestamped fallback', async () => {
    const id = 'FACT-2026-05-24-bak-coll-eeeee';
    const fp = writeRawAtom(testDir, id,
      validFm(id).replace('classification: TEAM', 'classification: PUBLIC_FRIENDLY'));
    // Plant a sentinel .bak from a prior fix run.
    const sentinel = Buffer.from('pre-existing backup');
    fs.writeFileSync(fp + '.bak', sentinel);

    await schemaCheck.fix!(ctx(), await asResult(schemaCheck.run(ctx())), { dryRun: false });

    // Canonical .bak still holds the sentinel — never overwritten.
    expect(fs.readFileSync(fp + '.bak').equals(sentinel)).toBe(true);
    // A timestamped backup of the actual pre-migration atom was created.
    const baks = fs.readdirSync(path.dirname(fp))
      .filter((n) => n.startsWith(path.basename(fp) + '.bak.') && n !== path.basename(fp) + '.bak');
    expect(baks.length).toBeGreaterThanOrEqual(1);
  });

  it('leaves structural failures (relations.target undefined) in remaining', async () => {
    const id = 'FACT-2026-05-24-struct-fffff';
    const fm = validFm(id) + `relations:\n  - type: caused-by\n`; // missing target
    const fp = writeRawAtom(testDir, id, fm);

    const outcome = await schemaCheck.fix!(ctx(), await asResult(schemaCheck.run(ctx())), { dryRun: false });

    // The kebab-case → underscore migration on relations.0.type still applies…
    expect(outcome.applied.join('\n')).toContain('"caused-by" → "caused_by"');
    // …but the missing-target structural failure stays in remaining.
    const joined = outcome.remaining.join('\n');
    expect(joined).toContain('relations.0.target');
    expect(joined).toContain('structural failure');

    // .bak was written for the partial migration.
    expect(fs.existsSync(fp + '.bak')).toBe(true);
  });

  it('leaves unknown legacy values in remaining without writing', async () => {
    const id = 'FACT-2026-05-24-unkn-ggggg';
    const fp = writeRawAtom(testDir, id,
      validFm(id).replace('status: active', 'status: TOTALLY_INVENTED_X'));

    const outcome = await schemaCheck.fix!(ctx(), await asResult(schemaCheck.run(ctx())), { dryRun: false });

    expect(outcome.applied).toHaveLength(0);
    expect(outcome.remaining.join('\n')).toContain('"TOTALLY_INVENTED_X"');
    expect(fs.existsSync(fp + '.bak')).toBe(false);
  });

  it('doctor re-run after apply shows the schema check passing', async () => {
    const id = 'FACT-2026-05-24-rerun-hhhhh';
    writeRawAtom(testDir, id,
      validFm(id).replace('classification: TEAM', 'classification: PUBLIC_FRIENDLY'));

    const before = await asResult(schemaCheck.run(ctx()));
    expect(before.ok).toBe(false);

    await schemaCheck.fix!(ctx(), before, { dryRun: false });

    const after = await asResult(schemaCheck.run(ctx()));
    expect(after.ok).toBe(true);
  });

  it('handles a mix of migratable and unknown atoms in one pass', async () => {
    writeRawAtom(testDir, 'FACT-2026-05-24-mix-mig-iiiii',
      validFm('FACT-2026-05-24-mix-mig-iiiii').replace('classification: TEAM', 'classification: PUBLIC_FRIENDLY'));
    writeRawAtom(testDir, 'FACT-2026-05-24-mix-unk-jjjjj',
      validFm('FACT-2026-05-24-mix-unk-jjjjj').replace('status: active', 'status: UNKNOWN_X'));

    const outcome = await schemaCheck.fix!(ctx(), await asResult(schemaCheck.run(ctx())), { dryRun: false });

    const migrationLines = outcome.applied.filter((l) => l.startsWith('[migration]'));
    expect(migrationLines).toHaveLength(1);
    expect(migrationLines[0]).toContain('FACT-2026-05-24-mix-mig-iiiii');
    expect(outcome.remaining.length).toBe(1);
    expect(outcome.remaining.join('\n')).toContain('FACT-2026-05-24-mix-unk-jjjjj');
  });

  it('dry-run with multiple migrations does not create any .bak files', async () => {
    writeRawAtom(testDir, 'FACT-2026-05-24-dry-multi-kkkkk',
      validFm('FACT-2026-05-24-dry-multi-kkkkk')
        .replace('status: active', 'status: obsolete')
        .replace('classification: TEAM', 'classification: PUBLIC_FRIENDLY'));

    await schemaCheck.fix!(ctx(), await asResult(schemaCheck.run(ctx())), { dryRun: true });

    const entries = fs.readdirSync(path.join(testDir, 'ENTITIES'));
    expect(entries.filter((n) => n.includes('.bak'))).toHaveLength(0);
  });

  it('tags every applied line with [migration] or [normalization]', async () => {
    const id = 'FACT-2026-05-24-tag-prefix-ppppp';
    writeRawAtom(testDir, id,
      validFm(id).replace('classification: TEAM', 'classification: PUBLIC_FRIENDLY'));

    const outcome = await schemaCheck.fix!(ctx(), await asResult(schemaCheck.run(ctx())), { dryRun: false });

    for (const line of outcome.applied) {
      expect(line.startsWith('[migration] ') || line.startsWith('[normalization] '),
        `unlabelled line: ${line}`).toBe(true);
    }
    const migs = outcome.applied.filter((l) => l.startsWith('[migration]'));
    expect(migs).toHaveLength(1);
    expect(migs[0]).toContain('"PUBLIC_FRIENDLY" → "PUBLIC"');
  });

  it('emits [normalization] line for comma-joined scope.tags split (taj-shape)', async () => {
    // Mirror the taj `1m4x3` legacy shape: scope.tags is a single-element
    // list whose only entry is a comma-joined string.
    const id = 'FACT-2026-05-24-comma-tags-qqqqq';
    const fm = [
      `id: ${id}`,
      `type: fact`,
      `status: deprecated`,
      `confidence: 0.8`,
      `created_at: "${NOW}"`,
      `updated_at: "${NOW}"`,
      `ttl_days: null`,
      `scope:`,
      `  tags:`,
      `    - alpha,beta,gamma`,
      `classification: TEAM`,
      ``,
    ].join('\n');
    writeRawAtom(testDir, id, fm);

    const outcome = await schemaCheck.fix!(ctx(), await asResult(schemaCheck.run(ctx())), { dryRun: false });

    const migs = outcome.applied.filter((l) => l.startsWith('[migration]'));
    const norms = outcome.applied.filter((l) => l.startsWith('[normalization]'));
    expect(migs.length).toBeGreaterThanOrEqual(1);
    expect(migs.join('\n')).toContain('"deprecated" → "archived"');
    expect(norms.length).toBeGreaterThanOrEqual(1);
    expect(norms.join('\n')).toMatch(/comma-joined|tags.*promoted/i);
  });

  it('dry-run also distinguishes [migration] from [normalization]', async () => {
    const id = 'FACT-2026-05-24-dry-labels-rrrrr';
    const fm = [
      `id: ${id}`,
      `type: fact`,
      `status: deprecated`,
      `confidence: 0.8`,
      `created_at: "${NOW}"`,
      `updated_at: "${NOW}"`,
      `ttl_days: null`,
      `scope:`,
      `  tags:`,
      `    - one,two,three`,
      `classification: TEAM`,
      ``,
    ].join('\n');
    writeRawAtom(testDir, id, fm);

    const outcome = await schemaCheck.fix!(ctx(), await asResult(schemaCheck.run(ctx())), { dryRun: true });

    const migs = outcome.applied.filter((l) => l.startsWith('[migration]'));
    const norms = outcome.applied.filter((l) => l.startsWith('[normalization]'));
    expect(migs.length).toBeGreaterThanOrEqual(1);
    expect(migs.join('\n')).toContain('would migrate');
    expect(norms.length).toBeGreaterThanOrEqual(1);
    expect(norms.join('\n')).toContain('would normalize');
  });

  it('emits no [normalization] line when the atom is already canonical', async () => {
    const id = 'FACT-2026-05-24-canon-sssss';
    // Migrate-only atom: status drift but otherwise byte-identical to the
    // canonical serialization (note the blank line after the frontmatter
    // closer, which `serializeAtom` always emits).
    const fm = [
      `id: ${id}`,
      `type: fact`,
      `status: deprecated`,
      `confidence: 0.8`,
      `created_at: "${NOW}"`,
      `updated_at: "${NOW}"`,
      `ttl_days: null`,
      `classification: TEAM`,
      ``,
    ].join('\n');
    writeRawAtom(testDir, id, fm, '\nPlain body line.');

    const outcome = await schemaCheck.fix!(ctx(), await asResult(schemaCheck.run(ctx())), { dryRun: false });

    const migs = outcome.applied.filter((l) => l.startsWith('[migration]'));
    const norms = outcome.applied.filter((l) => l.startsWith('[normalization]'));
    expect(migs).toHaveLength(1);
    expect(norms).toHaveLength(0);
  });

  it('apply preserves body content byte-for-byte', async () => {
    const id = 'FACT-2026-05-24-body-lllll';
    const body = 'Line 1.\nLine 2 with **markdown**.\nLine 3.\n\nParagraph two.';
    const fp = writeRawAtom(testDir, id,
      validFm(id).replace('classification: TEAM', 'classification: PUBLIC_FRIENDLY'),
      body);

    await schemaCheck.fix!(ctx(), await asResult(schemaCheck.run(ctx())), { dryRun: false });

    const after = readAtom(fp);
    expect(after.body).toContain('Line 1.');
    expect(after.body).toContain('Line 2 with **markdown**.');
    expect(after.body).toContain('Line 3.');
    expect(after.body).toContain('Paragraph two.');
  });
});
