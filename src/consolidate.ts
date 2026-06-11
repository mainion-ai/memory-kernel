/**
 * consolidate — lifecycle pipeline for reviewing and promoting draft atoms.
 *
 * Finds draft atoms (optionally filtered to auto-extracted ones), checks for
 * near-duplicates using FTS, and promotes clean atoms to active status.
 *
 * This is the lifecycle completion step for `mk extract`.
 */

import path from 'path';
import { listAtoms } from './store.js';
import { updateAtom } from './retain.js';
import { appendEvent } from './event-log.js';
import { serializeAtom } from './format.js';
import { searchFts, indexExists } from './index-db.js';
import type { ConsolidateOptions, ConsolidateResult, ConsolidateAtomResult, Relation } from './types.js';
import { RELATION_TYPES, AUTO_EXTRACTED_TAG } from './types.js';

export type { ConsolidateOptions, ConsolidateResult, ConsolidateAtomResult };
export type { ConsolidateAtomStatus } from './types.js';

// FTS rank threshold for duplicate detection.
// BM25 ranks are negative; more negative = better match.
// A rank < -2.0 indicates a strong match (same as extract.ts DUPLICATE_RANK_THRESHOLD).
const DEFAULT_DUPLICATE_THRESHOLD = -2.0;

/**
 * Canonical mappings for stale relation types from older mk versions.
 * Used during promotion to silently fix relation types that no longer pass schema validation.
 */
const STALE_RELATION_TYPE_MAP: Record<string, string> = {
  seeded: 'related',
  complements: 'related',
  synthesizes: 'related',
  qualifies: 'related',
  evidenced_by: 'supports',
  grounds: 'supports',
  refines: 'extends',
};

/**
 * Canonicalize any stale/invalid relation types on an atom's relations array.
 * Returns the cleaned relations array, or undefined if all were removed/unchanged.
 * Relations with empty targets are dropped; unknown stale types are mapped to 'related'.
 */
function canonicalizeRelations(relations: Relation[] | undefined): {
  relations: Relation[] | undefined;
  changed: boolean;
} {
  if (!relations || relations.length === 0) return { relations, changed: false };

  const validTypes = new Set<string>(RELATION_TYPES);
  let changed = false;
  const cleaned: Relation[] = [];

  for (const rel of relations) {
    // Drop relations with empty or missing target
    if (!rel.target || rel.target.trim() === '') {
      changed = true;
      continue;
    }

    const currentType = rel.type as string;
    if (validTypes.has(currentType)) {
      cleaned.push(rel);
    } else {
      changed = true;
      const canonical = STALE_RELATION_TYPE_MAP[currentType] ?? 'related';
      cleaned.push({ ...rel, type: canonical as Relation['type'] });
    }
  }

  return {
    relations: cleaned.length > 0 ? cleaned : undefined,
    changed,
  };
}

/**
 * Extract the first non-empty line of the body as a title, stripping leading markdown headers.
 */
function extractTitle(body: string, fallback: string): string {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) {
      return trimmed.replace(/^#+\s*/, '');
    }
  }
  return fallback;
}

/**
 * Extract slug from file path (filename without extension).
 */
function extractSlug(filePath: string | undefined, id: string): string {
  if (!filePath) return id;
  return path.basename(filePath, '.md');
}

/**
 * Consolidate draft atoms: check for duplicates and promote clean ones to active.
 *
 * Algorithm:
 * 1. List all atoms with status 'draft'
 * 2. Filter by 'auto-extracted' tag by default (--all includes all drafts)
 * 3. For each draft, run FTS near-duplicate check against existing store
 * 4. In dry-run: report what would happen, no writes
 * 5. Promote clean drafts to active (remove auto-extracted tag)
 * 6. Skip possible duplicates (no writes)
 */
export async function consolidateAtoms(opts: ConsolidateOptions): Promise<ConsolidateResult> {
  const {
    memoryDir,
    agentId = 'consolidate',
    sessionId = `consolidate-${Date.now()}`,
    dryRun = false,
    all = false,
    type: filterType,
    limit = 50,
    duplicateThreshold = DEFAULT_DUPLICATE_THRESHOLD,
  } = opts;

  // 1. List all atoms, filter to drafts
  const allAtoms = listAtoms(memoryDir);
  let drafts = allAtoms.filter((a) => a.frontmatter.status === 'draft');

  // 2. Filter by auto-extracted tag unless --all
  if (!all) {
    drafts = drafts.filter((a) =>
      a.frontmatter.scope?.tags?.includes(AUTO_EXTRACTED_TAG),
    );
  }

  // 3. Filter by type if specified
  if (filterType) {
    drafts = drafts.filter((a) => a.frontmatter.type === filterType);
  }

  // 4. Apply limit
  drafts = drafts.slice(0, limit);

  const atomResults: ConsolidateAtomResult[] = [];
  let promoted = 0;
  let skipped = 0;
  let errors = 0;

  const hasIndex = indexExists(memoryDir);

  for (const atom of drafts) {
    const id = atom.frontmatter.id;
    const type = atom.frontmatter.type;
    const slug = extractSlug(atom.filePath, id);
    const title = extractTitle(atom.body, id);

    // Skip SECRET and PERSONAL atoms — classified atoms must not be auto-processed
    const classification = atom.frontmatter.classification;
    if (classification === 'SECRET' || classification === 'PERSONAL') {
      continue;
    }

    // Near-duplicate check using FTS (only when index is available)
    let possibleDuplicateOf: string | null = null;
    if (hasIndex && atom.body.trim()) {
      const query = atom.body.slice(0, 200);
      const results = searchFts(memoryDir, query, 2);
      if (results && results.length > 0) {
        // Find the best match that is NOT this atom itself
        const top = results.find((r) => r.atom_id !== id);
        if (top !== undefined && top.rank < duplicateThreshold) {
          possibleDuplicateOf = top.atom_id;
        }
      }
    }

    if (possibleDuplicateOf !== null) {
      // Skip — possible duplicate
      skipped++;
      atomResults.push({
        atom_id: id,
        slug,
        type,
        status: dryRun ? 'would_skip' : 'skipped',
        title,
        reason: 'possible duplicate',
        possible_duplicate_of: possibleDuplicateOf,
      });
      continue;
    }

    if (dryRun) {
      // Dry run — report what would happen
      promoted++;
      atomResults.push({
        atom_id: id,
        slug,
        type,
        status: 'would_promote',
        title,
      });
      continue;
    }

    // Guard: filePath must be defined for updateAtom
    if (!atom.filePath) {
      errors++;
      atomResults.push({
        atom_id: id,
        slug,
        type,
        status: 'error',
        title,
        reason: 'atom has no file path (cannot update)',
      });
      continue;
    }

    try {
      // Promote: update status to 'active', remove 'auto-extracted' tag
      const currentTags = atom.frontmatter.scope?.tags ?? [];
      const newTags = currentTags.filter((t) => t !== AUTO_EXTRACTED_TAG);

      // Build scope update: preserve existing scope, update tags (omit empty array)
      const newScope = atom.frontmatter.scope
        ? { ...atom.frontmatter.scope, tags: newTags.length > 0 ? newTags : undefined }
        : newTags.length > 0 ? { tags: newTags } : undefined;

      // Canonicalize stale relation types from older mk versions before calling
      // updateAtom — schema validation inside updateAtom would otherwise throw.
      const { relations: cleanedRelations } = canonicalizeRelations(atom.frontmatter.relations);

      const updatedAtom = updateAtom({
        memoryDir,
        agent_id: agentId,
        session_id: sessionId,
        filePath: atom.filePath,
        updates: {
          status: 'active',
          scope: newScope,
          ...(cleanedRelations !== undefined || atom.frontmatter.relations !== undefined
            ? { relations: cleanedRelations }
            : {}),
        },
      });

      // Emit atom_promoted for semantic audit trail (updateAtom emits atom_updated
      // which records the field-level change; atom_promoted records the lifecycle event)
      appendEvent(memoryDir, 'atom_promoted', {
        agent_id: agentId,
        session_id: sessionId,
        atom_refs: [id],
        schema_version: 2,
        atom_snapshot: serializeAtom(updatedAtom),
        meta: { from_status: 'draft', to_status: 'active' },
      });

      promoted++;
      atomResults.push({
        atom_id: id,
        slug,
        type,
        status: 'promoted',
        title,
      });
    } catch (err) {
      errors++;
      atomResults.push({
        atom_id: id,
        slug,
        type,
        status: 'error',
        title,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    processed: drafts.length,
    promoted,
    skipped,
    errors,
    dry_run: dryRun,
    atoms: atomResults,
  };
}
