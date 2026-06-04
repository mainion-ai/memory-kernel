/**
 * Tests for per-check fix() implementations (#157 Phase 1).
 *
 * Each test drives the fix against a real but throwaway memory directory,
 * mirroring the style of test/doctor-store-checks.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

import {
  initMemoryDir,
  createAtom,
  closeAllIndexes,
  openIndex,
  reindex,
} from '../src/index.js';
import { initIsolatedBase, initAgentStore } from '../src/isolation.js';
import { storeSchemaCheck } from '../src/doctor/checks/store-schema.js';
import { storePermissionsCheck } from '../src/doctor/checks/store-permissions.js';
import { renderConfigCheck } from '../src/doctor/checks/render-config.js';
import type { CheckResult, DoctorContext } from '../src/doctor/types.js';

let testDir: string;

function ctx(): DoctorContext {
  return {
    memoryDir: testDir,
    kernelVersion: '1.24.3',
    skipCategories: new Set(),
    env: {},
  };
}

async function asResult(p: CheckResult | Promise<CheckResult>): Promise<CheckResult> {
  return await p;
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-doctor-fix-'));
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('storeSchemaCheck.fix', () => {
  it('reindexes when user_version is stale', async () => {
    initMemoryDir(testDir);
    openIndex(testDir);
    closeAllIndexes();

    // Force the DB to an older schema version.
    const dbPath = path.join(testDir, '.memory-index.db');
    {
      const db = new Database(dbPath);
      db.pragma('user_version = 6');
      db.close();
    }

    const before = await asResult(storeSchemaCheck.run(ctx()));
    expect(before.ok).toBe(false);
    expect(before.issues.join('\n')).toContain('schema version 6');

    expect(storeSchemaCheck.fix).toBeDefined();
    const outcome = await storeSchemaCheck.fix!(ctx(), before, { dryRun: false });
    expect(outcome.applied.length).toBeGreaterThan(0);
    expect(outcome.applied.join('\n')).toMatch(/reindex/i);

    // Verify post-fix state.
    closeAllIndexes(); // reindex may have opened it
    const after = await asResult(storeSchemaCheck.run(ctx()));
    expect(after.ok).toBe(true);
  });

  it('reports events.ndjson missing as remaining (not applied)', async () => {
    fs.mkdirSync(testDir, { recursive: true });
    const before = await asResult(storeSchemaCheck.run(ctx()));
    expect(before.ok).toBe(false);

    const outcome = await storeSchemaCheck.fix!(ctx(), before, { dryRun: false });
    expect(outcome.applied).toHaveLength(0);
    expect(outcome.remaining.join('\n')).toContain('events.ndjson');
  });

  it('dry-run does not write — user_version stays stale', async () => {
    initMemoryDir(testDir);
    openIndex(testDir);
    closeAllIndexes();
    const dbPath = path.join(testDir, '.memory-index.db');
    {
      const db = new Database(dbPath);
      db.pragma('user_version = 6');
      db.close();
    }

    const before = await asResult(storeSchemaCheck.run(ctx()));
    const outcome = await storeSchemaCheck.fix!(ctx(), before, { dryRun: true });
    expect(outcome.applied.join('\n')).toMatch(/would/i);

    // Confirm no write happened.
    const db = new Database(dbPath, { readonly: true });
    const v = db.pragma('user_version', { simple: true }) as number;
    db.close();
    expect(v).toBe(6);
  });
});

describe.skipIf(process.platform === 'win32')('storePermissionsCheck.fix', () => {
  it('chmods .memory-index.db back to 0o600', async () => {
    initMemoryDir(testDir);
    reindex(testDir);
    closeAllIndexes();
    const dbPath = path.join(testDir, '.memory-index.db');
    fs.chmodSync(dbPath, 0o644);

    const before = await asResult(storePermissionsCheck.run(ctx()));
    expect(before.ok).toBe(false);

    const outcome = await storePermissionsCheck.fix!(ctx(), before, { dryRun: false });
    expect(outcome.applied.join('\n')).toContain('.memory-index.db');

    const mode = fs.statSync(dbPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('chmods a SECRET atom file back to 0o600', async () => {
    const TEST_KEY = 'deadbeef'.repeat(8);
    process.env.MEMORY_ENCRYPTION_KEY = TEST_KEY;
    try {
      initMemoryDir(testDir);
      const atom = createAtom({
        memoryDir: testDir,
        agent_id: 'test',
        session_id: 'sess',
        type: 'fact',
        slug: 'top-secret',
        body: 'classified body',
        classification: 'SECRET',
      });
      closeAllIndexes();
      const atomPath = (atom as { filePath?: string }).filePath
        ?? path.join(testDir, 'ENTITIES', `${atom.frontmatter.id}.md`);
      fs.chmodSync(atomPath, 0o644);

      const before = await asResult(storePermissionsCheck.run(ctx()));
      expect(before.ok).toBe(false);
      expect(before.issues.join('\n')).toContain(atom.frontmatter.id);

      const outcome = await storePermissionsCheck.fix!(ctx(), before, { dryRun: false });
      expect(outcome.applied.join('\n')).toContain(atom.frontmatter.id);

      const mode = fs.statSync(atomPath).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      delete process.env.MEMORY_ENCRYPTION_KEY;
    }
  });

  it('dry-run does not chmod — mode stays permissive', async () => {
    initMemoryDir(testDir);
    reindex(testDir);
    closeAllIndexes();
    const dbPath = path.join(testDir, '.memory-index.db');
    fs.chmodSync(dbPath, 0o644);

    const before = await asResult(storePermissionsCheck.run(ctx()));
    const outcome = await storePermissionsCheck.fix!(ctx(), before, { dryRun: true });
    expect(outcome.applied.join('\n')).toMatch(/would/i);

    const mode = fs.statSync(dbPath).mode & 0o777;
    expect(mode).toBe(0o644);
  });
});

describe('renderConfigCheck.fix', () => {
  it('creates a missing render.yaml with DEFAULT_RENDER_CONFIG', async () => {
    initIsolatedBase(testDir, 'huston');
    initAgentStore(testDir, 'mai');
    const renderPath = path.join(testDir, 'agents', 'mai', 'render.yaml');
    fs.unlinkSync(renderPath);

    const before = await asResult(renderConfigCheck.run(ctx()));
    expect(before.ok).toBe(false);

    const outcome = await renderConfigCheck.fix!(ctx(), before, { dryRun: false });
    expect(outcome.applied.join('\n')).toContain('mai');
    expect(fs.existsSync(renderPath)).toBe(true);

    // Confirm subsequent run() returns ok.
    const after = await asResult(renderConfigCheck.run(ctx()));
    expect(after.ok).toBe(true);
  });

  it('refuses to overwrite an INVALID render.yaml — reports as remaining', async () => {
    initIsolatedBase(testDir, 'huston');
    initAgentStore(testDir, 'mai');
    const renderPath = path.join(testDir, 'agents', 'mai', 'render.yaml');
    const brokenContent = '{ broken: [unbalanced\n';
    fs.writeFileSync(renderPath, brokenContent);

    const before = await asResult(renderConfigCheck.run(ctx()));
    expect(before.ok).toBe(false);

    const outcome = await renderConfigCheck.fix!(ctx(), before, { dryRun: false });
    expect(outcome.applied).toHaveLength(0);
    expect(outcome.remaining.join('\n')).toContain('mai');
    expect(outcome.remaining.join('\n')).toMatch(/invalid|refuse/i);

    // File still contains the original broken content.
    expect(fs.readFileSync(renderPath, 'utf-8')).toBe(brokenContent);
  });

  it('dry-run does not create a missing render.yaml', async () => {
    initIsolatedBase(testDir, 'huston');
    initAgentStore(testDir, 'mai');
    const renderPath = path.join(testDir, 'agents', 'mai', 'render.yaml');
    fs.unlinkSync(renderPath);

    const before = await asResult(renderConfigCheck.run(ctx()));
    const outcome = await renderConfigCheck.fix!(ctx(), before, { dryRun: true });
    expect(outcome.applied.join('\n')).toMatch(/would/i);
    expect(fs.existsSync(renderPath)).toBe(false);
  });
});
