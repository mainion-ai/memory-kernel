/**
 * doctor — integration-health checks (#305).
 *
 * After the v1.29→1.30→1.31 upgrade chain, `mk doctor` could not answer the
 * questions operators actually ask after an upgrade or incident:
 *   - What version is running, and is a stale binary shadowing it on PATH?
 *   - Which embedding key source resolved (EMBEDDING_API_KEY vs the
 *     OPENAI_API_KEY fallback)?
 *   - Are vectors current, or did embedding silently stall (key set, 0 vectors)?
 *   - Does recall work end-to-end?
 *   - Is the nightly sync/reindex still alive, or did it silently stop?
 *
 * These checks are additive and side-effect-free. Boundary: doctor =
 * *integration* health; knowledge/composition health (e.g. belief monoculture)
 * stays in `mk lint` (#316).
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import Database from 'better-sqlite3';
import type { Check, CheckResult, DoctorContext } from '../types.js';
import { resolveEmbeddingKeySource, getEmbeddingConfig } from '../../embeddings.js';

const DB_FILENAME = '.memory-index.db';

/**
 * Open the index READ-ONLY for diagnostics. Critical: these checks must be
 * side-effect-free, so they must NOT go through `openIndex()` (which
 * auto-migrates the schema on open — a mutation a plain `mk doctor` must never
 * perform; detecting stale schema is store-schema's job). A read-only handle
 * also physically blocks writes. Returns null if the index file is absent.
 */
function openIndexReadonly(memoryDir: string): Database.Database | null {
  const dbPath = path.join(memoryDir, DB_FILENAME);
  if (!fs.existsSync(dbPath)) return null;
  return new Database(dbPath, { readonly: true });
}
const DEFAULT_SYNC_MAX_AGE_HOURS = 30; // nightly cadence + slack; see #284/#269

// --- (a) mk-version --------------------------------------------------------

/**
 * Pure version diagnosis — compares the running kernel version against the
 * version reported by the `mk` binary resolved on PATH. Extracted so the
 * comparison logic is unit-testable without shelling out.
 */
export function diagnoseVersion(
  kernelVersion: string,
  pathVersion: string | null,
  pathLocation: string | null,
): { ok: boolean; issues: string[] } {
  if (!pathVersion || !pathLocation) {
    // No `mk` on PATH (running via npx / node / local dist) — nothing to shadow.
    return { ok: true, issues: [`running kernel ${kernelVersion}; no \`mk\` on PATH to compare`] };
  }
  if (pathVersion === kernelVersion) {
    return { ok: true, issues: [`mk ${kernelVersion} (PATH: ${pathLocation})`] };
  }
  return {
    ok: false,
    issues: [
      `version mismatch: running kernel ${kernelVersion}, but \`mk\` on PATH is ${pathVersion} (${pathLocation}) — a stale binary is shadowing the release; reinstall or fix PATH`,
    ],
  };
}

function resolvePathMk(): { version: string | null; location: string | null } {
  try {
    // 5s timeout on both shell-outs: a stale/broken shadowing `mk` (exactly what
    // this check hunts for) might hang; the timeout throws and the catch degrades
    // gracefully rather than blocking the whole `mk doctor` run.
    const location = execFileSync('sh', ['-c', 'command -v mk'], { encoding: 'utf8', timeout: 5000 }).trim() || null;
    if (!location) return { version: null, location: null };
    const raw = execFileSync('mk', ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
    // `mk --version` prints the bare semver (commander default) — take the last token.
    const version = raw.split(/\s+/).pop() || null;
    return { version, location };
  } catch {
    return { version: null, location: null };
  }
}

/**
 * Pure diagnosis of the AGENT binary — the `mk` the cron wrapper invokes via
 * `MK_BIN` (#330). A host can have several `mk`s at different versions; the
 * agent-relevant one is whatever `MK_BIN` points at, which may differ from both
 * the PATH `mk` and the kernel running this doctor. `binVersion === null` with
 * a `binPath` set means MK_BIN is set but the binary wouldn't run.
 */
export function diagnoseMkBin(
  kernelVersion: string,
  binVersion: string | null,
  binPath: string | null,
): { ok: boolean; issues: string[] } {
  if (!binPath) {
    // MK_BIN not set — nothing to report (the PATH diagnosis covers the rest).
    return { ok: true, issues: [] };
  }
  if (!binVersion) {
    return {
      ok: false,
      issues: [`MK_BIN is set to ${binPath} but \`${binPath} --version\` did not run — the agent's binary is missing or broken`],
    };
  }
  if (binVersion === kernelVersion) {
    return { ok: true, issues: [`agent binary (MK_BIN): mk ${binVersion} at ${binPath}`] };
  }
  return {
    ok: false,
    issues: [
      `agent binary (MK_BIN) at ${binPath} is mk ${binVersion}, but this kernel is ${kernelVersion} — the agent is running a different version; reinstall at MK_BIN or update the wrapper`,
    ],
  };
}

function resolveMkBin(env: NodeJS.ProcessEnv): { version: string | null; location: string | null } {
  const binPath = env.MK_BIN;
  if (!binPath) return { version: null, location: null };
  try {
    const raw = execFileSync(binPath, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
    const version = raw.split(/\s+/).pop() || null;
    return { version, location: binPath };
  } catch {
    // Set but unrunnable — report the path so diagnoseMkBin can flag it.
    return { version: null, location: binPath };
  }
}

export const mkVersionCheck: Check = {
  name: 'mk-version',
  category: 'binary',
  defaultSeverity: 'warn',
  run(ctx: DoctorContext): CheckResult {
    const pathMk = resolvePathMk();
    const path = diagnoseVersion(ctx.kernelVersion, pathMk.version, pathMk.location);
    // Also verify the binary the AGENT actually runs (MK_BIN), not just PATH.
    const bin = resolveMkBin(ctx.env);
    const agent = diagnoseMkBin(ctx.kernelVersion, bin.version, bin.location);
    const ok = path.ok && agent.ok;
    // Only a genuine mismatch is a warning; "matches" / "nothing to compare" are info.
    return {
      name: 'mk-version', category: 'binary', severity: ok ? 'info' : 'warn', ok,
      issues: [...path.issues, ...agent.issues],
    };
  },
};

// --- (b) embedding-key-source ---------------------------------------------

export const embeddingKeySourceCheck: Check = {
  name: 'embedding-key-source',
  category: 'binary',
  defaultSeverity: 'warn',
  run(ctx: DoctorContext): CheckResult {
    const src = resolveEmbeddingKeySource(ctx.env);
    if (src.provider === 'none') {
      return {
        name: 'embedding-key-source', category: 'binary', severity: 'info', ok: true,
        issues: ['embeddings disabled (EMBEDDING_PROVIDER=none) — recall runs FTS-only'],
      };
    }
    if (!src.configured) {
      return {
        name: 'embedding-key-source', category: 'binary', severity: 'warn', ok: false,
        issues: [
          `EMBEDDING_PROVIDER=${src.provider} but no key resolved — set EMBEDDING_API_KEY ` +
          `(or the ${src.provider === 'openai' ? 'OPENAI_API_KEY' : 'VOYAGE_API_KEY'} fallback). Recall silently degrades to FTS-only.`,
        ],
      };
    }
    // Configured: report the resolved source (never the key value). keyTail is
    // empty for short/placeholder keys (see resolveEmbeddingKeySource) — omit
    // the tail rather than risk exposing the whole secret.
    const via = src.keySource === 'EMBEDDING_API_KEY' ? src.keySource : `${src.keySource} (fallback)`;
    const tail = src.keyTail ? ` (…${src.keyTail})` : '';
    return {
      name: 'embedding-key-source', category: 'binary', severity: 'info', ok: true,
      issues: [`embeddings: ${src.provider} via ${via}${tail}`],
    };
  },
};

// --- (c) embeddings-vectors-fresh -----------------------------------------

export const vectorsFreshCheck: Check = {
  name: 'embeddings-vectors-fresh',
  category: 'memory',
  defaultSeverity: 'warn',
  skipWhen: ['store'],
  run(ctx: DoctorContext): CheckResult {
    const configured = resolveEmbeddingKeySource(ctx.env).configured;
    if (!configured) {
      return {
        name: 'embeddings-vectors-fresh', category: 'memory', severity: 'info', ok: true,
        issues: ['embeddings not configured — vector freshness not applicable'],
      };
    }
    let atoms = 0;
    let embeddings = 0;
    try {
      const db = openIndexReadonly(ctx.memoryDir);
      if (!db) {
        return {
          name: 'embeddings-vectors-fresh', category: 'memory', severity: 'warn', ok: false,
          issues: ['no index — run `mk reindex --embed`'],
        };
      }
      try {
        atoms = (db.prepare('SELECT COUNT(*) as c FROM atoms').get() as { c: number }).c;
        try {
          embeddings = (db.prepare('SELECT COUNT(*) as c FROM atom_embeddings').get() as { c: number }).c;
        } catch { /* table absent on older schema — treat as 0 vectors */ }
      } finally {
        db.close();
      }
    } catch (err) {
      // Corrupt/unreadable index → graceful warn, not a hard error (exit 2).
      return {
        name: 'embeddings-vectors-fresh', category: 'memory', severity: 'warn', ok: false,
        issues: [`could not read index (corrupt?) — run \`mk reindex --embed\`: ${String(err)}`],
      };
    }
    // The unambiguous failure: a key is configured, atoms exist, but no vectors —
    // embedding never ran or stalled post-upgrade ("key set, 0 vectors", #305).
    if (atoms > 0 && embeddings === 0) {
      return {
        name: 'embeddings-vectors-fresh', category: 'memory', severity: 'warn', ok: false,
        issues: [`embeddings configured but 0 vectors for ${atoms} atoms — run \`mk reindex --embed\` (embedding stalled?)`],
      };
    }
    // Exact equality is NOT required: SECRET/PERSONAL atoms are never embedded,
    // so vectors < atoms can be legitimate. Surface a partial count as info, not warn.
    if (embeddings < atoms) {
      return {
        name: 'embeddings-vectors-fresh', category: 'memory', severity: 'info', ok: true,
        issues: [`${embeddings}/${atoms} atoms have vectors (the gap is expected for SECRET/PERSONAL atoms or a mid-run reindex)`],
      };
    }
    return {
      name: 'embeddings-vectors-fresh', category: 'memory', severity: 'info', ok: true,
      issues: [`${embeddings} vectors for ${atoms} atoms`],
    };
  },
};

// --- (d) smoke-recall ------------------------------------------------------

export const smokeRecallCheck: Check = {
  name: 'smoke-recall',
  category: 'memory',
  defaultSeverity: 'warn',
  skipWhen: ['store'],
  async run(ctx: DoctorContext): Promise<CheckResult> {
    // Opt-in embedding smoke (makes a paid embedding API call): only when
    // embeddings are configured, the operator explicitly opts in
    // (MK_DOCTOR_SMOKE_EMBED), and network isn't skipped. A routine
    // `mk doctor` therefore never egresses.
    const wantEmbed =
      getEmbeddingConfig() !== null &&
      !!ctx.env.MK_DOCTOR_SMOKE_EMBED &&
      !ctx.skipCategories.has('network');
    if (wantEmbed) {
      try {
        const { recallWithEmbeddings } = await import('../../recall.js');
        const eb = await recallWithEmbeddings(ctx.memoryDir, { task: 'health check smoke recall', max_tokens: 500 });
        return {
          name: 'smoke-recall', category: 'memory', severity: 'info', ok: true,
          issues: [`recall --embed ok (status: ${eb.recall_status ?? 'ok'})`],
        };
      } catch (err) {
        return {
          name: 'smoke-recall', category: 'memory', severity: 'warn', ok: false,
          issues: [`recall --embed threw — embedding pipeline broken: ${String(err)}`],
        };
      }
    }

    // Default path: a read-only FTS probe that exercises the index→FTS query
    // pipeline end-to-end. No egress, and (unlike recall()) no `openIndex()` so
    // no schema migration — keeps `mk doctor` side-effect-free. A corrupt or
    // missing index degrades gracefully (info/warn), never a hard error.
    let db: Database.Database | null = null;
    try {
      db = openIndexReadonly(ctx.memoryDir);
      if (!db) {
        return {
          name: 'smoke-recall', category: 'memory', severity: 'info', ok: true,
          issues: ['no index — run `mk reindex` (recall falls back to file scan)'],
        };
      }
      db.prepare('SELECT atom_id FROM atom_fts WHERE atom_fts MATCH ? LIMIT 1').all('health');
      return {
        name: 'smoke-recall', category: 'memory', severity: 'info', ok: true,
        issues: ['recall/FTS index queryable (no egress); set MK_DOCTOR_SMOKE_EMBED=1 to also smoke the embedding path'],
      };
    } catch (err) {
      return {
        name: 'smoke-recall', category: 'memory', severity: 'warn', ok: false,
        issues: [`FTS query threw — recall pipeline broken (corrupt index?): ${String(err)}`],
      };
    } finally {
      db?.close();
    }
  },
};

// --- (e) sync-liveness -----------------------------------------------------

/**
 * Pure staleness diagnosis from the last-reindex epoch (ms) and a clock.
 *
 * `expected` is whether the operator has *declared* a sync cadence (by setting
 * `MK_SYNC_MAX_AGE_HOURS`). Staleness only **warns** when a cadence is expected
 * — otherwise a perfectly healthy idle / manually-managed store (no nightly
 * cron) would false-positive and flip `mk doctor`'s exit code. When no cadence
 * is declared, an old index is reported as info with a hint, not a warning.
 */
export function diagnoseSyncLiveness(
  lastReindexMs: number | null,
  nowMs: number,
  maxAgeHours: number,
  expected: boolean,
): { ok: boolean; severity: 'warn' | 'info'; issues: string[] } {
  if (lastReindexMs === null) {
    return { ok: true, severity: 'info', issues: ['no index — sync liveness not applicable'] };
  }
  const ageHours = (nowMs - lastReindexMs) / (1000 * 60 * 60);
  if (ageHours > maxAgeHours) {
    if (expected) {
      return {
        ok: false, severity: 'warn',
        issues: [`last reindex was ${ageHours.toFixed(1)}h ago (> ${maxAgeHours}h MK_SYNC_MAX_AGE_HOURS) — nightly sync may have silently stopped`],
      };
    }
    return {
      ok: true, severity: 'info',
      issues: [`last reindex ${ageHours.toFixed(1)}h ago — set MK_SYNC_MAX_AGE_HOURS to enforce a freshness SLA (warns past the threshold)`],
    };
  }
  return { ok: true, severity: 'info', issues: [`last reindex ${ageHours.toFixed(1)}h ago`] };
}

export const syncLivenessCheck: Check = {
  name: 'sync-liveness',
  category: 'memory',
  defaultSeverity: 'warn',
  skipWhen: ['store'],
  run(ctx: DoctorContext): CheckResult {
    const dbPath = path.join(ctx.memoryDir, DB_FILENAME);
    let lastReindexMs: number | null = null;
    try {
      lastReindexMs = fs.statSync(dbPath).mtimeMs;
    } catch {
      lastReindexMs = null;
    }
    const maxAgeRaw = parseFloat(ctx.env.MK_SYNC_MAX_AGE_HOURS || '');
    const expected = Number.isFinite(maxAgeRaw) && maxAgeRaw > 0;
    const maxAgeHours = expected ? maxAgeRaw : DEFAULT_SYNC_MAX_AGE_HOURS;
    const { ok, severity, issues } = diagnoseSyncLiveness(lastReindexMs, Date.now(), maxAgeHours, expected);
    return { name: 'sync-liveness', category: 'memory', severity, ok, issues };
  },
};

/** All integration-health checks, in display order (#305). */
export const integrationHealthChecks: readonly Check[] = [
  mkVersionCheck,
  embeddingKeySourceCheck,
  vectorsFreshCheck,
  smokeRecallCheck,
  syncLivenessCheck,
];
