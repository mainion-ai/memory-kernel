/**
 * Recall operation — progressive disclosure context loading.
 * "What do I need to know for this task?"
 *
 * Strategy:
 * - Always load: INDEX, HANDOFF, CONSTRAINTS (cheap routing context)
 * - Conditionally load: atoms matching scope/tags/type
 * - Episodes: only on explicit request
 */

import { readView, listAtoms } from './store.js';
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

  // Load all atoms and filter
  const allAtoms = listAtoms(memoryDir);
  let filtered = filterAtoms(allAtoms, query);

  // Sort by relevance: active first, then by updated_at descending
  filtered.sort((a, b) => {
    const statusOrder = getStatusPriority(a.frontmatter.status) - getStatusPriority(b.frontmatter.status);
    if (statusOrder !== 0) return statusOrder;
    return b.frontmatter.updated_at.localeCompare(a.frontmatter.updated_at);
  });

  // Apply token budget if specified
  if (query.max_tokens) {
    filtered = applyTokenBudget(filtered, query.max_tokens);
  }

  // Estimate tokens (rough: 4 chars per token)
  const baseTokens = estimateTokens(index + handoff + constraints);
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

    // Exclude SECRET by default
    if (fm.classification === 'SECRET') return false;

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
 * Check if two scope paths overlap (prefix matching).
 */
function pathOverlaps(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
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
