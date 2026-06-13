/**
 * `mk upgrade` — host-side one-command agent upgrade (#331).
 *
 * Upgrading an agent is a multi-step dance with a wrong-binary footgun: a host
 * can have several `mk`s (global, the group-npm `MK_BIN` the agent actually
 * runs, a dev clone), a non-idempotent re-seed, a cron wrapper to regenerate,
 * and a doctor run against the right dir. This sequences all of it and prints
 * one PASS/FAIL.
 *
 * EXPLICITLY HOST-SIDE: the agent cannot upgrade its own in-container binary —
 * `mk upgrade` runs on the host, and `mk doctor` (#330) is how the agent later
 * *knows* the upgrade took. Invoke from the TARGET version
 * (`npx memory-kernel@<ver> upgrade --to <ver>`) so the in-process seed bodies,
 * canonical slug set, and reported kernel version are the target's.
 *
 * The three external effects (npm install, version probe, cron regen) are
 * injectable so the orchestration is testable without a network or a live agent.
 */
import path from 'path';
import { execFileSync } from 'child_process';
import { seedLifecycle, type SeedResult } from './seed.js';
import { runDoctor } from './doctor/run.js';
import type { CheckResult } from './doctor/types.js';

export interface UpgradeOptions {
  /** Target version to install at the agent binary. */
  to: string;
  /** The kernel/ store to seed + doctor. */
  memoryDir: string;
  /**
   * Version of the `mk` running this upgrade. The seed bodies, canonical slug
   * set, and doctor gate all come from THIS process — so if it differs from
   * `to`, the upgrade would seed+validate the wrong version's set (the exact
   * v1.32.0 "re-seeded the old set, doctor green" incident). When provided and
   * ≠ `to`, the runner check hard-fails. Omit to skip the guard (programmatic
   * callers that know what they're doing); the CLI always passes it.
   */
  runningVersion?: string;
  /** Path to the agent's real binary; defaults to env.MK_BIN. */
  mkBin?: string;
  /** Cron wrapper to regenerate (`mk init --cron --update`); skipped if absent. */
  cronWrapper?: string;
  env?: NodeJS.ProcessEnv;
  dryRun?: boolean;
  /** Override the shipped lifecycle seed dir (testing). */
  seedDir?: string;
  /** Install `memory-kernel@<version>` at the binary's npm prefix. Injectable. */
  installer?: (mkBin: string, version: string) => void;
  /** Probe `<mkBin> --version`. Injectable. Returns null if it won't run. */
  versionProbe?: (mkBin: string) => string | null;
  /** Regenerate the cron wrapper at `wrapper`. Injectable. */
  cronRegen?: (mkBin: string, wrapper: string) => void;
}

export interface UpgradeStep {
  step: string;
  ok: boolean;
  skipped?: boolean;
  detail: string;
}

export interface UpgradeResult {
  pass: boolean;
  to: string;
  mk_bin: string | null;
  dry_run: boolean;
  steps: UpgradeStep[];
  seed?: SeedResult;
  doctor?: { exit_code: 0 | 1 | 2; issues: string[] };
}

// --- default external effects (real; replaced by injectables in tests) -------

function defaultInstaller(mkBin: string, version: string): void {
  // <prefix>/bin/mk → prefix = dirname(dirname(mkBin)). Targeting npm at that
  // prefix installs the binary exactly where MK_BIN points.
  const prefix = path.dirname(path.dirname(mkBin));
  execFileSync('npm', ['install', '-g', `memory-kernel@${version}`], {
    stdio: 'pipe',
    timeout: 180_000,
    env: { ...process.env, npm_config_prefix: prefix },
  });
}

function defaultVersionProbe(mkBin: string): string | null {
  try {
    const raw = execFileSync(mkBin, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
    return raw.split(/\s+/).pop() || null;
  } catch {
    return null;
  }
}

function defaultCronRegen(mkBin: string, wrapper: string): void {
  execFileSync(mkBin, ['init', '--cron', '--update', '--output', wrapper], {
    stdio: 'pipe',
    timeout: 30_000,
  });
}

/** Compare versions tolerant of a leading `v` (e.g. `v1.33.0` === `1.33.0`). */
function sameVersion(a: string | null, b: string | null): boolean {
  if (a == null || b == null) return false;
  return a.replace(/^v/, '') === b.replace(/^v/, '');
}

/** Join one named doctor check's issues for the summary, '' if absent. */
function checkLine(results: readonly CheckResult[], name: string): string {
  const r = results.find((x) => x.name === name);
  return r ? r.issues.join('; ') : '';
}

/**
 * Run the host-side upgrade sequence. Never throws for an expected failure —
 * returns a structured result with `pass` and per-step detail.
 */
export async function runUpgrade(opts: UpgradeOptions): Promise<UpgradeResult> {
  const env = opts.env ?? process.env;
  const dryRun = opts.dryRun ?? false;
  const installer = opts.installer ?? defaultInstaller;
  const versionProbe = opts.versionProbe ?? defaultVersionProbe;
  const cronRegen = opts.cronRegen ?? defaultCronRegen;
  const steps: UpgradeStep[] = [];

  // 1. resolve-binary
  const mkBin = opts.mkBin ?? env.MK_BIN ?? null;
  if (!mkBin) {
    steps.push({
      step: 'resolve-binary', ok: false,
      detail: 'MK_BIN not set and --mk-bin not given — cannot tell which binary the agent runs. Pass --mk-bin <path> or set MK_BIN.',
    });
    return { pass: false, to: opts.to, mk_bin: null, dry_run: dryRun, steps };
  }
  steps.push({ step: 'resolve-binary', ok: true, detail: `agent binary: ${mkBin}` });

  // 1b. verify-runner — the seed set + doctor gate come from THIS process, so a
  // runner whose version ≠ `to` would seed+validate the wrong version's set.
  if (opts.runningVersion === undefined) {
    steps.push({
      step: 'verify-runner', ok: true, skipped: true,
      detail: "runner version not provided — seed set + gate use this process's shipped set",
    });
  } else if (!sameVersion(opts.runningVersion, opts.to)) {
    steps.push({
      step: 'verify-runner', ok: false,
      detail: `this \`mk upgrade\` is running from ${opts.runningVersion}, not ${opts.to} — its bundled seed set and doctor gate validate against ${opts.runningVersion}, not the target. Re-run from the target: \`npx memory-kernel@${opts.to} upgrade --to ${opts.to}\``,
    });
  } else {
    steps.push({ step: 'verify-runner', ok: true, detail: `runner is memory-kernel@${opts.runningVersion} (matches target)` });
  }

  // 2. install
  if (dryRun) {
    steps.push({ step: 'install', ok: true, skipped: true, detail: `[dry-run] would install memory-kernel@${opts.to} at ${mkBin}` });
  } else {
    try {
      installer(mkBin, opts.to);
      steps.push({ step: 'install', ok: true, detail: `installed memory-kernel@${opts.to} at ${mkBin}` });
    } catch (err) {
      steps.push({ step: 'install', ok: false, detail: `install failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  // 3. verify-agent-version
  if (dryRun) {
    steps.push({ step: 'verify-agent-version', ok: true, skipped: true, detail: `[dry-run] would verify ${mkBin} reports ${opts.to}` });
  } else {
    const probed = versionProbe(mkBin);
    const ok = sameVersion(probed, opts.to);
    steps.push({
      step: 'verify-agent-version', ok,
      detail: ok
        ? `${mkBin} is mk ${probed}`
        : `${mkBin} reports ${probed ?? '(unrunnable)'}, expected ${opts.to}`,
    });
  }

  // 4. seed (idempotent — safe even in the partial-failure case above)
  let seed: SeedResult | undefined;
  try {
    seed = seedLifecycle({ memoryDir: opts.memoryDir, seedDir: opts.seedDir, dryRun });
    const prefix = dryRun ? '[dry-run] ' : '';
    steps.push({
      step: 'seed', ok: true,
      detail: `${prefix}created ${seed.created}, updated ${seed.updated}, unchanged ${seed.unchanged}, deduped ${seed.deduped}`,
    });
  } catch (err) {
    steps.push({ step: 'seed', ok: false, detail: `seed failed: ${err instanceof Error ? err.message : String(err)}` });
  }

  // 5. cron
  if (!opts.cronWrapper) {
    steps.push({ step: 'cron', ok: true, skipped: true, detail: 'no --cron-wrapper given — skipping cron regen' });
  } else if (dryRun) {
    steps.push({ step: 'cron', ok: true, skipped: true, detail: `[dry-run] would regenerate ${opts.cronWrapper}` });
  } else {
    try {
      cronRegen(mkBin, opts.cronWrapper);
      steps.push({ step: 'cron', ok: true, detail: `regenerated cron wrapper ${opts.cronWrapper}` });
    } catch (err) {
      steps.push({ step: 'cron', ok: false, detail: `cron regen failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  // 6. doctor-gate — read-only; PASS = no error-severity issues (warnings inform).
  const { results, exitCode } = await runDoctor({
    memoryDir: opts.memoryDir,
    kernelVersion: opts.to,
    skipCategories: new Set(),
    env: { ...env, MK_BIN: mkBin },
  });
  const doctorOk = exitCode !== 2;
  const summary = [
    checkLine(results, 'mk-version'),
    checkLine(results, 'seed-set-freshness'),
    checkLine(results, 'embedding-key-source'),
  ].filter(Boolean);
  steps.push({
    step: 'doctor-gate', ok: doctorOk,
    detail: doctorOk ? `doctor: no errors (exit ${exitCode})` : `doctor: error-severity issues (exit ${exitCode})`,
  });

  const pass = steps.every((s) => s.ok || s.skipped);
  return {
    pass,
    to: opts.to,
    mk_bin: mkBin,
    dry_run: dryRun,
    steps,
    seed,
    doctor: { exit_code: exitCode, issues: summary },
  };
}
