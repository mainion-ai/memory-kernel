/**
 * Known legacy enum values and their canonical replacements (#191 Phase 2).
 *
 * Keyed by *dotted Zod path with numeric indices stripped*, so
 * `relations[0].type` becomes `relations.type` here. That keeps the table
 * value-driven rather than position-driven — every relation entry in every
 * atom shares the same `type` namespace.
 *
 * A `string` value means "auto-migrate to this canonical replacement".
 * A `null` value means "we know about this legacy value but have decided
 * not to auto-migrate it — surface as remaining with a manual-review note".
 * A value absent from the table means we have no opinion yet — surface as
 * remaining with the "no migration registered" survey-mode message.
 *
 * **This table is intentionally seeded only with the examples explicitly
 * called out in #191's issue body.** Real legacy values from Mai's and
 * Taj's stores must be surveyed via `mk doctor --fix --dry-run --json`
 * and added here before merging.
 */
export type MigrationOutcome = string | null;

export const ATOM_SCHEMA_MIGRATIONS: Record<string, Record<string, MigrationOutcome>> = {
  status: {
    // #191 issue body example: obsolete → archived.
    obsolete: 'archived',
    // Observed in operator stores as a sibling of `obsolete` — same
    // "old, no longer in use" semantics, same target.
    deprecated: 'archived',
  },
  classification: {
    // #191 issue body example: PUBLIC_FRIENDLY → PUBLIC.
    PUBLIC_FRIENDLY: 'PUBLIC',
    // Pre-1.20 name for `PERSONAL`. Observed instances in operator
    // stores are uniformly personal-scope content, so the rename
    // applies without semantic loss.
    PRIVATE: 'PERSONAL',
  },
  'relations.type': {
    // Commit 2 seed — kebab-case predates the underscore canonicalisation.
    'caused-by': 'caused_by',
    'applied-to': 'applied_to',
    // `references` was never in RELATION_TYPES; nearest valid equivalent is `related`.
    'references': 'related',
    // Reverse/incoming edge types that occasionally appear in frontmatter by mistake.
    // null → surface in remaining[] for manual review. Collapsing direction is lossy
    // (e.g. `extended_by: PARENT` → `related: PARENT` destroys hierarchy for graph-boost).
    'referenced_by': null,
    'extended_by': null,
    'related_by': null,
    'supported_by': null,
    'applied_from': null,
  },
};

/** Convert a Zod issue path to the table lookup key (strip numeric segments). */
export function migrationKey(path: readonly (string | number)[]): string {
  return path.filter((seg) => typeof seg === 'string').join('.');
}

/** Look up a migration. Returns `undefined` when the key is absent entirely. */
export function lookupMigration(
  pathKey: string,
  actualValue: unknown,
): MigrationOutcome | undefined {
  if (typeof actualValue !== 'string') return undefined;
  const table = ATOM_SCHEMA_MIGRATIONS[pathKey];
  if (!table) return undefined;
  if (!(actualValue in table)) return undefined;
  return table[actualValue];
}
