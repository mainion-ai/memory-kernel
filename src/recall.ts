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
import { listEpisodes } from './episodes.js';
import { appendEvent } from './event-log.js';
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

  // Task-aware re-ranking: if a task is provided, use FTS BM25 scores to re-order.
  // Atoms with a strong match are surfaced first; unmatched atoms retain their status order.
  // FTS5 rank is negative (lower = better match in SQLite BM25 convention).
  if (query.task && query.task.trim().length > 0) {
    const ftsResults = searchFts(memoryDir, query.task, Math.max(filtered.length, 200));
    if (ftsResults && ftsResults.length > 0) {
      // Build score map: atom_id → rank (negative; lower is better)
      const scoreMap = new Map(ftsResults.map((r) => [r.atom_id, r.rank]));
      filtered.sort((a, b) => {
        const rankA = scoreMap.get(a.frontmatter.id) ?? 0; // 0 = no match = worst
        const rankB = scoreMap.get(b.frontmatter.id) ?? 0;
        // Both match FTS: sort by rank ascending (lower/more-negative = better)
        if (rankA !== 0 || rankB !== 0) {
          if (rankA !== rankB) return rankA - rankB;
        }
        // Fallback: status priority, then recency
        const statusOrder = getStatusPriority(a.frontmatter.status) - getStatusPriority(b.frontmatter.status);
        if (statusOrder !== 0) return statusOrder;
        return b.frontmatter.updated_at.localeCompare(a.frontmatter.updated_at);
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

  // Episodes — load on demand only (never included in startup context by default)
  let episodeStrings: string[] | undefined;
  let episodeTokens = 0;
  if (query.include_episodes) {
    const episodes = listEpisodes(memoryDir, { limit: 10 });
    // If a task is specified, prefer episodes whose summary contains matching keywords
    const relevant = query.task
      ? episodes.filter((ep) =>
          query.task!.toLowerCase().split(/\s+/).some((word) =>
            ep.summary.toLowerCase().includes(word),
          ),
        )
      : episodes;
    episodeStrings = relevant.map(
      (ep) => `## Episode: ${ep.id}\n\n${ep.summary}`,
    );
    episodeTokens = episodeStrings.reduce((s, e) => s + estimateTokens(e), 0);
  }

  const bundle: ContextBundle = {
    index,
    handoff,
    constraints,
    atoms: filtered,
    ...(episodeStrings !== undefined && { episodes: episodeStrings }),
    token_estimate: baseTokens + atomTokens + episodeTokens,
  };

  // Emit read audit event if caller supplied provenance fields
  if (query.agent_id && query.session_id) {
    appendEvent(memoryDir, 'atom_read', {
      agent_id: query.agent_id,
      session_id: query.session_id,
      atom_refs: filtered.map((a) => a.frontmatter.id),
      meta: {
        operation: 'recall',
        query_task: query.task,
        atoms_returned: filtered.length,
        token_estimate: bundle.token_estimate,
      },
    });
  }

  return bundle;
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
