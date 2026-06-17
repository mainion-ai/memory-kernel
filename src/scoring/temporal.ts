/**
 * Temporal scoring — recency weighting via exponential decay.
 *
 * Pure (clock-dependent) ranking primitive extracted from recall.ts so it can
 * be unit-tested in isolation. Re-exported from recall.ts for API stability.
 */

/**
 * Exponential temporal decay: 1.0 at age=0, 0.5 at age=halfLife, 0.25 at age=2*halfLife.
 * Future-dated atoms are clamped to decay=1.0 (no boost beyond 1).
 */
export function temporalDecay(createdAt: string, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return 0; // Guard against division by zero
  const ageMs = Date.now() - new Date(createdAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, Math.max(0, ageDays) / halfLifeDays);
}
