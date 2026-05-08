import type { PluginEvent } from './event-parser.js';

export type BucketUnit = 'day' | 'week' | 'month';

export interface HistogramBucket {
  /** Inclusive lower bound (ISO8601, midnight UTC for day/week, first-of-month for month). */
  start: string;
  /** Number of events whose timestamp falls in [start, nextStart). */
  count: number;
}

export interface Histogram {
  unit: BucketUnit;
  buckets: HistogramBucket[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Choose a bucket unit so there are roughly 30..120 buckets across the
 *  visible range. Day for short ranges, week for a year-or-less, month
 *  beyond. */
export function pickBucketUnit(fromIso: string, toIso: string): BucketUnit {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 'day';
  const days = (to - from) / DAY_MS;
  if (days <= 60) return 'day';
  if (days <= 365) return 'week';
  return 'month';
}

function startOfDayUtc(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function startOfWeekUtc(ms: number): number {
  // ISO week starts Monday. JavaScript: 0 = Sunday → shift by ((day + 6) % 7).
  const d = new Date(ms);
  const day = d.getUTCDay();
  const shift = (day + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - shift);
}

function startOfMonthUtc(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function nextBucket(ms: number, unit: BucketUnit): number {
  if (unit === 'day') return ms + DAY_MS;
  if (unit === 'week') return ms + 7 * DAY_MS;
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

function alignStart(ms: number, unit: BucketUnit): number {
  if (unit === 'day') return startOfDayUtc(ms);
  if (unit === 'week') return startOfWeekUtc(ms);
  return startOfMonthUtc(ms);
}

/**
 * Bucket events by [from, to] inclusive at the unit chosen by `pickBucketUnit`.
 * Empty buckets are kept so the renderer can draw a continuous histogram.
 * Events outside the range are silently skipped.
 */
export function computeHistogram(
  events: PluginEvent[],
  fromIso: string,
  toIso: string,
): Histogram {
  const unit = pickBucketUnit(fromIso, toIso);
  const fromMs = Date.parse(fromIso);
  const toMs = Date.parse(toIso);

  const buckets: HistogramBucket[] = [];
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
    return { unit, buckets };
  }

  let cursor = alignStart(fromMs, unit);
  while (cursor <= toMs) {
    buckets.push({ start: new Date(cursor).toISOString(), count: 0 });
    cursor = nextBucket(cursor, unit);
  }

  for (const ev of events) {
    const ts = Date.parse(ev.timestamp);
    if (!Number.isFinite(ts) || ts < fromMs || ts > toMs) continue;
    // Find the bucket index by aligned-start subtraction. Linear scan is
    // fine — buckets count is bounded by ~120, and event count by ~10k.
    for (let i = 0; i < buckets.length; i++) {
      const startMs = Date.parse(buckets[i].start);
      const nextMs = i + 1 < buckets.length ? Date.parse(buckets[i + 1].start) : nextBucket(startMs, unit);
      if (ts >= startMs && ts < nextMs) { buckets[i].count++; break; }
    }
  }

  return { unit, buckets };
}
