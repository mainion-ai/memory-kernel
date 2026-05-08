/**
 * Visual constants for the F2 baseline encoding (spec §5.2).
 * All values are duplicated from mk-core deliberately — the plugin must
 * not import the memory-kernel runtime (native deps break the renderer).
 * Keep in sync with src/cli/export-obsidian.ts:TYPE_COLORS and the spec.
 */

/** Hex strings (CSS-friendly) for atom-type node fills. Derived from
 *  src/cli/export-obsidian.ts TYPE_COLORS (RGB ints reformatted as #RRGGBB). */
export const TYPE_COLORS: Record<string, string> = {
  belief:         '#4A90D9',
  fact:           '#27AE60',
  decision:       '#E67E22',
  open_question:  '#9B59B6',
  preference:     '#E91E63',
  constraint:     '#E74C3C',
  procedure:      '#1ABC9C',
  entity_summary: '#F1C40F',
  conflict:       '#FF5722',
};

/** Fallback fill for atoms with an unknown type. */
export const TYPE_COLOR_FALLBACK = '#95A5A6';

/** Edge palette — distinct from node palette per spec §5.2. */
export const RELATION_COLORS: Record<string, string> = {
  extends:    '#3498DB', // blue
  contradicts:'#C0392B', // dark red
  supports:   '#2ECC71', // green
  caused_by:  '#8E44AD', // purple
  supersedes: '#D35400', // dark orange
  applied_to: '#16A085', // dark teal
  related:    '#7F8C8D', // grey
};

export const RELATION_COLOR_FALLBACK = '#7F8C8D';

/** Border colors per classification (F2 spec §5.2). */
export const CLASSIFICATION_BORDERS: Record<string, string> = {
  PUBLIC:   '#27AE60', // green
  TEAM:     '#3498DB', // blue (default)
  PERSONAL: '#F39C12', // orange
  SECRET:   '#C0392B', // red
};

export const CLASSIFICATION_BORDER_FALLBACK = '#3498DB';

/** Status → opacity (F2 spec §5.2). The renderer should filter expired
 *  atoms before passing to force-graph; the `expired: 0` entry here is
 *  defense-in-depth so a missed filter still hides the node rather than
 *  drawing it visibly. */
export const STATUS_OPACITY: Record<string, number> = {
  draft:      0.5,
  active:     1.0,
  accepted:   1.0,
  rejected:   0.4,
  superseded: 0.3,
  resolved:   0.7,
  archived:   0.2,
  expired:    0.0,
};

export const STATUS_OPACITY_FALLBACK = 1.0;

/** Edge-source dash patterns (F2 spec §5.2). [] = solid.
 *  - manual: solid (full-width)
 *  - extracted: clearly dashed (long on, medium off)
 *  - enriched: proper dots (1px on, wide gap)
 *  - unknown: solid but rendered at half width by edgeWidth so it's
 *    visually distinct from manual */
export const SOURCE_DASH: Record<string, ReadonlyArray<number>> = {
  manual:    Object.freeze([]),
  extracted: Object.freeze([8, 4]),
  enriched:  Object.freeze([1, 5]),
  unknown:   Object.freeze([]),
};

export const SOURCE_DASH_FALLBACK: ReadonlyArray<number> = Object.freeze([]);

/** SECRET classification gets a 🔒 glyph badge per spec §5.2. */
export const SECRET_GLYPH = '🔒';

/** Per-relation-type wander weights. Mirrors mk-core's
 *  WEIGHT_PRESETS.constitution from src/wander.ts:51-54 (the plugin's
 *  default wander preset). Used by F2 edge width when the relation has
 *  no explicit `weight` set. Keep in sync with src/wander.ts. */
export const DEFAULT_RELATION_WEIGHT: Record<string, number> = {
  extends:     1.5,
  supports:    0.7,
  contradicts: 0.3,
  caused_by:   0.5,
  supersedes:  0.2,
  applied_to:  0.6,
  related:     0.2,
};

/** Fallback weight for unknown relation types. Matches mk-core's runtime
 *  fallback (DEFAULT_TYPE_WEIGHTS.related = 0.3 in src/wander.ts:46). */
export const DEFAULT_RELATION_WEIGHT_FALLBACK = 0.3;
