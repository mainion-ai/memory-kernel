import type { ParsedAtom, ParsedRelation } from './atom-parser.js';
import {
  TYPE_COLORS, TYPE_COLOR_FALLBACK,
  RELATION_COLORS, RELATION_COLOR_FALLBACK,
  CLASSIFICATION_BORDERS, CLASSIFICATION_BORDER_FALLBACK,
  STATUS_OPACITY, STATUS_OPACITY_FALLBACK,
  SOURCE_DASH, SOURCE_DASH_FALLBACK,
  DEFAULT_RELATION_WEIGHT, DEFAULT_RELATION_WEIGHT_FALLBACK,
} from './visual.js';

/** F2 node fill: color = atom type. */
export function nodeColor(atom: ParsedAtom): string {
  return TYPE_COLORS[atom.type] ?? TYPE_COLOR_FALLBACK;
}

/** F2 node radius (px): 4 + 6 * log10(citations + 1). */
export function nodeSize(citationCount: number): number {
  const safe = Math.max(0, citationCount);
  return 4 + 6 * Math.log10(safe + 1);
}

/** F2 node border: classification (PUBLIC/TEAM/PERSONAL/SECRET). */
export function nodeBorderColor(atom: ParsedAtom): string {
  return CLASSIFICATION_BORDERS[atom.classification] ?? CLASSIFICATION_BORDER_FALLBACK;
}

/** F2 node opacity by status. Expired → 0 (renderer should hide instead of draw). */
export function nodeOpacity(atom: ParsedAtom): number {
  return STATUS_OPACITY[atom.status] ?? STATUS_OPACITY_FALLBACK;
}

/** F2 edge color: relation type. */
export function edgeColor(rel: ParsedRelation): string {
  return RELATION_COLORS[rel.type] ?? RELATION_COLOR_FALLBACK;
}

/** F2 edge width: 1 + 2 * (rel.weight ?? type_default), clamped to [0.5, 8]. */
export function edgeWidth(rel: ParsedRelation): number {
  const weight = rel.weight ?? DEFAULT_RELATION_WEIGHT[rel.type] ?? DEFAULT_RELATION_WEIGHT_FALLBACK;
  const w = 1 + 2 * weight;
  return Math.max(0.5, Math.min(8, w));
}

/** F2 edge dash: source pattern. Manual = solid. */
export function edgeDash(rel: ParsedRelation): ReadonlyArray<number> {
  if (!rel.source) return SOURCE_DASH_FALLBACK;
  return SOURCE_DASH[rel.source] ?? SOURCE_DASH_FALLBACK;
}

/** F2 edge opacity: 0.3 + 0.7 * confidence (never below 0.3). */
export function edgeOpacity(rel: ParsedRelation): number {
  const c = rel.confidence ?? 1.0;
  const clamped = Math.max(0, Math.min(1, c));
  return 0.3 + 0.7 * clamped;
}
