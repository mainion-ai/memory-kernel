/**
 * Canonical ordering of the 9 mk atom types. Used by the timeline layout
 * to assign a Y band per type (band index = position in this array).
 *
 * Order matches the visual hierarchy decided during phase 2 design:
 * facts and beliefs at top (most concrete / observed), conflicts at
 * bottom (synthesised). Don't reorder casually — fixture screenshots
 * and the legend depend on this sequence.
 */
export const ATOM_TYPE_ORDER: readonly string[] = [
  'fact',
  'belief',
  'decision',
  'preference',
  'constraint',
  'procedure',
  'entity_summary',
  'open_question',
  'conflict',
] as const;

/** Returns the band index 0..8 for a known type, or `ATOM_TYPE_ORDER.length`
 *  (i.e. one band below the bottom) for unknown types so they sort last but
 *  remain visible. Never throws. */
export function typeBandIndex(type: string): number {
  const i = ATOM_TYPE_ORDER.indexOf(type);
  return i === -1 ? ATOM_TYPE_ORDER.length : i;
}

/** Total number of bands the timeline layout needs to allocate vertical
 *  space for, including the unknown-types fallback row. */
export const TIMELINE_BAND_COUNT = ATOM_TYPE_ORDER.length + 1;


/**
 * Canonical ordering of the 8 mk atom statuses. Used by the filter panel
 * to render status checkboxes in a stable, intuitive order:
 * "live" statuses first (active / accepted), then transient (draft),
 * then terminal (rejected / superseded / resolved / archived / expired).
 */
export const ATOM_STATUS_ORDER: readonly string[] = [
  'active',
  'accepted',
  'draft',
  'rejected',
  'superseded',
  'resolved',
  'archived',
  'expired',
] as const;

/**
 * Canonical ordering of the 4 mk atom classifications. Used by the filter
 * panel to render classification checkboxes in increasing-restriction
 * order (PUBLIC at the top, SECRET at the bottom).
 */
export const ATOM_CLASSIFICATION_ORDER: readonly string[] = [
  'PUBLIC',
  'TEAM',
  'PERSONAL',
  'SECRET',
] as const;
