/**
 * doctor — shared types for the check registry (#140).
 *
 * The doctor command runs a list of `Check` objects against a `DoctorContext`
 * and collects `CheckResult`s. Each check is independent, side-effect-free
 * (other than reading the file system or shelling out to crontab), and may
 * skip itself when --skip flags exclude its category.
 */

export type Severity = 'error' | 'warn' | 'info';

export type CheckCategory = 'memory' | 'binary' | 'wrappers';

/** User-facing --skip values. Maps to which checks are excluded. */
export type SkipCategory = 'wrappers' | 'network' | 'cron' | 'store';

export interface CheckResult {
  name: string;
  category: CheckCategory;
  severity: Severity;
  ok: boolean;
  issues: string[];
  /** Set when the check was deliberately skipped (e.g. --skip flag). */
  skipped?: { reason: string };
}

export interface DoctorContext {
  memoryDir: string;
  /** Current kernel version (from package.json), used for drift comparisons. */
  kernelVersion: string;
  /** Set of --skip categories the user requested. */
  skipCategories: ReadonlySet<SkipCategory>;
  /** Overridable for tests; defaults to process.env. */
  env: NodeJS.ProcessEnv;
}

export interface Check {
  name: string;
  category: CheckCategory;
  /** Issues emitted by this check default to this severity. */
  defaultSeverity: Severity;
  /**
   * Skip categories that, if present in ctx.skipCategories, cause this check
   * to be skipped entirely (with a reason).
   */
  skipWhen?: readonly SkipCategory[];
  /** Run the check. May be async (e.g. network calls). */
  run(ctx: DoctorContext): Promise<CheckResult> | CheckResult;
  /**
   * Apply auto-fixes for the issues this check surfaced (#157).
   *
   * Optional — checks without `fix` are non-auto-fixable. The implementation
   * is responsible for honoring `opts.dryRun`: when true, it must report what
   * it *would* do without performing any writes.
   */
  fix?(
    ctx: DoctorContext,
    result: CheckResult,
    opts: FixOpts,
  ): Promise<FixOutcome> | FixOutcome;
}

/** Options passed to `Check.fix()` (#157). */
export interface FixOpts {
  dryRun: boolean;
}

/** Outcome of a single `Check.fix()` invocation (#157). */
export interface FixOutcome {
  /** Human-readable lines describing what was (or would be) fixed. */
  applied: string[];
  /** Human-readable lines describing issues this fix can't resolve. */
  remaining: string[];
  /** Exceptions raised while applying. Absent means no errors. */
  errors?: string[];
}

/** Build a `skipped` CheckResult — used when --skip excludes a category. */
export function skipped(check: Check, reason: string): CheckResult {
  return {
    name: check.name,
    category: check.category,
    severity: 'info',
    ok: true,
    issues: [],
    skipped: { reason },
  };
}

/** Compute the overall exit code from a list of check results. */
export function exitCodeForResults(results: readonly CheckResult[]): 0 | 1 | 2 {
  let worst: Severity = 'info';
  for (const r of results) {
    if (r.ok || r.skipped) continue;
    if (r.severity === 'error') return 2;
    if (r.severity === 'warn') worst = 'warn';
  }
  return worst === 'warn' ? 1 : 0;
}
