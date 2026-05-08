import type { ParsedAtom } from './atom-parser.js';
import { typeBandIndex, TIMELINE_BAND_COUNT } from './atom-types.js';

export interface TimelineLayoutOptions {
  width: number;
  height: number;
  /** Inclusive lower bound for the X axis. Atoms older than this clamp to the left margin. */
  fromIso: string;
  /** Inclusive upper bound for the X axis. Atoms newer than this clamp to the right margin. */
  toIso: string;
  /** Horizontal padding inside the view. Default 40px. */
  marginX?: number;
  /** Vertical padding inside the view. Default 32px. */
  marginY?: number;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Place atoms on a timeline:
 *  - X = (createdAt - from) / (to - from) * (width - 2*margin) + margin
 *  - Y = bandTop + bandHeight * jitter(id)
 *  - bandTop = marginY + bandIndex * bandHeight
 *  - bandHeight = (height - 2*marginY) / TIMELINE_BAND_COUNT
 *
 * Jitter is deterministic (seeded by atom id) so re-renders don't shuffle
 * Y positions. Range [0.2, 0.8] of band height to keep nodes off the
 * band boundaries.
 */
export function computeTimelinePositions(
  atoms: ParsedAtom[],
  opts: TimelineLayoutOptions,
): Map<string, Point> {
  const out = new Map<string, Point>();
  if (atoms.length === 0) return out;

  const marginX = opts.marginX ?? 40;
  const marginY = opts.marginY ?? 32;
  const usableW = Math.max(1, opts.width - 2 * marginX);
  const usableH = Math.max(1, opts.height - 2 * marginY);
  const bandHeight = usableH / TIMELINE_BAND_COUNT;

  const fromMs = Date.parse(opts.fromIso);
  const toMs = Date.parse(opts.toIso);
  const span = Math.max(1, toMs - fromMs);

  for (const a of atoms) {
    const tMs = Date.parse(a.createdAt);
    let xFrac = Number.isFinite(tMs) ? (tMs - fromMs) / span : 0.5;
    if (xFrac < 0) xFrac = 0;
    if (xFrac > 1) xFrac = 1;
    const x = marginX + xFrac * usableW;

    const band = typeBandIndex(a.type);
    const bandTop = marginY + band * bandHeight;
    const jitter = idJitter(a.id); // [0..1)
    const y = bandTop + bandHeight * (0.2 + 0.6 * jitter);

    out.set(a.id, { x, y });
  }

  return out;
}

/** Tiny deterministic 32-bit hash → [0..1). Stable across runs and platforms. */
function idJitter(id: string): number {
  let h = 2166136261 >>> 0; // FNV-1a basis
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0) / 4294967296;
}
