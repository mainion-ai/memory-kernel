/**
 * Doctor orchestrator (#140).
 *
 * runDoctor() loops over a check registry, honors --skip categories, and
 * collects results. The CLI command in src/cli/mk.ts is a thin wrapper that
 * builds the context, calls runDoctor, and formats the output.
 *
 * Separating orchestrator from CLI lets the same logic be invoked from
 * tests, from `mk doctor --json | jq ...` pipelines, and (eventually) from
 * #142's fleet-upgrade polling script.
 */

import type {
  Check,
  CheckResult,
  DoctorContext,
  FixOutcome,
  SkipCategory,
} from './types.js';
import { skipped, exitCodeForResults } from './types.js';
import { schemaCheck } from './checks/schema.js';
import { linksCheck } from './checks/links.js';
import { conflictsCheck } from './checks/conflicts.js';
import { storePermissionsCheck } from './checks/store-permissions.js';
import { storeSchemaCheck } from './checks/store-schema.js';
import { renderConfigCheck } from './checks/render-config.js';
import { wrapperDriftCheck } from './checks/wrapper-drift.js';
import { atomFrontmatterCheck } from './checks/atom-frontmatter.js';
import { atomRelationsSectionCheck } from './checks/atom-relations-section.js';
import { orphanProseRefsCheck } from './checks/orphan-prose-refs.js';
import { integrationHealthChecks } from './checks/integration-health.js';

/**
 * Default check registry. Order is the order results are reported in —
 * memory-store checks first, then integration-health, then wrapper drift.
 */
export const DEFAULT_CHECKS: readonly Check[] = [
  schemaCheck,
  linksCheck,
  atomFrontmatterCheck,
  atomRelationsSectionCheck,
  orphanProseRefsCheck,
  conflictsCheck,
  storeSchemaCheck,
  storePermissionsCheck,
  renderConfigCheck,
  ...integrationHealthChecks,
  wrapperDriftCheck,
];

export interface RunDoctorResult {
  results: CheckResult[];
  exitCode: 0 | 1 | 2;
}

export async function runDoctor(
  ctx: DoctorContext,
  checks: readonly Check[] = DEFAULT_CHECKS,
): Promise<RunDoctorResult> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    const blocked = check.skipWhen?.find((s) => ctx.skipCategories.has(s));
    if (blocked) {
      results.push(skipped(check, `--skip ${blocked}`));
      continue;
    }
    try {
      const r = await check.run(ctx);
      results.push(r);
    } catch (err) {
      results.push({
        name: check.name,
        category: check.category,
        severity: 'error',
        ok: false,
        issues: [`check threw: ${String(err)}`],
      });
    }
  }
  return { results, exitCode: exitCodeForResults(results) };
}

/**
 * Parse a comma- or space-separated string of skip categories from the CLI.
 * Tolerant of casing and extra whitespace; unknown values are silently
 * dropped (the CLI layer can warn separately if it wants).
 */
export function parseSkipCategories(raw: string | undefined): Set<SkipCategory> {
  if (!raw) return new Set();
  const allowed: ReadonlySet<SkipCategory> = new Set([
    'wrappers',
    'network',
    'cron',
    'store',
  ]);
  const out = new Set<SkipCategory>();
  for (const part of raw.split(/[,\s]+/).map((s) => s.trim().toLowerCase())) {
    if (allowed.has(part as SkipCategory)) {
      out.add(part as SkipCategory);
    }
  }
  return out;
}

/**
 * Build the flat `issues: string[]` array required by the existing
 * `{ healthy, issue_count, issues }` JSON output shape. Preserves backward
 * compatibility with callers that read that shape (e.g.
 * test/cli-json.test.ts).
 */
export function flattenIssues(results: readonly CheckResult[]): string[] {
  const out: string[] = [];
  for (const r of results) {
    if (r.skipped || r.ok) continue;
    for (const issue of r.issues) {
      out.push(`${r.name}: ${issue}`);
    }
  }
  return out;
}

/** Per-check record of what `Check.fix()` did (or would do) (#157). */
export interface FixResultRecord {
  name: string;
  applied: string[];
  remaining: string[];
  errors?: string[];
  dryRun: boolean;
}

export interface RunDoctorFixResult {
  /** Pre-fix check results (the state callers compare against to see the fix took effect). */
  initialResults: CheckResult[];
  /** Post-fix re-run results (or same as initialResults in dry-run mode). */
  results: CheckResult[];
  fixResults: FixResultRecord[];
  exitCode: 0 | 1 | 2;
}

/**
 * Run the full doctor pass, then apply (or preview) auto-fixes for each
 * non-ok check that exposes a `fix()` method (#157).
 *
 * In apply mode (`dryRun: false`), affected checks are re-run after their
 * fix so the returned `results` reflect the post-fix state. The exit code
 * follows the per-mode table documented in
 * `docs/superpowers/plans/2026-05-24-issue-157-doctor-fix-phase1.md`.
 */
export async function runDoctorFix(
  ctx: DoctorContext,
  opts: { dryRun: boolean },
  checks: readonly Check[] = DEFAULT_CHECKS,
): Promise<RunDoctorFixResult> {
  const { results: initialResults } = await runDoctor(ctx, checks);

  const fixResults: FixResultRecord[] = [];
  // Index checks by name so we can re-run only the affected ones.
  const checksByName = new Map(checks.map((c) => [c.name, c] as const));
  const affectedNames: string[] = [];
  let aFixThrew = false;

  for (const r of initialResults) {
    if (r.ok || r.skipped) continue;
    const check = checksByName.get(r.name);
    if (!check?.fix) continue; // non-auto-fixable

    let outcome: FixOutcome;
    try {
      outcome = await check.fix(ctx, r, { dryRun: opts.dryRun });
    } catch (err) {
      aFixThrew = true;
      outcome = {
        applied: [],
        remaining: [],
        errors: [`fix threw: ${String(err)}`],
      };
    }

    fixResults.push({
      name: r.name,
      applied: outcome.applied,
      remaining: outcome.remaining,
      ...(outcome.errors && outcome.errors.length > 0 ? { errors: outcome.errors } : {}),
      dryRun: opts.dryRun,
    });
    affectedNames.push(r.name);
  }

  // Re-run affected checks in apply mode so callers see post-fix state.
  // In dry-run mode we never wrote anything, so the initial results stand.
  let postResults: CheckResult[];
  if (opts.dryRun || affectedNames.length === 0) {
    postResults = initialResults;
  } else {
    const affected = new Set(affectedNames);
    postResults = [];
    for (const r of initialResults) {
      if (!affected.has(r.name)) {
        postResults.push(r);
        continue;
      }
      const check = checksByName.get(r.name);
      if (!check) {
        postResults.push(r);
        continue;
      }
      try {
        postResults.push(await check.run(ctx));
      } catch (err) {
        postResults.push({
          name: check.name,
          category: check.category,
          severity: 'error',
          ok: false,
          issues: [`check threw on re-run: ${String(err)}`],
        });
      }
    }
  }

  // Exit-code mapping per the plan.
  let exitCode: 0 | 1 | 2;
  if (opts.dryRun) {
    // Dry-run never escalates beyond a plain doctor run.
    exitCode = exitCodeForResults(initialResults);
  } else if (aFixThrew) {
    exitCode = 2;
  } else {
    exitCode = exitCodeForResults(postResults);
  }

  return { initialResults, results: postResults, fixResults, exitCode };
}
