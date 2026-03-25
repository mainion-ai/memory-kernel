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
import { queryIndex, searchFts, getAllEmbeddings } from './index-db.js';
import { listEpisodes } from './episodes.js';
import { appendEvent } from './event-log.js';
import { cosineSimilarity, deserializeVector, getEmbeddingConfig, atomToEmbeddingText } from './embeddings.js';
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
  // When embeddings are available and a query vector is provided, combine FTS + semantic scores.
  // FTS5 rank is negative (lower = better match in SQLite BM25 convention).
  if (query.task && query.task.trim().length > 0) {
    const ftsResults = searchFts(memoryDir, query.task, Math.max(filtered.length, 200));

    // Build FTS score map
    const ftsScoreMap = new Map<string, number>();
    if (ftsResults && ftsResults.length > 0) {
      // Normalize FTS ranks to 0-1 range (rank is negative, lower = better)
      const minRank = Math.min(...ftsResults.map((r) => r.rank));
      const maxRank = Math.max(...ftsResults.map((r) => r.rank));
      const range = maxRank - minRank || 1;
      for (const r of ftsResults) {
        // Invert and normalize: best match → 1, worst → 0
        ftsScoreMap.set(r.atom_id, 1 - (r.rank - minRank) / range);
      }
    }

    // Build semantic score map (if query vector provided or embeddings available)
    const semanticScoreMap = new Map<string, number>();
    if (query.queryVector) {
      const stored = getAllEmbeddings(memoryDir);
      if (stored && stored.length > 0) {
        for (const { atom_id, embedding } of stored) {
          const similarity = cosineSimilarity(query.queryVector, deserializeVector(embedding));
          if (similarity > 0) {
            semanticScoreMap.set(atom_id, similarity);
          }
        }
      }
    }

    const hasFts = ftsScoreMap.size > 0;
    const hasSemantic = semanticScoreMap.size > 0;

    if (hasFts || hasSemantic) {
      // Combine scores: FTS weight 0.4, semantic weight 0.6 (semantic is better for intent matching)
      const FTS_WEIGHT = hasSemantic ? 0.4 : 1.0;
      const SEMANTIC_WEIGHT = hasFts ? 0.6 : 1.0;

      filtered.sort((a, b) => {
        const ftsA = ftsScoreMap.get(a.frontmatter.id) ?? 0;
        const ftsB = ftsScoreMap.get(b.frontmatter.id) ?? 0;
        const semA = semanticScoreMap.get(a.frontmatter.id) ?? 0;
        const semB = semanticScoreMap.get(b.frontmatter.id) ?? 0;

        const scoreA = ftsA * FTS_WEIGHT + semA * SEMANTIC_WEIGHT;
        const scoreB = ftsB * FTS_WEIGHT + semB * SEMANTIC_WEIGHT;

        // Higher combined score = better match
        if (scoreA !== scoreB) return scoreB - scoreA;

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
 * Async recall with automatic semantic re-ranking.
 *
 * If embeddings are configured and a task is provided, this embeds the query
 * text and passes the vector to `recall()` for hybrid FTS + semantic ranking.
 * Falls back to FTS-only ranking when embeddings are unavailable.
 */
export async function recallWithEmbeddings(
  memoryDir: string,
  query: RecallQuery = {},
): Promise<ContextBundle> {
  // If a task is provided and embeddings are configured, embed the query
  if (query.task && query.task.trim().length > 0 && !query.queryVector) {
    const config = getEmbeddingConfig();
    if (config) {
      try {
        const { embedText } = await import('./embeddings.js');
        const result = await embedText(query.task, config);
        return recall(memoryDir, { ...query, queryVector: result.vector });
      } catch {
        // Degrade gracefully — use FTS-only ranking
      }
    }
  }

  return recall(memoryDir, query);
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
