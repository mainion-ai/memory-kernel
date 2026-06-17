/**
 * Grounding-score reconciliation — Phase 1, advisory only (#245).
 *
 * Atom `confidence` is a **prior**: set once by the writer, never updated. The
 * event log, meanwhile, accumulates *usage* evidence — an `atom_read` on every
 * recall that returns the atom, a `conflict_detected` when it clashes with
 * another atom. This module derives a **posterior** `grounding_score` from that
 * event history and bins every atom into a 2×2 `prior × grounding` quadrant so
 * an operator (or a later automated pass) can see where stated confidence and
 * demonstrated use disagree.
 *
 * **This module is pure and read-only.** It takes already-loaded atoms + events
 * and returns a report. It never touches atom files. The destructive companion —
 * writing a reconciled confidence back onto atoms — is Phase 2, deferred and
 * gated on #247 (`human_edit` events): without the human-correction signal the
 * write-back would miss the strongest disconfirmation and could wrongly promote
 * an atom the operator has already corrected. `reconciled_confidence` (the
 * SmartVector value seeded from the prior) is therefore *not* computed here.
 *
 * Why the grounding score is **prior-independent**: the 2×2 only works if the
 * grounding axis does not track the prior. If grounding were seeded from the
 * prior `confidence`, high-prior atoms would land "high grounding" almost
 * regardless of use and the two actionable off-diagonal quadrants (`review`,
 * `promote`) would go empty. So grounding is computed from usage signals only —
 * it keeps SmartVector's *mechanisms* (half-life decay, diminishing
 * reinforcement, a multiplicative negative signal) but seeds from reads, not the
 * writer's confidence.
 *
 *   recency   = 0 if never read, else 2^(-days_since_last_read / H)   ∈ [0, 1]
 *   frequency = 1 - 2^(-n_access / K)                                 ∈ [0, 1)
 *   grounding = clamp( (w_r·recency + w_f·frequency) · D^n_conflict, 0.01, 1.0 )
 *
 * `H` is type-aware (a fact's read-recency fades faster than a belief's), `K` is
 * the access half-saturation (diminishing returns on repeated reads), `D` is the
 * per-conflict multiplicative discount, `w_r + w_f = 1`. All are tunable options.
 */

import type { Atom, AtomType, MemoryEvent } from './types.js';

// --- Public types ---

export type GroundingQuadrant = 'well-grounded' | 'review' | 'promote' | 'noise';

export interface GroundingOptions {
  /** Injectable clock (ms since epoch). Default `Date.now()` — pass a fixed value in tests. */
  now?: number;
  /** Per-type read-recency half-life in days. Merged over {@link DEFAULT_HALF_LIVES}. */
  halfLives?: Partial<Record<AtomType, number>>;
  /** Access half-saturation `K`: `frequency = 1 - 2^(-n_access/K)`. Default {@link DEFAULT_ACCESS_HALF_SATURATION}. */
  accessHalfSaturation?: number;
  /** Per-conflict multiplicative discount `D` (0..1). Default {@link DEFAULT_CONFLICT_DECAY}. */
  conflictDecay?: number;
  /** Weight on the recency component (frequency weight is `1 - recencyWeight`). Default 0.5. */
  recencyWeight?: number;
  /** Prior (confidence) threshold `τ_p` for the quadrant split. Default {@link DEFAULT_PRIOR_THRESHOLD}. */
  priorThreshold?: number;
  /** Grounding threshold `τ_g` for the quadrant split. Default {@link DEFAULT_GROUNDING_THRESHOLD}. */
  groundingThreshold?: number;
  /** Distinct read-sessions required before a low-prior/high-grounding atom is an *actionable* `promote`. Default {@link DEFAULT_PROMOTE_MIN_SESSIONS}. */
  promoteMinSessions?: number;
  /** Sessions that must elapse since creation before a low/low atom is an *actionable* `noise` candidate. Default {@link DEFAULT_NOISE_SESSIONS}. */
  noiseSessions?: number;
  /** Include non-active atoms and `conflict`-type atoms (off by default — drafts are pre-vetting, archived are gone, conflicts are transient). */
  includeAll?: boolean;
}

/** Per-atom usage inputs, surfaced so an operator can audit *why* a score landed where it did. */
export interface GroundingInputs {
  /** Count of `atom_read` events referencing the atom. */
  n_access: number;
  /** Count of `conflict_detected` events referencing the atom. */
  n_conflict: number;
  /** Distinct `session_id`s among the atom's `atom_read` events. */
  session_diversity: number;
  /** Days since the atom's `created_at`. */
  age_days: number;
  /** Days since the atom's most recent `atom_read` (null if never read). */
  days_since_last_read: number | null;
  /** Distinct global sessions first seen at/after `created_at` (the "N sessions" the atom has lived through). */
  sessions_since_creation: number;
}

export interface GroundingReport {
  atom_id: string;
  type: AtomType;
  /** Writer-set `confidence` — the prior. Never modified here. */
  prior: number;
  /** Usage-derived posterior in [0.01, 1.0]. */
  grounding_score: number;
  quadrant: GroundingQuadrant;
  /** Whether this atom warrants operator action (the quadrant alone is not enough — see guards). */
  actionable: boolean;
  reason: string;
  inputs: GroundingInputs;
}

export interface GroundingResult {
  reports: GroundingReport[];
  summary: {
    total: number;
    actionable: number;
    by_quadrant: Record<GroundingQuadrant, number>;
  };
}

// --- Defaults (all overridable via GroundingOptions) ---

/**
 * Read-recency half-life per atom type, days. The five from #245 (fact 30 ·
 * belief 180 · preference 60 · decision 90 · procedure 365) plus defensible
 * values for the rest: constraints are stable rules (180), open_questions and
 * conflicts go stale fast (30), entity_summaries are medium (90).
 */
export const DEFAULT_HALF_LIVES: Record<AtomType, number> = {
  fact: 30,
  belief: 180,
  preference: 60,
  decision: 90,
  procedure: 365,
  constraint: 180,
  open_question: 30,
  entity_summary: 90,
  conflict: 30,
};
/** Fallback half-life for any type not in {@link DEFAULT_HALF_LIVES}. */
export const DEFAULT_HALF_LIFE = 90;
export const DEFAULT_ACCESS_HALF_SATURATION = 5;
export const DEFAULT_CONFLICT_DECAY = 0.6;
export const DEFAULT_PRIOR_THRESHOLD = 0.6;
export const DEFAULT_GROUNDING_THRESHOLD = 0.5;
export const DEFAULT_PROMOTE_MIN_SESSIONS = 2;
export const DEFAULT_NOISE_SESSIONS = 5;

const GROUNDING_FLOOR = 0.01;
const GROUNDING_CEIL = 1.0;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// --- Quadrant classification (exported for direct testing) ---

export interface ClassifyContext {
  priorThreshold: number;
  groundingThreshold: number;
  /** distinct read-sessions for the atom (promote guard). */
  sessionDiversity: number;
  promoteMinSessions: number;
  /** sessions elapsed since the atom was created (noise guard). */
  sessionsSinceCreation: number;
  noiseSessions: number;
}

export interface QuadrantVerdict {
  quadrant: GroundingQuadrant;
  actionable: boolean;
  reason: string;
}

/**
 * Pure 2×2 classifier. The quadrant is a function of (prior, grounding) alone;
 * `actionable` is gated by the usage guards so a single-session burst doesn't
 * trigger a promotion and a brand-new low/low atom isn't called noise yet.
 */
export function classifyQuadrant(prior: number, grounding: number, ctx: ClassifyContext): QuadrantVerdict {
  const highPrior = prior >= ctx.priorThreshold;
  const highGrounding = grounding >= ctx.groundingThreshold;

  if (highPrior && highGrounding) {
    return { quadrant: 'well-grounded', actionable: false, reason: 'high confidence, well supported by use' };
  }
  if (highPrior && !highGrounding) {
    return {
      quadrant: 'review',
      actionable: true,
      reason: 'stated confidently but rarely/never validated by use — candidate for review',
    };
  }
  if (!highPrior && highGrounding) {
    if (ctx.sessionDiversity >= ctx.promoteMinSessions) {
      return {
        quadrant: 'promote',
        actionable: true,
        reason: `written cautiously but recalled across ${ctx.sessionDiversity} sessions — candidate for promotion`,
      };
    }
    return {
      quadrant: 'promote',
      actionable: false,
      reason: 'usage grounding from a single session — needs cross-session corroboration',
    };
  }
  // low prior, low grounding
  if (ctx.sessionsSinceCreation >= ctx.noiseSessions) {
    return {
      quadrant: 'noise',
      actionable: true,
      reason: `low confidence and untouched across ${ctx.sessionsSinceCreation} sessions — noise candidate`,
    };
  }
  return {
    quadrant: 'noise',
    actionable: false,
    reason: 'low confidence and low grounding, but too recent to judge',
  };
}

// --- Internal helpers ---

function round(value: number, places: number): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

interface EventIndex {
  readTimestamps: Map<string, number[]>;
  readSessions: Map<string, Set<string>>;
  conflictCount: Map<string, number>;
  /** Ascending list of each session's earliest-seen timestamp (ms). */
  sessionStartTimes: number[];
}

function indexEvents(events: MemoryEvent[]): EventIndex {
  const readTimestamps = new Map<string, number[]>();
  const readSessions = new Map<string, Set<string>>();
  const conflictCount = new Map<string, number>();
  const sessionFirstSeen = new Map<string, number>();

  for (const evt of events) {
    const ts = Date.parse(evt.timestamp);
    const validTs = !Number.isNaN(ts);

    if (validTs && evt.session_id) {
      const prev = sessionFirstSeen.get(evt.session_id);
      if (prev === undefined || ts < prev) sessionFirstSeen.set(evt.session_id, ts);
    }

    if (!evt.atom_refs) continue;

    if (evt.action === 'atom_read') {
      for (const ref of evt.atom_refs) {
        if (validTs) {
          const arr = readTimestamps.get(ref);
          if (arr) arr.push(ts);
          else readTimestamps.set(ref, [ts]);
        }
        // Gate the session add on validTs too, so n_access (timestamps) and
        // session_diversity (sessions) move together — a malformed-timestamp
        // read contributes to neither rather than inflating diversity alone.
        if (validTs && evt.session_id) {
          const s = readSessions.get(ref);
          if (s) s.add(evt.session_id);
          else readSessions.set(ref, new Set([evt.session_id]));
        }
      }
    } else if (evt.action === 'conflict_detected') {
      // Gate on validTs for the same reason atom_read is (above): a
      // malformed-timestamp event we won't trust for recency shouldn't be
      // trusted to multiplicatively discount the grounding score either.
      if (validTs) {
        for (const ref of evt.atom_refs) {
          conflictCount.set(ref, (conflictCount.get(ref) ?? 0) + 1);
        }
      }
    }
  }

  return {
    readTimestamps,
    readSessions,
    conflictCount,
    sessionStartTimes: [...sessionFirstSeen.values()].sort((a, b) => a - b),
  };
}

/** Count of sessions whose earliest-seen timestamp is at/after `createdMs` (binary search on the ascending array). */
function countSessionsSince(sortedStartTimes: number[], createdMs: number): number {
  let lo = 0;
  let hi = sortedStartTimes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedStartTimes[mid] < createdMs) lo = mid + 1;
    else hi = mid;
  }
  return sortedStartTimes.length - lo;
}

// --- Main entry point ---

/**
 * Compute per-atom grounding scores + 2×2 quadrant classification from the event
 * log. Pure and read-only — no atom files are touched.
 *
 * @param atoms   loaded atoms (caller does the I/O — typically `listAtoms`)
 * @param events  the event log (typically `readEvents`)
 */
export function computeGrounding(
  atoms: Atom[],
  events: MemoryEvent[],
  options: GroundingOptions = {},
): GroundingResult {
  const now = options.now ?? Date.now();
  const halfLives = { ...DEFAULT_HALF_LIVES, ...(options.halfLives ?? {}) };
  const K = options.accessHalfSaturation ?? DEFAULT_ACCESS_HALF_SATURATION;
  const conflictDecay = options.conflictDecay ?? DEFAULT_CONFLICT_DECAY;
  const recencyWeight = options.recencyWeight ?? 0.5;
  const frequencyWeight = 1 - recencyWeight;
  const priorThreshold = options.priorThreshold ?? DEFAULT_PRIOR_THRESHOLD;
  const groundingThreshold = options.groundingThreshold ?? DEFAULT_GROUNDING_THRESHOLD;
  const promoteMinSessions = options.promoteMinSessions ?? DEFAULT_PROMOTE_MIN_SESSIONS;
  const noiseSessions = options.noiseSessions ?? DEFAULT_NOISE_SESSIONS;
  const includeAll = options.includeAll ?? false;

  // `computeGrounding` is a public export; validate the scalar knobs so a bad
  // override fails loudly here rather than silently producing NaN/garbage that
  // the [0.01, 1] clamp would mask. (`!(x >= a && x <= b)` also rejects NaN.)
  if (!(recencyWeight >= 0 && recencyWeight <= 1)) {
    throw new RangeError(`recencyWeight must be in [0, 1], got ${recencyWeight}`);
  }
  if (!(K > 0)) {
    throw new RangeError(`accessHalfSaturation must be > 0, got ${K}`);
  }
  if (!(conflictDecay >= 0 && conflictDecay <= 1)) {
    throw new RangeError(`conflictDecay must be in [0, 1], got ${conflictDecay}`);
  }
  // The quadrant split + actionable guards are public knobs too; an out-of-range
  // threshold silently empties the off-diagonal quadrants and NaN makes the `>=`
  // guards always-false, so validate them here rather than only in the CLI.
  if (!(priorThreshold >= 0 && priorThreshold <= 1)) {
    throw new RangeError(`priorThreshold must be in [0, 1], got ${priorThreshold}`);
  }
  if (!(groundingThreshold >= 0 && groundingThreshold <= 1)) {
    throw new RangeError(`groundingThreshold must be in [0, 1], got ${groundingThreshold}`);
  }
  if (!(Number.isFinite(promoteMinSessions) && promoteMinSessions >= 0)) {
    throw new RangeError(`promoteMinSessions must be a finite number >= 0, got ${promoteMinSessions}`);
  }
  if (!(Number.isFinite(noiseSessions) && noiseSessions >= 0)) {
    throw new RangeError(`noiseSessions must be a finite number >= 0, got ${noiseSessions}`);
  }

  const idx = indexEvents(events);
  const reports: GroundingReport[] = [];

  for (const atom of atoms) {
    const fm = atom.frontmatter;
    if (!includeAll) {
      if (fm.status !== 'active') continue;
      if (fm.type === 'conflict') continue;
    }

    const id = fm.id;
    const createdMs = Date.parse(fm.created_at);
    const hasCreated = !Number.isNaN(createdMs);
    const ageDays = hasCreated ? Math.max(0, (now - createdMs) / MS_PER_DAY) : 0;

    const reads = idx.readTimestamps.get(id) ?? [];
    const nAccess = reads.length;
    // reduce, not Math.max(...spread): a hot atom can accumulate >128k reads,
    // which overflows the spread/apply argument limit and throws RangeError.
    const lastReadMs = reads.length ? reads.reduce((m, t) => (t > m ? t : m), -Infinity) : null;
    const daysSinceLastRead = lastReadMs === null ? null : Math.max(0, (now - lastReadMs) / MS_PER_DAY);
    const sessionDiversity = idx.readSessions.get(id)?.size ?? 0;
    const nConflict = idx.conflictCount.get(id) ?? 0;
    const sessionsSinceCreation = hasCreated ? countSessionsSince(idx.sessionStartTimes, createdMs) : 0;

    const H = halfLives[fm.type] ?? DEFAULT_HALF_LIFE;
    // Never read → zero recency grounding (grounding is from *use*, not existence).
    const recency = daysSinceLastRead === null ? 0 : 2 ** (-daysSinceLastRead / H);
    const frequency = 1 - 2 ** (-nAccess / K);
    const raw = (recencyWeight * recency + frequencyWeight * frequency) * conflictDecay ** nConflict;
    const grounding = Math.min(GROUNDING_CEIL, Math.max(GROUNDING_FLOOR, raw));

    const verdict = classifyQuadrant(fm.confidence, grounding, {
      priorThreshold,
      groundingThreshold,
      sessionDiversity,
      promoteMinSessions,
      sessionsSinceCreation,
      noiseSessions,
    });

    reports.push({
      atom_id: id,
      type: fm.type,
      prior: fm.confidence,
      grounding_score: round(grounding, 4),
      quadrant: verdict.quadrant,
      actionable: verdict.actionable,
      reason: verdict.reason,
      inputs: {
        n_access: nAccess,
        n_conflict: nConflict,
        session_diversity: sessionDiversity,
        age_days: round(ageDays, 2),
        days_since_last_read: daysSinceLastRead === null ? null : round(daysSinceLastRead, 2),
        sessions_since_creation: sessionsSinceCreation,
      },
    });
  }

  // Deterministic order: actionable first, then atom_id for stability.
  reports.sort((a, b) => Number(b.actionable) - Number(a.actionable) || a.atom_id.localeCompare(b.atom_id));

  const by_quadrant: Record<GroundingQuadrant, number> = {
    'well-grounded': 0,
    review: 0,
    promote: 0,
    noise: 0,
  };
  let actionable = 0;
  for (const r of reports) {
    by_quadrant[r.quadrant]++;
    if (r.actionable) actionable++;
  }

  return { reports, summary: { total: reports.length, actionable, by_quadrant } };
}
