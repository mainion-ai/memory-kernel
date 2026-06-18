/**
 * Confidence write-back from grounding reconciliation — Phase 2 of #245 (#364).
 *
 * Phase 1 (`src/grounding.ts`) is read-only: it derives a usage `grounding_score`
 * per atom and bins each into a `prior × grounding` 2×2 quadrant. This module is
 * the destructive companion — for the two actionable off-diagonal quadrants it
 * computes a `reconciled_confidence` (the SmartVector value seeded from the
 * prior, deliberately deferred from Phase 1) and writes it back onto the atom.
 *
 *   - `review`  (high prior, low grounding): confidence is pulled DOWN toward the
 *     grounding score — stated confidently but unvalidated by use.
 *   - `promote` (low prior, high grounding): confidence is pulled UP — written
 *     cautiously but corroborated across sessions.
 *
 * The pull is an asymmetric convex step (an exponential-moving-average update):
 *
 *     reconciled = clamp( prior + α · (grounding − prior), 0, 1 )
 *
 * with α_neg > α_pos so disconfirmation moves confidence faster than
 * confirmation — "a single human correction should outweigh several silent
 * accepts" (SmartVector, arXiv 2604.20598: α_neg = 0.08, α_pos = 0.03). The step
 * is small by design: repeated reconciliations converge an atom toward its
 * grounded value and stop once it crosses the quadrant threshold, rather than
 * snapping confidence onto the diagonal in one pass.
 *
 * **Provenance gate (the reason this was gated on #247):** an atom carrying a
 * `human_edit` event has been directly curated by a human, so its confidence is
 * human-asserted and is NOT auto-adjusted — skipped unless `override` is set.
 * Without the `human_edit` signal this skip was impossible, which is why the
 * write-back waited for #247.
 *
 * The gate is deliberately **conservative**: it skips on *any* `human_edit`
 * event for the atom, not only ones that demonstrably changed `confidence`.
 * Over-protection (an atom a human merely touched is never auto-reconciled) is
 * the safe bias for a destructive write-back; under-protection (clobbering a
 * human-set confidence) is the failure the gate exists to prevent. Known
 * limitation: the signal is the event log, so a `mk compact` that prunes a
 * `human_edit` superseded by a later mutation (e.g. an `--override` reconcile,
 * or an `atom_promoted`) can erode the gate for that atom — tracked in #400.
 * The common no-override flow is unaffected: a skip emits no superseding event,
 * so the `human_edit` stays the latest mutation and survives compaction.
 *
 * Scoring is **not** re-derived here — it reuses `computeGrounding` /
 * `classifyQuadrant` from `src/grounding.ts`.
 */

import { listAtoms, writeAtom } from './store.js';
import { readEvents, appendEvent } from './event-log.js';
import { indexExists, indexAtom } from './index-db.js';
import { snapshotAtom } from './retain.js';
import { normalizeTimestamp } from './format.js';
import { computeGrounding } from './grounding.js';
import type { GroundingOptions, GroundingQuadrant } from './grounding.js';
import type { AtomType } from './types.js';

/** Learning rate for disconfirmation (review: pull confidence DOWN). */
export const DEFAULT_ALPHA_NEG = 0.08;
/** Learning rate for confirmation (promote: pull confidence UP). */
export const DEFAULT_ALPHA_POS = 0.03;
/** Adjustments smaller than this are skipped to avoid churn / event-log noise. */
export const DEFAULT_MIN_DELTA = 0.005;

const QUADRANTS_IN_SCOPE: ReadonlySet<GroundingQuadrant> = new Set(['review', 'promote']);

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * The reconciled confidence: an asymmetric convex pull of `prior` toward
 * `grounding`. `α_neg` applies when grounding < prior (disconfirmation),
 * `α_pos` when grounding ≥ prior (confirmation). Clamped to [0, 1].
 */
export function reconciledConfidence(
  prior: number,
  grounding: number,
  alphaNeg: number = DEFAULT_ALPHA_NEG,
  alphaPos: number = DEFAULT_ALPHA_POS,
): number {
  const diff = grounding - prior;
  const alpha = diff < 0 ? alphaNeg : alphaPos;
  const v = prior + alpha * diff;
  return round4(Math.min(1, Math.max(0, v)));
}

export interface ReconcileOptions {
  memoryDir: string;
  agent_id?: string;
  session_id?: string;
  /** Preview only — compute changes, write nothing, emit no events. */
  dryRun?: boolean;
  /** Adjust even human-edited atoms (default: skip atoms with a human_edit event). */
  override?: boolean;
  /** Disconfirmation learning rate (review). Default {@link DEFAULT_ALPHA_NEG}. */
  alphaNeg?: number;
  /** Confirmation learning rate (promote). Default {@link DEFAULT_ALPHA_POS}. */
  alphaPos?: number;
  /** Minimum |reconciled − prior| to bother writing. Default {@link DEFAULT_MIN_DELTA}. */
  minDelta?: number;
  /** Pass-through to {@link computeGrounding} (thresholds, half-lives, `now`, …). */
  grounding?: GroundingOptions;
}

export interface ReconcileChange {
  atom_id: string;
  type: AtomType;
  quadrant: GroundingQuadrant;
  prior: number;
  grounding_score: number;
  reconciled_confidence: number;
  delta: number;
}

export interface ReconcileResult {
  /** Gradeable atoms (active, non-conflict unless grounding.includeAll). */
  scanned: number;
  /** Actionable review+promote atoms eligible for write-back before gates. */
  candidates: number;
  /** Atoms whose confidence was written (0 when dryRun). */
  applied: number;
  /** Skipped because they carry a human_edit event (and no override). */
  skipped_human_edit: number;
  /** Skipped because the adjustment was below minDelta. */
  skipped_below_min_delta: number;
  dry_run: boolean;
  changes: ReconcileChange[];
}

/**
 * Reconcile confidence toward grounding for the actionable `review`/`promote`
 * atoms. Reuses {@link computeGrounding} for scoring; skips human-edited atoms
 * unless `override`; emits one `atom_reconciled` audit event per write-back so
 * the change is auditable and replayable. `dryRun` previews without mutating.
 */
export function reconcileGrounding(opts: ReconcileOptions): ReconcileResult {
  const memoryDir = opts.memoryDir;
  const agentId = opts.agent_id ?? 'cli';
  const sessionId = opts.session_id ?? 'mk-grounding';
  const alphaNeg = opts.alphaNeg ?? DEFAULT_ALPHA_NEG;
  const alphaPos = opts.alphaPos ?? DEFAULT_ALPHA_POS;
  const minDelta = opts.minDelta ?? DEFAULT_MIN_DELTA;
  const dryRun = opts.dryRun ?? false;

  // Validate the learning-rate knobs (mirrors computeGrounding's guards). α
  // outside [0, 1] breaks the convex-pull invariant — the step could overshoot
  // or invert the grounding target — so fail loudly rather than silently
  // corrupt confidences. (`!(x >= a && x <= b)` also rejects NaN.)
  if (!(alphaNeg >= 0 && alphaNeg <= 1)) {
    throw new RangeError(`alphaNeg must be in [0, 1], got ${alphaNeg}`);
  }
  if (!(alphaPos >= 0 && alphaPos <= 1)) {
    throw new RangeError(`alphaPos must be in [0, 1], got ${alphaPos}`);
  }
  if (!(minDelta >= 0)) {
    throw new RangeError(`minDelta must be >= 0, got ${minDelta}`);
  }

  const atoms = listAtoms(memoryDir);
  const events = readEvents(memoryDir);
  const grounding = computeGrounding(atoms, events, opts.grounding ?? {});

  // Atoms a human has directly edited — their confidence is human-asserted.
  const humanEdited = new Set<string>();
  for (const ev of events) {
    if (ev.action === 'human_edit' && ev.atom_refs) {
      for (const ref of ev.atom_refs) humanEdited.add(ref);
    }
  }

  const byId = new Map(atoms.map((a) => [a.frontmatter.id, a]));

  const result: ReconcileResult = {
    scanned: grounding.summary.total,
    candidates: 0,
    applied: 0,
    skipped_human_edit: 0,
    skipped_below_min_delta: 0,
    dry_run: dryRun,
    changes: [],
  };

  for (const report of grounding.reports) {
    if (!QUADRANTS_IN_SCOPE.has(report.quadrant)) continue;
    if (!report.actionable) continue; // honour the promote cross-session / review guards
    result.candidates++;

    if (humanEdited.has(report.atom_id) && !opts.override) {
      result.skipped_human_edit++;
      continue;
    }

    const reconciled = reconciledConfidence(report.prior, report.grounding_score, alphaNeg, alphaPos);
    const delta = round4(reconciled - report.prior);
    if (Math.abs(delta) < minDelta) {
      result.skipped_below_min_delta++;
      continue;
    }

    result.changes.push({
      atom_id: report.atom_id,
      type: report.type,
      quadrant: report.quadrant,
      prior: report.prior,
      grounding_score: report.grounding_score,
      reconciled_confidence: reconciled,
      delta,
    });

    if (dryRun) continue;

    const atom = byId.get(report.atom_id);
    if (!atom || !atom.filePath) continue; // defensive — reports are built from these atoms

    atom.frontmatter.confidence = reconciled;
    atom.frontmatter.updated_at = normalizeTimestamp();
    writeAtom(atom, atom.filePath);

    appendEvent(memoryDir, 'atom_reconciled', {
      agent_id: agentId,
      session_id: sessionId,
      atom_refs: [report.atom_id],
      touched_paths: [atom.filePath],
      evidence: [`confidence ${report.prior} → ${reconciled} (grounding ${report.grounding_score})`],
      meta: {
        operation: 'grounding-reconcile',
        quadrant: report.quadrant,
        prior: report.prior,
        grounding_score: report.grounding_score,
        reconciled_confidence: reconciled,
        delta,
        // Record the α the pull actually used — keyed off the raw
        // (grounding − prior) sign, the same discriminant reconciledConfidence
        // applies, not the rounded post-clamp delta (which can differ near 0).
        alpha: report.grounding_score - report.prior < 0 ? alphaNeg : alphaPos,
      },
      schema_version: 2,
      atom_snapshot: snapshotAtom(atom),
    });

    if (indexExists(memoryDir)) {
      indexAtom(memoryDir, atom);
    }

    result.applied++;
  }

  return result;
}
