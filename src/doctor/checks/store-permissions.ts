/**
 * store-permissions check — verifies that SECRET-bearing files in the memory
 * store have owner-only (0o600) permissions, matching the policy enforced by
 * crypto + index-db at write time (#138).
 *
 * Why: a manual `chmod` or a restore-from-backup that loses file modes would
 * leave SECRET atoms world-readable without any other code path catching it.
 *
 * Skipped on Windows: chmod is a no-op there and mode bits are meaningless,
 * so the check would produce noise.
 */

import fs from 'fs';
import path from 'path';
import { listAtoms } from '../../index.js';
import type { Check, CheckResult, DoctorContext, FixOpts, FixOutcome } from '../types.js';

const SECRET_MODE = 0o600;
const MODE_MASK = 0o777;

interface PermissionViolation {
  /** Absolute path that needs chmod. */
  path: string;
  /** Current mode (e.g. 0o644). */
  currentMode: number;
  /** Atom ID, if this violation is from a SECRET atom (not the index DB). */
  atomId?: string;
}

function probe(memoryDir: string): PermissionViolation[] {
  const violations: PermissionViolation[] = [];

  const indexDbPath = path.join(memoryDir, '.memory-index.db');
  if (fs.existsSync(indexDbPath)) {
    const mode = fs.statSync(indexDbPath).mode & MODE_MASK;
    if (mode !== SECRET_MODE) violations.push({ path: indexDbPath, currentMode: mode });
  }

  const atoms = listAtoms(memoryDir);
  for (const atom of atoms) {
    if (atom.frontmatter.classification !== 'SECRET') continue;
    const atomPath = atom.filePath;
    if (!atomPath || !fs.existsSync(atomPath)) continue;
    const mode = fs.statSync(atomPath).mode & MODE_MASK;
    if (mode !== SECRET_MODE) {
      violations.push({ path: atomPath, currentMode: mode, atomId: atom.frontmatter.id });
    }
  }
  return violations;
}

function formatViolation(v: PermissionViolation): string {
  const modeStr = v.currentMode.toString(8).padStart(3, '0');
  if (v.atomId) return `${v.atomId} (${v.path}) has mode ${modeStr}, expected 600`;
  return `${path.basename(v.path)} has mode ${modeStr}, expected 600`;
}

export const storePermissionsCheck: Check = {
  name: 'store-permissions',
  category: 'memory',
  defaultSeverity: 'error',
  skipWhen: ['store'],
  run(ctx: DoctorContext): CheckResult {
    if (process.platform === 'win32') {
      return {
        name: storePermissionsCheck.name,
        category: storePermissionsCheck.category,
        severity: 'info',
        ok: true,
        issues: [],
        skipped: { reason: 'POSIX permission bits not enforced on win32' },
      };
    }

    const issues = probe(ctx.memoryDir).map(formatViolation);

    return {
      name: storePermissionsCheck.name,
      category: storePermissionsCheck.category,
      severity: 'error',
      ok: issues.length === 0,
      issues,
    };
  },
  fix(ctx: DoctorContext, _result: CheckResult, opts: FixOpts): FixOutcome {
    if (process.platform === 'win32') {
      return { applied: [], remaining: [] };
    }
    const violations = probe(ctx.memoryDir);
    const applied: string[] = [];
    const remaining: string[] = [];
    const errors: string[] = [];

    for (const v of violations) {
      const modeStr = v.currentMode.toString(8).padStart(3, '0');
      const label = v.atomId ? `${v.atomId} (${v.path})` : v.path;
      if (opts.dryRun) {
        applied.push(`would chmod 600 ${label} (currently ${modeStr})`);
        continue;
      }
      try {
        fs.chmodSync(v.path, SECRET_MODE);
        applied.push(`chmodded 600 ${label} (was ${modeStr})`);
      } catch (err) {
        errors.push(`failed to chmod ${label}: ${String(err)}`);
        remaining.push(formatViolation(v));
      }
    }

    return errors.length > 0 ? { applied, remaining, errors } : { applied, remaining };
  },
};
