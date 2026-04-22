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
import { searchFts, indexExists } from './index-db.js';
import type { ConsolidateOptions, ConsolidateResult, ConsolidateAtomResult } from './types.js';

export type { ConsolidateOptions, ConsolidateResult, ConsolidateAtomResult };
export type { ConsolidateAtomStatus } from './types.js';

// FTS rank threshold for duplicate detection.
// BM25 ranks are negative; more negative = better match.
// A rank < -2.0 indicates a strong match (same as extract.ts DUPLICATE_RANK_THRESHOLD).
const DEFAULT_DUPLICATE_THRESHOLD = -2.0;

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
      a.frontmatter.scope?.tags?.includes('auto-extracted'),
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
      const newTags = currentTags.filter((t) => t !== 'auto-extracted');

      // Build scope update: preserve existing scope, update tags
      const newScope = atom.frontmatter.scope
        ? { ...atom.frontmatter.scope, tags: newTags }
        : newTags.length > 0 ? { tags: newTags } : undefined;

      updateAtom({
        memoryDir,
        agent_id: agentId,
        session_id: sessionId,
        filePath: atom.filePath,
        updates: {
          status: 'active',
          scope: newScope,
        },
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
