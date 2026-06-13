/**
 * Tests for the integration-health doctor checks (#305):
 * mk-version, embedding-key-source, embeddings-vectors-fresh, smoke-recall,
 * sync-liveness.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import Database from 'better-sqlite3';
import { initMemoryDir, createAtom, reindex, closeAllIndexes } from '../src/index.js';
import type { CheckResult, DoctorContext } from '../src/doctor/types.js';
import {
  diagnoseVersion,
  diagnoseMkBin,
  diagnoseSyncLiveness,
  mkVersionCheck,
  embeddingKeySourceCheck,
  vectorsFreshCheck,
  smokeRecallCheck,
  syncLivenessCheck,
} from '../src/doctor/checks/integration-health.js';

let testDir: string;

function ctx(env: NodeJS.ProcessEnv = {}): DoctorContext {
  return { memoryDir: testDir, kernelVersion: '1.31.0', skipCategories: new Set(), env };
}
async function runCheck(check: { run: (c: DoctorContext) => CheckResult | Promise<CheckResult> }, env?: NodeJS.ProcessEnv) {
  const r = check.run(ctx(env));
  return r instanceof Promise ? await r : r;
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-doctor-integ-'));
  initMemoryDir(testDir);
});
afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

const base = (dir: string) => ({ memoryDir: dir, agent_id: 'a', session_id: 's' });

// --- (a) diagnoseVersion (pure) -------------------------------------------

describe('diagnoseVersion', () => {
  it('matches → ok', () => {
    const r = diagnoseVersion('1.31.0', '1.31.0', '/usr/local/bin/mk');
    expect(r.ok).toBe(true);
    expect(r.issues[0]).toContain('1.31.0');
  });
  it('mismatch → not ok (stale binary shadowing)', () => {
    const r = diagnoseVersion('1.31.0', '1.29.0', '/usr/local/bin/mk');
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatch(/mismatch/);
    expect(r.issues[0]).toContain('1.29.0');
  });
  it('no mk on PATH → ok (nothing to shadow)', () => {
    const r = diagnoseVersion('1.31.0', null, null);
    expect(r.ok).toBe(true);
    expect(r.issues[0]).toMatch(/no `mk` on PATH/);
  });
});

// --- (a2) diagnoseMkBin (pure, #330) --------------------------------------

describe('diagnoseMkBin', () => {
  it('MK_BIN unset → ok, no issues', () => {
    const r = diagnoseMkBin('1.33.0', null, null);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });
  it('MK_BIN matches kernel → ok, reports the agent binary', () => {
    const r = diagnoseMkBin('1.33.0', '1.33.0', '/opt/agent/bin/mk');
    expect(r.ok).toBe(true);
    expect(r.issues[0]).toContain('/opt/agent/bin/mk');
    expect(r.issues[0]).toMatch(/agent binary/i);
  });
  it('MK_BIN version differs from kernel → not ok (agent on a stale binary)', () => {
    const r = diagnoseMkBin('1.33.0', '1.28.3', '/opt/agent/bin/mk');
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toContain('1.28.3');
    expect(r.issues[0]).toContain('1.33.0');
  });
  it('MK_BIN set but unrunnable → not ok', () => {
    const r = diagnoseMkBin('1.33.0', null, '/opt/agent/bin/mk');
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatch(/did not run|missing|broken/);
  });
});

describe('mkVersionCheck honors MK_BIN', () => {
  it('reports the agent binary version when MK_BIN points at a runnable mk', () => {
    // A fake `mk` that prints a version mismatching the kernel under test.
    const fakeBin = path.join(testDir, 'fake-mk.sh');
    fs.writeFileSync(fakeBin, '#!/usr/bin/env bash\necho "9.9.9"\n');
    fs.chmodSync(fakeBin, 0o755);

    const r = mkVersionCheck.run(ctx({ MK_BIN: fakeBin })) as CheckResult;
    expect(r.issues.join(' ')).toContain('9.9.9');
    // kernel under test is 1.31.0 → mismatch → warn.
    expect(r.ok).toBe(false);
    expect(r.severity).toBe('warn');
  });
});

// --- (b) embedding-key-source ---------------------------------------------

describe('embedding-key-source check', () => {
  it('provider=none → info, recall is FTS-only', async () => {
    const r = await runCheck(embeddingKeySourceCheck, { EMBEDDING_PROVIDER: 'none' });
    expect(r.ok).toBe(true);
    expect(r.severity).toBe('info');
    expect(r.issues[0]).toMatch(/disabled|FTS-only/);
  });
  it('provider set but no key → warn', async () => {
    const r = await runCheck(embeddingKeySourceCheck, { EMBEDDING_PROVIDER: 'openai' });
    expect(r.ok).toBe(false);
    expect(r.severity).toBe('warn');
    expect(r.issues[0]).toMatch(/no key resolved/);
  });
  it('EMBEDDING_API_KEY wins and is reported as the source (value never leaked)', async () => {
    const r = await runCheck(embeddingKeySourceCheck, { EMBEDDING_PROVIDER: 'openai', EMBEDDING_API_KEY: 'sk-SECRETVALUE1234' });
    expect(r.ok).toBe(true);
    expect(r.issues[0]).toContain('EMBEDDING_API_KEY');
    expect(r.issues[0]).toContain('1234');           // last-4 tail
    expect(r.issues[0]).not.toContain('SECRETVALUE'); // never the full key
  });
  it('OPENAI_API_KEY reported as fallback source', async () => {
    const r = await runCheck(embeddingKeySourceCheck, { EMBEDDING_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-abcdwxyz' });
    expect(r.ok).toBe(true);
    expect(r.issues[0]).toContain('OPENAI_API_KEY');
    expect(r.issues[0]).toMatch(/fallback/);
  });
});

// --- (c) embeddings-vectors-fresh -----------------------------------------

describe('embeddings-vectors-fresh check', () => {
  it('embeddings off → info (not applicable)', async () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'f', body: 'content' });
    reindex(testDir);
    const r = await runCheck(vectorsFreshCheck, { EMBEDDING_PROVIDER: 'none' });
    expect(r.ok).toBe(true);
    expect(r.severity).toBe('info');
  });
  it('configured but 0 vectors for >0 atoms → warn (embedding stalled)', async () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'f', body: 'content' });
    reindex(testDir); // builds atoms, no embeddings
    const r = await runCheck(vectorsFreshCheck, { EMBEDDING_PROVIDER: 'openai', EMBEDDING_API_KEY: 'sk-x' });
    expect(r.ok).toBe(false);
    expect(r.severity).toBe('warn');
    expect(r.issues[0]).toMatch(/0 vectors/);
  });
  it('configured but no index → warn', async () => {
    const r = await runCheck(vectorsFreshCheck, { EMBEDDING_PROVIDER: 'openai', EMBEDDING_API_KEY: 'sk-x' });
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatch(/no index/);
  });
});

// --- (d) smoke-recall ------------------------------------------------------

describe('smoke-recall check', () => {
  it('no index → info', async () => {
    const r = await runCheck(smokeRecallCheck, {});
    expect(r.ok).toBe(true);
    expect(r.issues[0]).toMatch(/no index/);
  });
  it('with index → recall pipeline returns without error (no egress, no embed opt-in)', async () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'f', body: 'pagination cursor' });
    reindex(testDir);
    const r = await runCheck(smokeRecallCheck, {}); // no MK_DOCTOR_SMOKE_EMBED → no egress
    expect(r.ok).toBe(true);
    expect(r.issues[0]).toMatch(/queryable/);
  });
  it('default probe is read-only and side-effect-free (no openIndex migration)', async () => {
    // Stale the index schema; a plain doctor run must NOT migrate it.
    createAtom({ ...base(testDir), type: 'fact', slug: 'f', body: 'content' });
    reindex(testDir);
    closeAllIndexes();
    const dbPath = path.join(testDir, '.memory-index.db');
    const raw = new Database(dbPath);
    raw.pragma('user_version = 6');
    raw.close();

    const r = await runCheck(smokeRecallCheck, {});
    expect(r.ok).toBe(true);

    // Schema version must be untouched by the check (no migration side effect).
    const after = new Database(dbPath, { readonly: true });
    const v = after.pragma('user_version', { simple: true }) as number;
    after.close();
    expect(v).toBe(6);
  });
});

// --- (e) sync-liveness -----------------------------------------------------

describe('diagnoseSyncLiveness (pure)', () => {
  it('no index → info ok', () => {
    const r = diagnoseSyncLiveness(null, Date.now(), 30, true);
    expect(r.ok).toBe(true);
    expect(r.severity).toBe('info');
  });
  it('fresh → ok', () => {
    const now = 1_000_000_000_000;
    const r = diagnoseSyncLiveness(now - 2 * 3600_000, now, 30, true);
    expect(r.ok).toBe(true);
  });
  it('stale + cadence expected → warn', () => {
    const now = 1_000_000_000_000;
    const r = diagnoseSyncLiveness(now - 40 * 3600_000, now, 30, true);
    expect(r.ok).toBe(false);
    expect(r.severity).toBe('warn');
    expect(r.issues[0]).toMatch(/silently stopped/);
  });
  it('stale but NO cadence declared → info, not a false-positive warn', () => {
    const now = 1_000_000_000_000;
    const r = diagnoseSyncLiveness(now - 40 * 3600_000, now, 30, false);
    expect(r.ok).toBe(true);
    expect(r.severity).toBe('info');
    expect(r.issues[0]).toMatch(/MK_SYNC_MAX_AGE_HOURS/);
  });
});

describe('sync-liveness check (integration)', () => {
  it('idle store with no declared cadence does not warn (no false positive)', async () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'f', body: 'content' });
    reindex(testDir);
    const dbPath = path.join(testDir, '.memory-index.db');
    const old = new Date(Date.now() - 40 * 3600_000);
    fs.utimesSync(dbPath, old, old);

    const r = await runCheck(syncLivenessCheck, {}); // no MK_SYNC_MAX_AGE_HOURS
    expect(r.ok).toBe(true);
    expect(r.severity).toBe('info');
  });

  it('with a declared cadence: fresh → ok, backdated → warn, generous override → ok', async () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'f', body: 'content' });
    reindex(testDir);

    const fresh = await runCheck(syncLivenessCheck, { MK_SYNC_MAX_AGE_HOURS: '30' });
    expect(fresh.ok).toBe(true);

    const dbPath = path.join(testDir, '.memory-index.db');
    const old = new Date(Date.now() - 40 * 3600_000);
    fs.utimesSync(dbPath, old, old);

    const stale = await runCheck(syncLivenessCheck, { MK_SYNC_MAX_AGE_HOURS: '30' });
    expect(stale.ok).toBe(false);
    expect(stale.severity).toBe('warn');

    const overridden = await runCheck(syncLivenessCheck, { MK_SYNC_MAX_AGE_HOURS: '100' });
    expect(overridden.ok).toBe(true);
  });
});
