/**
 * Tests for the atom-schema check structured probe + unknown-value handling
 * (#191). Migrations-table application (apply mode + .bak writer) is covered
 * in `doctor-schema-fix.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { initMemoryDir, closeAllIndexes } from '../src/index.js';
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

/**
 * Write a raw atom .md file directly to ENTITIES/, bypassing createAtom's
 * validation so we can pin known-bad frontmatter values on disk.
 */
function writeRawAtom(memoryDir: string, id: string, frontmatterYaml: string, body = ''): string {
  const entitiesDir = path.join(memoryDir, 'ENTITIES');
  fs.mkdirSync(entitiesDir, { recursive: true });
  const filePath = path.join(entitiesDir, `${id}.md`);
  const content = `---\n${frontmatterYaml}---\n${body}\n`;
  fs.writeFileSync(filePath, content);
  return filePath;
}

const NOW = '2026-05-24T00:00:00.000Z';

function validFm(id: string, type = 'fact'): string {
  // Datetimes are quoted because gray-matter / js-yaml parses unquoted ISO 8601
  // strings into JS Date objects, which then fail the Zod string() check —
  // not the legacy state we're modelling here.
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
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-doctor-schema-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('schemaCheck.run — back-compat issue-string shape', () => {
  it('returns ok=true on a fresh memory dir with no atoms', async () => {
    const r = await asResult(schemaCheck.run(ctx()));
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  it('surfaces one issue line per failing atom with the atom id prefix', async () => {
    writeRawAtom(testDir, 'FACT-2026-05-24-bad-status-aaaaa',
      validFm('FACT-2026-05-24-bad-status-aaaaa').replace('status: active', 'status: PUBLIC_FRIENDLY'));
    const r = await asResult(schemaCheck.run(ctx()));
    expect(r.ok).toBe(false);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatch(/^FACT-2026-05-24-bad-status-aaaaa:/);
  });
});

describe('schemaCheck.fix — unknown-value handling', () => {
  it('reports a bad status enum value verbatim in remaining[]', async () => {
    // `BAD_STATUS_LEGACY_X` is intentionally not in the migrations table.
    writeRawAtom(testDir, 'FACT-2026-05-24-bad-status-bbbbb',
      validFm('FACT-2026-05-24-bad-status-bbbbb').replace('status: active', 'status: BAD_STATUS_LEGACY_X'));

    const before = await asResult(schemaCheck.run(ctx()));
    expect(before.ok).toBe(false);

    const outcome = await schemaCheck.fix!(ctx(), before, { dryRun: false });
    expect(outcome.applied).toHaveLength(0);
    expect(outcome.remaining).toHaveLength(1);
    const line = outcome.remaining[0];
    expect(line).toContain('FACT-2026-05-24-bad-status-bbbbb');
    expect(line).toContain('status');
    expect(line).toContain('"BAD_STATUS_LEGACY_X"');
    expect(line).toContain('no migration registered');
  });

  it('reports a bad classification enum value verbatim when unknown', async () => {
    // `UNKNOWN_LEGACY_CLASS` is intentionally not in the migrations table.
    writeRawAtom(testDir, 'FACT-2026-05-24-bad-class-ccccc',
      validFm('FACT-2026-05-24-bad-class-ccccc').replace('classification: TEAM', 'classification: UNKNOWN_LEGACY_CLASS'));

    const before = await asResult(schemaCheck.run(ctx()));
    expect(before.ok).toBe(false);

    const outcome = await schemaCheck.fix!(ctx(), before, { dryRun: false });
    expect(outcome.applied).toHaveLength(0);
    const joined = outcome.remaining.join('\n');
    expect(joined).toContain('classification');
    expect(joined).toContain('"UNKNOWN_LEGACY_CLASS"');
  });

  it('reports a bad relations[].type with the indexed path', async () => {
    const fm = validFm('FACT-2026-05-24-bad-rel-ddddd')
      + `relations:\n  - target: FACT-2026-05-24-other-eeeee\n    type: caused-by-deprecated\n`;
    writeRawAtom(testDir, 'FACT-2026-05-24-bad-rel-ddddd', fm);

    const outcome = await schemaCheck.fix!(ctx(), await asResult(schemaCheck.run(ctx())), { dryRun: true });
    expect(outcome.applied).toHaveLength(0);
    const joined = outcome.remaining.join('\n');
    expect(joined).toContain('relations.0.type');
    expect(joined).toContain('"caused-by-deprecated"');
  });

  it('reports a structural relations[].target failure with <undefined>', async () => {
    const fm = validFm('FACT-2026-05-24-bad-target-fffff')
      + `relations:\n  - type: caused_by\n`; // target omitted entirely
    writeRawAtom(testDir, 'FACT-2026-05-24-bad-target-fffff', fm);

    const outcome = await schemaCheck.fix!(ctx(), await asResult(schemaCheck.run(ctx())), { dryRun: false });
    expect(outcome.applied).toHaveLength(0);
    const joined = outcome.remaining.join('\n');
    expect(joined).toContain('relations.0.target');
    expect(joined).toContain('<undefined>');
    expect(joined).toContain('structural failure');
  });

  it('reports multiple failures on the same atom as separate remaining lines', async () => {
    const fm = validFm('FACT-2026-05-24-multi-ggggg')
      .replace('status: active', 'status: BAD_STATUS')
      .replace('classification: TEAM', 'classification: BAD_CLASS');
    writeRawAtom(testDir, 'FACT-2026-05-24-multi-ggggg', fm);

    const outcome = await schemaCheck.fix!(ctx(), await asResult(schemaCheck.run(ctx())), { dryRun: false });
    expect(outcome.applied).toHaveLength(0);
    expect(outcome.remaining.length).toBeGreaterThanOrEqual(2);
    const joined = outcome.remaining.join('\n');
    expect(joined).toContain('"BAD_STATUS"');
    expect(joined).toContain('"BAD_CLASS"');
  });

  it('apply and dry-run modes produce identical remaining for unknown values', async () => {
    writeRawAtom(testDir, 'FACT-2026-05-24-parity-hhhhh',
      validFm('FACT-2026-05-24-parity-hhhhh').replace('status: active', 'status: UNKNOWN_STATUS_X'));

    const before = await asResult(schemaCheck.run(ctx()));
    const dry = await schemaCheck.fix!(ctx(), before, { dryRun: true });
    const apply = await schemaCheck.fix!(ctx(), before, { dryRun: false });

    expect(dry.applied).toEqual(apply.applied);
    expect(dry.remaining).toEqual(apply.remaining);
  });

  it('apply mode does not modify the atom file when no migration is registered', async () => {
    const filePath = writeRawAtom(testDir, 'FACT-2026-05-24-immut-iiiii',
      validFm('FACT-2026-05-24-immut-iiiii').replace('status: active', 'status: BAD'));
    const beforeBytes = fs.readFileSync(filePath);
    const beforeMtime = fs.statSync(filePath).mtimeMs;

    // Force a measurable mtime gap so a stray write would be detectable.
    await new Promise((r) => setTimeout(r, 20));

    await schemaCheck.fix!(ctx(), await asResult(schemaCheck.run(ctx())), { dryRun: false });

    const afterBytes = fs.readFileSync(filePath);
    const afterMtime = fs.statSync(filePath).mtimeMs;
    expect(afterBytes.equals(beforeBytes)).toBe(true);
    expect(afterMtime).toBe(beforeMtime);
  });

  it('fix does not create a .bak when no migration is registered', async () => {
    const filePath = writeRawAtom(testDir, 'FACT-2026-05-24-nobak-jjjjj',
      validFm('FACT-2026-05-24-nobak-jjjjj').replace('status: active', 'status: BAD'));

    await schemaCheck.fix!(ctx(), await asResult(schemaCheck.run(ctx())), { dryRun: false });
    expect(fs.existsSync(filePath + '.bak')).toBe(false);
  });

  it('returns empty applied + empty remaining when there are no failing atoms', async () => {
    writeRawAtom(testDir, 'FACT-2026-05-24-good-kkkkk', validFm('FACT-2026-05-24-good-kkkkk'));

    const outcome = await schemaCheck.fix!(ctx(), await asResult(schemaCheck.run(ctx())), { dryRun: false });
    expect(outcome.applied).toHaveLength(0);
    expect(outcome.remaining).toHaveLength(0);
  });

  it('handles many failing atoms in one pass', async () => {
    for (const suffix of ['lllll', 'mmmmm', 'nnnnn', 'ooooo', 'ppppp']) {
      writeRawAtom(testDir, `FACT-2026-05-24-batch-${suffix}`,
        validFm(`FACT-2026-05-24-batch-${suffix}`).replace('status: active', 'status: BAD_X'));
    }
    const outcome = await schemaCheck.fix!(ctx(), await asResult(schemaCheck.run(ctx())), { dryRun: false });
    expect(outcome.remaining).toHaveLength(5);
    for (const suffix of ['lllll', 'mmmmm', 'nnnnn', 'ooooo', 'ppppp']) {
      expect(outcome.remaining.join('\n')).toContain(`FACT-2026-05-24-batch-${suffix}`);
    }
  });
});
