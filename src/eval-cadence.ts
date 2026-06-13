/**
 * Eval cadence (#266) — turn a stream of `mk eval` runs into a **delta-only**
 * post-sync alert plus a weekly digest.
 *
 * `mk eval` (#300) gives a per-run pass rate; on its own that's noisy to watch
 * (you'd alert on every absolute dip, or never). The cadence compares the
 * latest run's per-category pass rate against a rolling N-day baseline and only
 * fires when a category moves materially: a **drop > 10pp** (regression) or an
 * **improvement > 15pp** (worth noticing / re-baselining). Everything else is
 * silent. A stable weekly digest is emitted regardless.
 *
 * This is operational glue, not part of the recall path — kept out of the
 * public barrel; the `scripts/eval-cadence.mjs` wrapper imports it directly.
 */
import type { EvalResult } from './eval.js';

/** One eval run reduced to per-category + overall pass rates (0..1). */
export interface EvalSnapshot {
  timestamp: string; // ISO-8601
  overall: number;
  categories: Record<string, number>;
}

export interface CadenceOptions {
  /** pp drop (0..1) that fires a regression alert. Default 0.10. */
  dropThreshold?: number;
  /** pp improvement (0..1) that fires a "worth noticing" alert. Default 0.15. */
  improveThreshold?: number;
  /** Rolling baseline window in days. Default 7. */
  baselineDays?: number;
  /** Injectable clock (ms). Defaults to Date.now(). */
  nowMs?: number;
}

export interface CadenceAlert {
  category: string;
  baseline: number;
  latest: number;
  /** latest − baseline, in pass-rate points (negative = regression). */
  delta: number;
  direction: 'drop' | 'improve';
}

export interface CadenceResult {
  fired: boolean;
  alerts: CadenceAlert[];
  digest: string;
  window: { days: number; baseline_runs: number };
  latest: EvalSnapshot | null;
}

const UNCATEGORIZED = 'uncategorized';

/**
 * Reduce one `mk eval --json` run (its `fixtures` array) to a snapshot of
 * per-category and overall pass rates.
 */
export function summarizeEvalRun(fixtures: readonly EvalResult[], timestampIso: string): EvalSnapshot {
  const passedByCat: Record<string, number> = {};
  const totalByCat: Record<string, number> = {};
  let passed = 0;
  let total = 0;

  for (const fx of fixtures) {
    for (const r of fx.results) {
      // `?? UNCATEGORIZED` only catches null/undefined; treat an empty/whitespace
      // `cat:` (author slip) as uncategorized too, so it doesn't become a blank-label category.
      const cat = r.cat && r.cat.trim() ? r.cat : UNCATEGORIZED;
      totalByCat[cat] = (totalByCat[cat] ?? 0) + 1;
      if (r.passed) passedByCat[cat] = (passedByCat[cat] ?? 0) + 1;
      total += 1;
      if (r.passed) passed += 1;
    }
  }

  const categories: Record<string, number> = {};
  for (const cat of Object.keys(totalByCat)) {
    categories[cat] = totalByCat[cat] > 0 ? (passedByCat[cat] ?? 0) / totalByCat[cat] : 0;
  }

  return {
    timestamp: timestampIso,
    overall: total > 0 ? passed / total : 0,
    categories,
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

/**
 * Decide the cadence outcome from a history of snapshots. The most recent
 * snapshot is "latest"; the baseline is the mean per-category rate over the
 * prior snapshots within the rolling window (latest excluded). A category with
 * no baseline data (first time it's seen) never fires — there's nothing to
 * compare against yet.
 */
export function decideCadence(history: readonly EvalSnapshot[], opts: CadenceOptions = {}): CadenceResult {
  const drop = opts.dropThreshold ?? 0.10;
  const improve = opts.improveThreshold ?? 0.15;
  const days = opts.baselineDays ?? 7;
  const now = opts.nowMs ?? Date.now();

  if (history.length === 0) {
    return { fired: false, alerts: [], digest: 'no eval runs recorded yet', window: { days, baseline_runs: 0 }, latest: null };
  }

  const sorted = [...history].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const latest = sorted[sorted.length - 1];
  const windowStartMs = now - days * 24 * 60 * 60 * 1000;
  const baselineRuns = sorted
    .slice(0, -1)
    .filter((s) => Date.parse(s.timestamp) >= windowStartMs);

  const baselineMean = (cat: string): number | null => {
    const vals = baselineRuns
      .map((s) => s.categories[cat])
      .filter((v): v is number => v !== undefined);
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };

  const alerts: CadenceAlert[] = [];
  for (const cat of Object.keys(latest.categories).sort()) {
    const base = baselineMean(cat);
    if (base === null) continue; // first observation — nothing to compare
    const delta = latest.categories[cat] - base;
    if (delta <= -drop) {
      alerts.push({ category: cat, baseline: base, latest: latest.categories[cat], delta, direction: 'drop' });
    } else if (delta >= improve) {
      alerts.push({ category: cat, baseline: base, latest: latest.categories[cat], delta, direction: 'improve' });
    }
  }

  // Weekly digest — stable, emitted regardless of alerts.
  const lines: string[] = [];
  lines.push(`eval digest @ ${latest.timestamp} — overall ${pct(latest.overall)} (baseline window: ${days}d, ${baselineRuns.length} prior run(s))`);
  for (const cat of Object.keys(latest.categories).sort()) {
    const base = baselineMean(cat);
    const cur = latest.categories[cat];
    if (base === null) {
      lines.push(`  ${cat}: ${pct(cur)} (no baseline yet)`);
    } else {
      const d = cur - base;
      const arrow = d > 0 ? '▲' : d < 0 ? '▼' : '=';
      lines.push(`  ${cat}: ${pct(base)} → ${pct(cur)} ${arrow}${(d * 100).toFixed(0)}pp`);
    }
  }
  // Surface categories that were in the baseline but vanished from the latest
  // run (e.g. their queries were removed, or stopped producing results). We
  // don't *alert* — that would false-fire on intentional fixture pruning — but
  // the digest must not stay silent about a coverage gap.
  const latestCats = new Set(Object.keys(latest.categories));
  const baselineCats = new Set<string>();
  for (const s of baselineRuns) for (const c of Object.keys(s.categories)) baselineCats.add(c);
  const vanished = [...baselineCats].filter((c) => !latestCats.has(c)).sort();
  for (const cat of vanished) {
    const base = baselineMean(cat);
    lines.push(`  ${cat}: ⚠ absent from latest run (baseline ${base === null ? '?' : pct(base)})`);
  }

  if (alerts.length) {
    lines.push('alerts:');
    for (const a of alerts) {
      lines.push(`  ! ${a.category} ${a.direction}: ${pct(a.baseline)} → ${pct(a.latest)} (${(a.delta * 100).toFixed(0)}pp)`);
    }
  }

  return {
    fired: alerts.length > 0,
    alerts,
    digest: lines.join('\n'),
    window: { days, baseline_runs: baselineRuns.length },
    latest,
  };
}
