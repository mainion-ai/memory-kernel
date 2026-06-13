import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  initMemoryDir,
  listAtoms,
  readAtom,
  writeAtom,
  closeAllIndexes,
  seedLifecycle,
  runUpgrade,
} from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.resolve(__dirname, '../skills/mk-memory-setup/seed-atoms/lifecycle');
const TO = '1.33.0';

let testDir: string;
let calls: string[];

/** Injectables that record invocation and never touch the network. */
function fakes(probeVersion: string | null = TO) {
  calls = [];
  return {
    installer: (bin: string, ver: string) => { calls.push(`install ${ver} @ ${bin}`); },
    versionProbe: (bin: string) => { calls.push(`probe ${bin}`); return probeVersion; },
    cronRegen: (bin: string, wrapper: string) => { calls.push(`cron ${wrapper}`); },
  };
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-upgrade-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('runUpgrade (#331)', () => {
  it('happy path → PASS, all steps ok, seeds + doctor run for real', async () => {
    const f = fakes(TO);
    const r = await runUpgrade({
      to: TO, memoryDir: testDir, mkBin: '/opt/agent/bin/mk', seedDir: SEED_DIR,
      env: {}, installer: f.installer, versionProbe: f.versionProbe, cronRegen: f.cronRegen,
    });
    expect(r.pass).toBe(true);
    expect(r.steps.find((s) => s.step === 'install')?.ok).toBe(true);
    expect(r.steps.find((s) => s.step === 'verify-agent-version')?.ok).toBe(true);
    expect(r.steps.find((s) => s.step === 'doctor-gate')?.ok).toBe(true);
    expect(r.doctor?.exit_code).not.toBe(2);
    // Seed actually happened: canonical atoms now active in the store.
    expect(listAtoms(testDir).filter((a) => a.frontmatter.status === 'active').length).toBeGreaterThanOrEqual(11);
    expect(calls).toContain(`install ${TO} @ /opt/agent/bin/mk`);
  });

  it('hard-fails when the runner version differs from --to (review finding 3b)', async () => {
    const f = fakes(TO);
    const r = await runUpgrade({
      to: TO, memoryDir: testDir, mkBin: '/opt/agent/bin/mk', seedDir: SEED_DIR, env: {},
      runningVersion: '1.31.0', // running an OLD mk → its seed set + gate are wrong
      installer: f.installer, versionProbe: f.versionProbe, cronRegen: f.cronRegen,
    });
    expect(r.pass).toBe(false);
    const runner = r.steps.find((s) => s.step === 'verify-runner');
    expect(runner?.ok).toBe(false);
    expect(runner?.detail).toContain('npx memory-kernel@1.33.0');
  });

  it('runner check passes when running version matches --to (v-prefix tolerant)', async () => {
    const f = fakes(TO);
    const r = await runUpgrade({
      to: 'v1.33.0', memoryDir: testDir, mkBin: '/opt/agent/bin/mk', seedDir: SEED_DIR, env: {},
      runningVersion: '1.33.0', // bare vs v-prefixed must compare equal
      installer: f.installer, versionProbe: f.versionProbe, cronRegen: f.cronRegen,
    });
    expect(r.steps.find((s) => s.step === 'verify-runner')?.ok).toBe(true);
    // probe returns '1.33.0', target 'v1.33.0' → still a match.
    expect(r.steps.find((s) => s.step === 'verify-agent-version')?.ok).toBe(true);
  });

  it('resolves the binary from env.MK_BIN when --mk-bin is absent', async () => {
    const f = fakes(TO);
    const r = await runUpgrade({
      to: TO, memoryDir: testDir, seedDir: SEED_DIR,
      env: { MK_BIN: '/group/npm/bin/mk' },
      installer: f.installer, versionProbe: f.versionProbe, cronRegen: f.cronRegen,
    });
    expect(r.mk_bin).toBe('/group/npm/bin/mk');
    expect(r.steps[0]).toMatchObject({ step: 'resolve-binary', ok: true });
  });

  it('missing MK_BIN → hard FAIL, no install attempted', async () => {
    const f = fakes(TO);
    const r = await runUpgrade({
      to: TO, memoryDir: testDir, seedDir: SEED_DIR, env: {},
      installer: f.installer, versionProbe: f.versionProbe, cronRegen: f.cronRegen,
    });
    expect(r.pass).toBe(false);
    expect(r.mk_bin).toBeNull();
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0].step).toBe('resolve-binary');
    expect(calls).toEqual([]); // never tried to install
  });

  it('post-install version mismatch → verify step fails → overall FAIL', async () => {
    const f = fakes('1.28.3'); // stale binary still reports old version
    const r = await runUpgrade({
      to: TO, memoryDir: testDir, mkBin: '/opt/agent/bin/mk', seedDir: SEED_DIR, env: {},
      installer: f.installer, versionProbe: f.versionProbe, cronRegen: f.cronRegen,
    });
    expect(r.pass).toBe(false);
    const verify = r.steps.find((s) => s.step === 'verify-agent-version');
    expect(verify?.ok).toBe(false);
    expect(verify?.detail).toContain('1.28.3');
  });

  it('doctor gate fails (FAIL) when the seed set is left incomplete', async () => {
    // Pre-seed, then remove a canonical atom so seed-set-freshness errors.
    seedLifecycle({ memoryDir: testDir, seedDir: SEED_DIR, agent_id: 't', session_id: 't' });
    const target = listAtoms(testDir).find(
      (a) => a.frontmatter.status === 'active' && a.frontmatter.id.includes('DIAGNOSTICS-PROCEDURE'),
    )!;
    const atom = readAtom(target.filePath!);
    atom.frontmatter.status = 'superseded';
    writeAtom(atom, target.filePath!);

    // A seed step that does nothing (so the gap persists) — simulates a re-seed
    // pointed at a stale seed dir that lacks the slug.
    const f = fakes(TO);
    const emptySeedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-upgrade-emptyseed-'));
    fs.writeFileSync(path.join(emptySeedDir, 'manifest.json'), JSON.stringify({ version: 1, atoms: [] }));

    const r = await runUpgrade({
      to: TO, memoryDir: testDir, mkBin: '/opt/agent/bin/mk', seedDir: emptySeedDir, env: {},
      installer: f.installer, versionProbe: f.versionProbe, cronRegen: f.cronRegen,
    });
    fs.rmSync(emptySeedDir, { recursive: true, force: true });

    expect(r.doctor?.exit_code).toBe(2);
    expect(r.steps.find((s) => s.step === 'doctor-gate')?.ok).toBe(false);
    expect(r.pass).toBe(false);
  });

  it('--dry-run: install/verify/cron skipped, no writes, no external effects', async () => {
    const before = listAtoms(testDir).length;
    const f = fakes(TO);
    const r = await runUpgrade({
      to: TO, memoryDir: testDir, mkBin: '/opt/agent/bin/mk', cronWrapper: '/tmp/wrapper.sh',
      seedDir: SEED_DIR, dryRun: true, env: {},
      installer: f.installer, versionProbe: f.versionProbe, cronRegen: f.cronRegen,
    });
    expect(r.dry_run).toBe(true);
    expect(r.steps.find((s) => s.step === 'install')?.skipped).toBe(true);
    expect(r.steps.find((s) => s.step === 'verify-agent-version')?.skipped).toBe(true);
    expect(r.steps.find((s) => s.step === 'cron')?.skipped).toBe(true);
    expect(calls).toEqual([]); // no installer/probe/cron invoked
    expect(listAtoms(testDir).length).toBe(before); // no atoms written
  });

  it('regenerates the cron wrapper when --cron-wrapper is given', async () => {
    const f = fakes(TO);
    const r = await runUpgrade({
      to: TO, memoryDir: testDir, mkBin: '/opt/agent/bin/mk', cronWrapper: '/etc/agent/sync.sh',
      seedDir: SEED_DIR, env: {},
      installer: f.installer, versionProbe: f.versionProbe, cronRegen: f.cronRegen,
    });
    const cron = r.steps.find((s) => s.step === 'cron');
    expect(cron?.ok).toBe(true);
    expect(cron?.skipped).toBeUndefined();
    expect(calls).toContain('cron /etc/agent/sync.sh');
  });
});
