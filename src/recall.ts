/**
 * Recall operation — progressive disclosure context loading.
 * "What do I need to know for this task?"
 *
 * Strategy:
 * - Always load: INDEX, HANDOFF, CONSTRAINTS (cheap routing context)
 * - Conditionally load: atoms matching scope/tags/type
 * - Episodes: only on explicit request
 */

import { readView, listAtoms, readAtom } from './store.js';
import { queryIndex, searchFts } from './index-db.js';
import type { Atom, ContextBundle, RecallQuery } from './types.js';

/**
 * Recall relevant context for a task.
 */
export function recall(
  memoryDir: string,
  query: RecallQuery = {},
): ContextBundle {
  // Always load core views
  const index = readView(memoryDir, 'INDEX.md');
  const handoff = readView(memoryDir, 'HANDOFF.md');
  const constraints = readView(memoryDir, 'CONSTRAINTS.md');

  // Try indexed query first, fall back to file scan
  let filtered: Atom[];
  const indexResults = queryIndex(memoryDir, query);

  if (indexResults !== null) {
    // Index available — load only matching atoms from files
    filtered = indexResults
      .map((r) => {
        try {
          return readAtom(r.file_path);
        } catch {
          return null; // File removed but index stale — skip
        }
      })
      .filter((a): a is Atom => a !== null);
    // Already sorted by index query (status priority, updated_at DESC)
  } else {
    // No index — full file scan + in-memory filter
    const allAtoms = listAtoms(memoryDir);
    filtered = filterAtoms(allAtoms, query);

    // Sort by relevance: active first, then by updated_at descending
    filtered.sort((a, b) => {
      const statusOrder = getStatusPriority(a.frontmatter.status) - getStatusPriority(b.frontmatter.status);
      if (statusOrder !== 0) return statusOrder;
      return b.frontmatter.updated_at.localeCompare(a.frontmatter.updated_at);
    });
  }

  // Task-aware re-ranking: use FTS5 BM25 scores to boost relevant atoms
  if (query.task && query.task.trim().length > 0) {
    const ftsResults = searchFts(memoryDir, query.task);
    if (ftsResults && ftsResults.length > 0) {
      // Build score map — FTS5 rank: more negative = better match
      const scoreMap = new Map<string, number>();
      for (const r of ftsResults) {
        scoreMap.set(r.atom_id, r.rank);
      }
      // Sort: FTS-matched atoms first (by rank), then unmatched in original order
      filtered.sort((a, b) => {
        const sa = scoreMap.get(a.frontmatter.id);
        const sb = scoreMap.get(b.frontmatter.id);
        if (sa !== undefined && sb !== undefined) return sa - sb; // both matched
        if (sa !== undefined) return -1; // a matched, b didn't
        if (sb !== undefined) return 1;  // b matched, a didn't
        return 0; // neither matched — preserve prior order
      });
    }
  }

  // Estimate base view tokens (rough: 4 chars per token)
  const baseTokens = estimateTokens(index + handoff + constraints);

  // Apply token budget if specified (subtract base view cost first)
  if (query.max_tokens) {
    const atomBudget = Math.max(0, query.max_tokens - baseTokens);
    filtered = applyTokenBudget(filtered, atomBudget);
  }
  const atomTokens = filtered.reduce(
    (sum, a) => sum + estimateTokens(a.body + JSON.stringify(a.frontmatter)),
    0,
  );

  return {
    index,
    handoff,
    constraints,
    atoms: filtered,
    token_estimate: baseTokens + atomTokens,
  };
}

/**
 * Filter atoms based on query criteria.
 */
function filterAtoms(atoms: Atom[], query: RecallQuery): Atom[] {
  return atoms.filter((atom) => {
    const fm = atom.frontmatter;

    // Exclude archived/expired by default
    if (fm.status === 'archived' || fm.status === 'expired') return false;

    // Exclude SECRET and PERSONAL by default
    if (fm.classification === 'SECRET' || fm.classification === 'PERSONAL') return false;

    // Filter by type
    if (query.types && !query.types.includes(fm.type)) return false;

    // Filter by status
    if (query.statuses && !query.statuses.includes(fm.status)) return false;

    // Filter by tags
    if (query.tags && query.tags.length > 0) {
      const atomTags = fm.scope?.tags ?? [];
      if (!query.tags.some((t) => atomTags.includes(t))) return false;
    }

    // Filter by paths (scope overlap)
    if (query.paths && query.paths.length > 0) {
      const atomPaths = fm.scope?.paths ?? [];
      if (atomPaths.length === 0) return true; // Unscoped atoms match everything
      if (!query.paths.some((p) => atomPaths.some((ap) => pathOverlaps(ap, p)))) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Check if two scope paths overlap (directory-boundary prefix matching).
 * Uses path separator boundary to prevent false positives:
 * e.g. 'src/comp' does NOT overlap 'src/components', but
 * 'src/comp' DOES overlap 'src/comp/foo'.
 */
function pathOverlaps(a: string, b: string): boolean {
  if (a === b) return true;
  const aSep = a.endsWith('/') ? a : a + '/';
  const bSep = b.endsWith('/') ? b : b + '/';
  return a.startsWith(bSep) || b.startsWith(aSep);
}

/**
 * Status priority for sorting (lower = higher priority).
 */
function getStatusPriority(status: string): number {
  const priorities: Record<string, number> = {
    active: 0,
    draft: 1,
    accepted: 2,
    resolved: 3,
    rejected: 4,
    superseded: 5,
    archived: 6,
    expired: 7,
  };
  return priorities[status] ?? 99;
}

/**
 * Trim atom list to fit within token budget.
 */
function applyTokenBudget(atoms: Atom[], maxTokens: number): Atom[] {
  const result: Atom[] = [];
  let total = 0;

  for (const atom of atoms) {
    const tokens = estimateTokens(atom.body + JSON.stringify(atom.frontmatter));
    if (total + tokens > maxTokens) break;
    result.push(atom);
    total += tokens;
  }

  return result;
}

/**
 * Rough token estimate (4 chars per token).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
