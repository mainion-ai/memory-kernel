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
import { queryIndex, searchFts, getAllEmbeddings, getAllRelations, getTermDocumentFrequencies, getCorpusSize, getAtomsMatchingTerm } from './index-db.js';
import { listEpisodes } from './episodes.js';
import { appendEvent } from './event-log.js';
import { cosineSimilarity, deserializeVector, getEmbeddingConfig, embedText } from './embeddings.js';
import { DEFAULT_TYPE_WEIGHTS, DEFAULT_CONFIDENCE_FLOOR, DEFAULT_TYPE_RESERVATIONS } from './schema.js';
import type { Atom, ContextBundle, Episode, RecallQuery, AtomType } from './types.js';

// --- Configurable hybrid ranking parameters ---

/** Weight for semantic cosine similarity in hybrid ranking (0-1). Default 0.6. */
const DEFAULT_SEMANTIC_WEIGHT = 0.6;
/** Minimum cosine similarity to include an atom in semantic results. Default 0.3. */
const DEFAULT_MIN_SIMILARITY = 0.3;
/** Default temporal decay half-life in days. */
const DEFAULT_DECAY_HALF_LIFE = 30;
/** Default weight of recency in final score (0 = relevance only, 1 = recency only). */
const DEFAULT_DECAY_WEIGHT = 0.2;
/** Default neighbor boost factor for graph-walk spreading activation. */
const DEFAULT_NEIGHBOR_BOOST = 0.15;
/** Maximum fraction of total token budget that episodes may consume. */
const MAX_EPISODE_BUDGET_RATIO = 0.2;

function getSemanticWeight(): number {
  const v = parseFloat(process.env.SEMANTIC_WEIGHT || '');
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : DEFAULT_SEMANTIC_WEIGHT;
}

function getFtsWeight(): number {
  return 1 - getSemanticWeight();
}

function getMinSimilarity(): number {
  const v = parseFloat(process.env.MIN_SIMILARITY || '');
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : DEFAULT_MIN_SIMILARITY;
}

function getDecayHalfLife(query: RecallQueryInternal): number {
  if (query.decay_half_life !== undefined) return query.decay_half_life;
  const v = parseFloat(process.env.RECALL_DECAY_HALF_LIFE || '');
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_DECAY_HALF_LIFE;
}

function getDecayWeight(query: RecallQueryInternal): number {
  if (query.decay_weight !== undefined) return query.decay_weight;
  const v = parseFloat(process.env.RECALL_DECAY_WEIGHT || '');
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : DEFAULT_DECAY_WEIGHT;
}

function getTypeWeights(query: RecallQueryInternal): Record<AtomType, number> {
  const base = { ...DEFAULT_TYPE_WEIGHTS };
  const envRaw = process.env.RECALL_TYPE_WEIGHTS;
  if (envRaw) {
    try {
      Object.assign(base, JSON.parse(envRaw));
    } catch {
      process.stderr.write('memory-kernel: RECALL_TYPE_WEIGHTS is not valid JSON, using defaults\n');
    }
  }
  if (query.type_weights) Object.assign(base, query.type_weights);
  return base;
}

function getTypeReservations(query: RecallQueryInternal): Partial<Record<AtomType, number>> {
  // Fix 1: When task is provided, skip reservations by default — task recall should
  // be relevance-driven, not type-guaranteed. Reservations are designed for the
  // no-task constitution pipeline (CLAUDE.md render), not for task-focused recall.
  // Fix 2: Explicit --no-reservations / --reservations flag overrides auto-behavior.
  //   no_reservations === true  → force off (--no-reservations)
  //   no_reservations === false → force on  (--reservations, overrides task auto-disable)
  //   no_reservations === undefined → auto (off for task, on for no-task)
  // Explicit force-off disables reservations entirely, including any caller-supplied overrides.
  if (query.no_reservations === true) return {};
  // Task auto-disable: caller-supplied type_reservations still act as an opt-in override.
  if (query.no_reservations !== false && query.task && query.task.trim().length > 0) {
    if (query.type_reservations) return { ...query.type_reservations };
    return {};
  }
  const base = { ...DEFAULT_TYPE_RESERVATIONS };
  const envRaw = process.env.RECALL_TYPE_RESERVATIONS;
  if (envRaw) {
    try {
      Object.assign(base, JSON.parse(envRaw));
    } catch {
      process.stderr.write('memory-kernel: RECALL_TYPE_RESERVATIONS is not valid JSON, using defaults\n');
    }
  }
  if (query.type_reservations) Object.assign(base, query.type_reservations);
  return base;
}

function getConfidenceFloor(): number {
  const v = parseFloat(process.env.RECALL_CONFIDENCE_FLOOR || '');
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : DEFAULT_CONFIDENCE_FLOOR;
}

function getNeighborBoost(): number {
  const v = parseFloat(process.env.RECALL_NEIGHBOR_BOOST || '');
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : DEFAULT_NEIGHBOR_BOOST;
}

/** Default IDF damping strength (1.0 = full damping). */
const DEFAULT_IDF_DAMPING = 1.0;

/** Default content-length normalization strength (0.5 = moderate). */
const DEFAULT_LENGTH_NORM_K = 0.5;

function getIdfDamping(query: RecallQueryInternal): number {
  if (query.idf_damping !== undefined) return Math.max(0, Math.min(1, query.idf_damping));
  const v = parseFloat(process.env.RECALL_IDF_DAMPING || '');
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : DEFAULT_IDF_DAMPING;
}

/** Default coverage boost exponent (0.5 = square root, gentle boost). */
const DEFAULT_COVERAGE_BOOST = 0.5;

/** Max allowed coverage_boost exponent — values above 2 produce extreme penalties. */
const MAX_COVERAGE_BOOST = 2;

function getCoverageBoost(query: RecallQueryInternal): number {
  if (query.coverage_boost !== undefined) return Math.max(0, Math.min(MAX_COVERAGE_BOOST, query.coverage_boost));
  const v = parseFloat(process.env.RECALL_COVERAGE_BOOST || '');
  return Number.isFinite(v) && v >= 0 && v <= MAX_COVERAGE_BOOST ? v : DEFAULT_COVERAGE_BOOST;
}

/**
 * Compute per-atom coverage boost factors based on how many query terms each atom matches.
 *
 * An atom matching all query terms gets boost = 1.0 (no change).
 * An atom matching only a fraction gets boost = coverage^P where P is the exponent.
 * This penalizes partial-match atoms that appear in FTS results via high per-term BM25
 * but only match 1 of N query terms.
 *
 * For single-term queries, all FTS matches have coverage = 1.0 (no penalty).
 */
export function computeCoverageBoosts(
  memoryDir: string,
  queryTerms: string[],
  ftsResults: { atom_id: string; rank: number }[],
  filtered: Atom[],
  exponent: number,
): Map<string, number> {
  const boosts = new Map<string, number>();

  // No penalty when disabled, single term (all matches have coverage=1), or no FTS results
  if (exponent === 0 || queryTerms.length <= 1 || ftsResults.length === 0) {
    return boosts; // empty map — callers use ?? 1.0
  }

  // Build per-term FTS match sets (porter-stemmed, matches title+body)
  const termAtomSets = new Map<string, Set<string>>();
  for (const term of queryTerms) {
    termAtomSets.set(term, getAtomsMatchingTerm(memoryDir, term));
  }

  // Build set of filtered atom IDs for intersection check
  const filteredIds = new Set(filtered.map(a => a.frontmatter.id));
  const ftsAtomIds = new Set(ftsResults.map(r => r.atom_id));

  for (const atomId of ftsAtomIds) {
    if (!filteredIds.has(atomId)) continue;

    let matchedTerms = 0;
    for (const term of queryTerms) {
      if (termAtomSets.get(term)?.has(atomId)) {
        matchedTerms++;
      }
    }

    const coverage = matchedTerms / queryTerms.length;
    // coverageBoost = coverage^P — e.g. (1/3)^0.5 ≈ 0.58, (2/3)^0.5 ≈ 0.82, 1.0^0.5 = 1.0
    const boost = Math.pow(coverage, exponent);
    boosts.set(atomId, boost);
  }

  return boosts;
}

/** Max allowed length_norm_k — values above 2 produce extreme penalties. */
const MAX_LENGTH_NORM_K = 2;

function getLengthNormK(query: RecallQueryInternal): number {
  if (query.length_norm_k !== undefined) return Math.max(0, Math.min(MAX_LENGTH_NORM_K, query.length_norm_k));
  const v = parseFloat(process.env.RECALL_LENGTH_NORM_K || '');
  return Number.isFinite(v) && v >= 0 && v <= MAX_LENGTH_NORM_K ? v : DEFAULT_LENGTH_NORM_K;
}

/**
 * Compute per-atom length normalization factors.
 *
 * Atoms longer than the average word count in the result set get a penalty
 * factor < 1.0. Atoms at or below average get 1.0 (no boost).
 *
 * Formula: lengthFactor = 1 / (1 + k * (wordCount / avgWordCount - 1))
 * where k controls penalty strength. Clamped to 1.0 for short atoms.
 */
export function computeLengthFactors(
  filtered: Atom[],
  k: number,
): Map<string, number> {
  const factors = new Map<string, number>();

  if (k === 0 || filtered.length === 0) return factors;

  // Compute word counts
  const wordCounts = new Map<string, number>();
  let totalWords = 0;
  for (const atom of filtered) {
    const wc = atom.body.split(/\s+/).filter(w => w.length > 0).length;
    wordCounts.set(atom.frontmatter.id, wc);
    totalWords += wc;
  }

  const avgWordCount = totalWords / filtered.length;

  // Edge case: all atoms empty or single atom
  if (avgWordCount === 0) return factors;

  for (const atom of filtered) {
    const id = atom.frontmatter.id;
    const wc = wordCounts.get(id) ?? 0;
    const ratio = wc / avgWordCount;

    if (ratio <= 1.0) {
      // At or below average — no penalty (factor = 1.0)
      factors.set(id, 1.0);
    } else {
      // Above average — apply penalty
      const factor = 1 / (1 + k * (ratio - 1));
      factors.set(id, factor);
    }
  }

  return factors;
}

/**
 * Compute per-atom specificity scores based on IDF of matched query terms.
 *
 * Atoms matching only ubiquitous terms (low IDF) get penalized; atoms matching
 * rare terms get scores closer to 1.0. Returns atom_id → specificity (0-1).
 * Atoms not in FTS results default to 1.0 (no penalty).
 *
 * For single-term queries, all matches get 1.0 (IDF ratio is always 1).
 */
function computeSpecificityScores(
  memoryDir: string,
  queryTerms: string[],
  ftsResults: { atom_id: string; rank: number }[],
  filtered: Atom[],
  damping: number,
): Map<string, number> {
  const scores = new Map<string, number>();

  // No penalty when damping disabled, single term, or no FTS results
  if (damping === 0 || queryTerms.length <= 1 || ftsResults.length === 0) {
    return scores; // empty map — callers use ?? 1.0
  }

  // Get document frequencies and corpus size
  const dfMap = getTermDocumentFrequencies(memoryDir, queryTerms);
  const corpusSize = getCorpusSize(memoryDir);
  if (!dfMap || corpusSize === 0) {
    return scores; // graceful degradation
  }

  // Compute IDF per query term: idf(term) = log(1 + N / df(term))
  const idfMap = new Map<string, number>();
  let totalIdf = 0;
  for (const term of queryTerms) {
    const df = dfMap.get(term) ?? 0;
    const idf = df > 0 ? Math.log(1 + corpusSize / df) : Math.log(1 + corpusSize);
    idfMap.set(term, idf);
    totalIdf += idf;
  }

  if (totalIdf === 0) return scores;

  // Build a set of FTS-matched atom IDs for quick lookup
  const ftsAtomIds = new Set(ftsResults.map(r => r.atom_id));

  // Build per-term FTS match sets (porter-stemmed, matches title+body)
  // This avoids the stemmer mismatch: FTS stems "running" → "run" and matches
  // atoms containing "run", but a raw substring check for "running" would miss them.
  const termAtomSets = new Map<string, Set<string>>();
  for (const term of queryTerms) {
    termAtomSets.set(term, getAtomsMatchingTerm(memoryDir, term));
  }

  // Build set of filtered atom IDs for intersection check
  const filteredIds = new Set(filtered.map(a => a.frontmatter.id));

  // Score each FTS-matched atom
  for (const atomId of ftsAtomIds) {
    if (!filteredIds.has(atomId)) continue; // atom not in filtered set

    let matchedIdf = 0;
    for (const term of queryTerms) {
      // Use per-term FTS results: porter-stemmed, covers both title and body
      if (termAtomSets.get(term)?.has(atomId)) {
        matchedIdf += idfMap.get(term) ?? 0;
      }
    }

    const rawSpecificity = matchedIdf / totalIdf;
    // Apply damping: blend between 1.0 (no penalty) and rawSpecificity (full penalty)
    const specificity = 1.0 - damping * (1.0 - rawSpecificity);
    scores.set(atomId, specificity);
  }

  return scores;
}

/**
 * Exponential temporal decay: 1.0 at age=0, 0.5 at age=halfLife, 0.25 at age=2*halfLife.
 * Future-dated atoms are clamped to decay=1.0 (no boost beyond 1).
 */
export function temporalDecay(createdAt: string, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return 0; // Guard against division by zero
  const ageMs = Date.now() - new Date(createdAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, Math.max(0, ageDays) / halfLifeDays);
}

/**
 * Score an episode against a task query using term-overlap relevance + temporal decay.
 *
 * Episodes are not in the FTS index, so we compute a lightweight TF-based relevance
 * score: fraction of query terms that appear in the episode summary. Combined with
 * temporal decay so recent episodes rank higher when relevance is similar.
 */
interface ScoredEpisode {
  episode: Episode;
  formatted: string;
  score: number;
  relevance: number; // term-overlap component (0 = no query terms matched)
  tokens: number;
}

function scoreEpisodes(
  episodes: Episode[],
  task: string | undefined,
  halfLifeDays: number,
  decayWeight: number,
): ScoredEpisode[] {
  const scored: ScoredEpisode[] = [];

  // Tokenize query once
  const queryTerms = task
    ? task.toLowerCase().split(/\s+/).filter(t => t.length > 1)
    : [];

  for (const ep of episodes) {
    const formatted = `## Episode: ${ep.id}\n\n${ep.summary}`;
    const tokens = estimateTokens(formatted);

    if (queryTerms.length === 0) {
      // No task — score by recency only
      const recency = ep.metadata.started_at
        ? temporalDecay(ep.metadata.started_at, halfLifeDays)
        : 0.5;
      scored.push({ episode: ep, formatted, score: recency, relevance: 1, tokens });
      continue;
    }

    // Term-overlap relevance: fraction of query terms found in the summary.
    // Case-insensitive substring match (same behaviour as before, but normalized).
    const summaryLower = ep.summary.toLowerCase();
    let hits = 0;
    for (const term of queryTerms) {
      if (summaryLower.includes(term)) hits++;
    }
    const relevance = hits / queryTerms.length;

    // Temporal decay
    const recency = ep.metadata.started_at
      ? temporalDecay(ep.metadata.started_at, halfLifeDays)
      : 0.5;

    // Composite: same formula as atoms (relevance * (1 - decayWeight) + recency * decayWeight)
    const score = relevance * (1 - decayWeight) + recency * decayWeight;

    scored.push({ episode: ep, formatted, score, relevance, tokens });
  }

  // Sort descending by score, then by recency (started_at) as tiebreaker
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return (b.episode.metadata.started_at ?? '').localeCompare(
      a.episode.metadata.started_at ?? '',
    );
  });

  return scored;
}

/** @internal Extended query with pre-computed embedding vector — not part of the public API. */
export interface RecallQueryInternal extends RecallQuery {
  queryVector?: number[];
}

/**
 * Recall relevant context for a task.
 */
export function recall(
  memoryDir: string,
  query: RecallQueryInternal = {},
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
    // Note: index query returns status+updated_at ordering, but we re-sort
    // below to apply temporal decay — the index sort is insufficient.
  } else {
    // No index — full file scan + in-memory filter
    const allAtoms = listAtoms(memoryDir);
    filtered = filterAtoms(allAtoms, query);
  }

  // --- Scoring setup (phases 1 + 2) ---
  const halfLife = getDecayHalfLife(query);
  const decayWeight = getDecayWeight(query);
  const typeWeights = getTypeWeights(query);
  const confFloor = getConfidenceFloor();

  // Task-aware re-ranking: if a task is provided, use FTS BM25 scores to re-order.
  // When embeddings are available and a query vector is provided, combine FTS + semantic scores.
  // FTS5 rank is negative (lower = better match in SQLite BM25 convention).
  if (query.task && query.task.trim().length > 0) {
    const ftsResults = searchFts(memoryDir, query.task, Math.max(filtered.length, 200));

    // Build FTS score map
    const ftsScoreMap = new Map<string, number>();
    if (ftsResults && ftsResults.length > 0) {
      // Normalize FTS ranks to 0-1 range (rank is negative, lower = better).
      // Uses reduce instead of Math.min(...) to avoid stack overflow with large arrays.
      let minRank = Infinity;
      let maxRank = -Infinity;
      for (const r of ftsResults) {
        if (r.rank < minRank) minRank = r.rank;
        if (r.rank > maxRank) maxRank = r.rank;
      }
      const range = maxRank - minRank || 1; // single result → range 1, score 1.0
      for (const r of ftsResults) {
        // Invert and normalize: best match → 1, worst → 0
        ftsScoreMap.set(r.atom_id, 1 - (r.rank - minRank) / range);
      }
    }

    // IDF hub damping: compute specificity scores to penalize promiscuous-vocabulary atoms.
    // Tokenize query for specificity computation (same as episode scoring).
    const idfDamping = getIdfDamping(query);
    const queryTerms = query.task!.toLowerCase().split(/\s+/).filter(t => t.length > 1);
    const specificityScores = idfDamping > 0 && queryTerms.length > 1
      ? computeSpecificityScores(memoryDir, queryTerms, ftsResults ?? [], filtered, idfDamping)
      : new Map<string, number>();

    // Content-length normalization: penalize long atoms that get inflated BM25 scores.
    const lengthNormK = getLengthNormK(query);
    const lengthFactors = lengthNormK > 0
      ? computeLengthFactors(filtered, lengthNormK)
      : new Map<string, number>();

    // Query-term coverage boost: penalize atoms matching few query terms.
    const coverageExponent = getCoverageBoost(query);
    const coverageBoosts = coverageExponent > 0 && queryTerms.length > 1
      ? computeCoverageBoosts(memoryDir, queryTerms, ftsResults ?? [], filtered, coverageExponent)
      : new Map<string, number>();

    // Build semantic score map (if query vector provided or embeddings available)
    const semanticScoreMap = new Map<string, number>();
    if (query.queryVector) {
      const minSim = getMinSimilarity();
      const stored = getAllEmbeddings(memoryDir);
      if (stored && stored.length > 0) {
        for (const { atom_id, embedding } of stored) {
          const similarity = cosineSimilarity(query.queryVector, deserializeVector(embedding));
          if (similarity >= minSim) {
            semanticScoreMap.set(atom_id, similarity);
          }
        }
      }
    }

    const hasFts = ftsScoreMap.size > 0;
    const hasSemantic = semanticScoreMap.size > 0;

    // finalScoreMap is populated when signals exist; stays empty otherwise.
    // An empty map degrades gracefully: applyTokenBudget falls back to
    // insertion-order greedy fill (all scores 0 → stable sort).
    let finalScoreMap = new Map<string, number>();

    if (hasFts || hasSemantic) {
      // Combine scores using configurable weights (env SEMANTIC_WEIGHT, default 0.6).
      // When only one signal is available, it gets full weight.
      const FTS_WEIGHT = hasSemantic ? getFtsWeight() : 1.0;
      const SEMANTIC_WEIGHT = hasFts ? getSemanticWeight() : 1.0;

      // Memoize final_score per atom before sorting (O(n)) to avoid re-computing
      // decay + type_weight + conf_factor inside the comparator (O(n log n) otherwise).
      for (const atom of filtered) {
        const id = atom.frontmatter.id;
        const ftsRaw = ftsScoreMap.get(id) ?? 0;
        const fts = ftsRaw * (specificityScores.get(id) ?? 1.0) * (lengthFactors.get(id) ?? 1.0) * (coverageBoosts.get(id) ?? 1.0);
        const sem = semanticScoreMap.get(id) ?? 0;
        const relevance = fts * FTS_WEIGHT + sem * SEMANTIC_WEIGHT;
        const recency = temporalDecay(atom.frontmatter.created_at, halfLife);
        const baseScore = relevance * (1 - decayWeight) + recency * decayWeight;
        const typeWeight = typeWeights[atom.frontmatter.type] ?? 1.0;
        // conf_factor: floor + (1-floor)*confidence — ensures even 0-confidence atoms
        // still contribute at `floor` level rather than being zeroed out
        const confFactor = confFloor + (1 - confFloor) * atom.frontmatter.confidence;
        finalScoreMap.set(id, baseScore * typeWeight * confFactor);
      }

      // Phase 3: graph-walk boost (single-hop spreading activation).
      // query.graph_boost takes precedence over env var when explicitly set.
      const useGraphBoost = query.graph_boost !== undefined
        ? query.graph_boost
        : (process.env.RECALL_GRAPH_BOOST ?? 'true') !== 'false';
      if (useGraphBoost) {
        const relations = getAllRelations(memoryDir);
        if (relations.length > 0) {
          applyGraphBoost(finalScoreMap, relations, getNeighborBoost());
        }
      }

      filtered.sort((a, b) => {
        const scoreA = finalScoreMap.get(a.frontmatter.id) ?? 0;
        const scoreB = finalScoreMap.get(b.frontmatter.id) ?? 0;

        if (scoreA !== scoreB) return scoreB - scoreA;

        // Fallback: status priority, then recency
        const statusOrder = getStatusPriority(a.frontmatter.status) - getStatusPriority(b.frontmatter.status);
        if (statusOrder !== 0) return statusOrder;
        return b.frontmatter.updated_at.localeCompare(a.frontmatter.updated_at);
      });
    }

    // Apply token budget — always when max_tokens is set, even if FTS had no results.
    // When finalScoreMap is empty, applyTokenBudget degrades to greedy insertion-order fill.
    if (query.max_tokens) {
      const baseTokens = estimateTokens(index + handoff + constraints);
      // Reserve the episode slice up-front so atoms + episodes together stay within max_tokens.
      const episodeReservation = query.include_episodes
        ? Math.floor(query.max_tokens * MAX_EPISODE_BUDGET_RATIO)
        : 0;
      const atomBudget = Math.max(0, query.max_tokens - baseTokens - episodeReservation);
      filtered = applyTokenBudget(filtered, atomBudget, query, finalScoreMap);
    }
  } else {
    // No task: status priority first, then temporal decay (or updated_at when decay_weight=0).
    filtered.sort((a, b) => {
      const statusOrder = getStatusPriority(a.frontmatter.status) - getStatusPriority(b.frontmatter.status);
      if (statusOrder !== 0) return statusOrder;
      if (decayWeight === 0) {
        return b.frontmatter.updated_at.localeCompare(a.frontmatter.updated_at);
      }
      const decayA = temporalDecay(a.frontmatter.created_at, halfLife);
      const decayB = temporalDecay(b.frontmatter.created_at, halfLife);
      return decayB - decayA;
    });
  }

  // Estimate base view tokens (rough: 4 chars per token)
  const baseTokens = estimateTokens(index + handoff + constraints);

  // Apply token budget for no-task path (task path applies budget inside its scoring block)
  if (query.max_tokens && !(query.task && query.task.trim().length > 0)) {
    // Reserve the episode slice up-front so atoms + episodes together stay within max_tokens.
    const episodeReservation = query.include_episodes
      ? Math.floor(query.max_tokens * MAX_EPISODE_BUDGET_RATIO)
      : 0;
    const atomBudget = Math.max(0, query.max_tokens - baseTokens - episodeReservation);
    filtered = applyTokenBudget(filtered, atomBudget, query, new Map());
  }
  const atomTokens = filtered.reduce(
    (sum, a) => sum + estimateTokens(a.body + JSON.stringify(a.frontmatter)),
    0,
  );

  // Episodes — scored and budget-capped (never included in startup context by default).
  // Previously episodes were bulk-included with only a crude keyword filter, dumping
  // ~800 tokens per episode unranked. Now they go through term-overlap scoring +
  // temporal decay and compete for a capped fraction of the token budget.
  let episodeStrings: string[] | undefined;
  let episodeTokens = 0;
  if (query.include_episodes) {
    const episodes = listEpisodes(memoryDir, { limit: 20 });
    const halfLife = getDecayHalfLife(query);
    const dw = getDecayWeight(query);
    const scored = scoreEpisodes(episodes, query.task, halfLife, dw);

    // Budget-aware greedy fill: episodes get at most MAX_EPISODE_BUDGET_RATIO of total budget.
    // When no max_tokens is set, include all scored episodes (backward-compatible).
    if (query.max_tokens) {
      const episodeBudget = Math.floor(query.max_tokens * MAX_EPISODE_BUDGET_RATIO);
      const selected: ScoredEpisode[] = [];
      let used = 0;
      for (const ep of scored) {
        if (ep.relevance <= 0 && query.task) continue; // Skip zero-relevance when task is set
        if (used + ep.tokens > episodeBudget) continue; // Skip if over budget (try next smaller one)
        selected.push(ep);
        used += ep.tokens;
      }
      episodeStrings = selected.map((s) => s.formatted);
      episodeTokens = used;
    } else {
      // No budget constraint — include all (sorted by score)
      episodeStrings = scored.map((s) => s.formatted);
      episodeTokens = scored.reduce((s, e) => s + e.tokens, 0);
    }
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
  if (query.task && query.task.trim().length > 0) {
    const config = getEmbeddingConfig();
    if (config) {
      try {
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
function filterAtoms(atoms: Atom[], query: RecallQueryInternal): Atom[] {
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

/** Maximum fraction of total token budget that reservations may consume. */
const MAX_RESERVATION_RATIO = 0.3;

/**
 * Trim atom list to fit within token budget.
 *
 * Two-pass reservation-aware algorithm (Phase 2):
 * Pass 1: fill reserved type quotas from atoms of that type (sorted by score).
 * Pass 2: merge remaining atoms, greedy fill with remaining budget, re-sort by score.
 *
 * Fixes (v1.9):
 * - Fix 3: Atoms with high relevance scores bypass reservation priority.
 * - Fix 4: Total reservation budget capped at MAX_RESERVATION_RATIO (30%) of maxTokens.
 *
 * When finalScoreMap is empty (no-task path), reservation logic degrades to
 * insertion-order greedy fill (scores all 0 → stable sort).
 */
function applyTokenBudget(
  atoms: Atom[],
  maxTokens: number,
  query: RecallQueryInternal,
  finalScoreMap: Map<string, number>,
): Atom[] {
  const reservations = getTypeReservations(query);
  const reservedTypes = Object.keys(reservations) as AtomType[];

  if (reservedTypes.length === 0) {
    return greedyFill(atoms, maxTokens);
  }

  // Fix 4: Cap total reservation budget at 30% of maxTokens to prevent
  // reservations from consuming the majority of a small budget.
  const maxReservationBudget = Math.floor(maxTokens * MAX_RESERVATION_RATIO);
  const rawReservationTotal = reservedTypes.reduce(
    (sum, t) => sum + (reservations[t as AtomType] ?? 0), 0,
  );
  const scaleFactor = rawReservationTotal > maxReservationBudget
    ? maxReservationBudget / rawReservationTotal
    : 1.0;
  const scaledReservations: Partial<Record<AtomType, number>> = {};
  for (const t of reservedTypes) {
    scaledReservations[t as AtomType] = Math.floor((reservations[t as AtomType] ?? 0) * scaleFactor);
  }

  // Fix 3: Compute high-relevance threshold. Atoms scoring above this bypass
  // reservation priority and compete purely by score in Pass 2.
  // Threshold = 70th percentile of non-zero scores (top 30% are "high relevance").
  let highRelevanceThreshold = Infinity;
  if (finalScoreMap.size > 0) {
    const scores = [...finalScoreMap.values()].filter(s => s > 0).sort((a, b) => a - b);
    if (scores.length > 0) {
      const p70Index = Math.floor(scores.length * 0.7);
      highRelevanceThreshold = scores[Math.min(p70Index, scores.length - 1)];
    }
  }

  // Pass 1: fill reserved slots per type, but let high-scoring atoms bypass
  const reserved: Atom[] = [];
  const unreserved: Atom[] = [];
  const reservedUsed: Partial<Record<AtomType, number>> = {};

  for (const atom of atoms) {
    const id = atom.frontmatter.id;
    const score = finalScoreMap.get(id) ?? 0;

    // Fix 3: High-relevance atoms go straight to unreserved pool regardless of type
    if (score >= highRelevanceThreshold && highRelevanceThreshold < Infinity) {
      unreserved.push(atom);
      continue;
    }

    const quota = scaledReservations[atom.frontmatter.type];
    if (quota !== undefined && quota > 0) {
      const used = reservedUsed[atom.frontmatter.type] ?? 0;
      const tokens = estimateTokens(atom.body + JSON.stringify(atom.frontmatter));
      if (used + tokens <= quota) {
        reserved.push(atom);
        reservedUsed[atom.frontmatter.type] = used + tokens;
        continue;
      }
    }
    unreserved.push(atom);
  }

  const reservedTokens = reserved.reduce(
    (sum, a) => sum + estimateTokens(a.body + JSON.stringify(a.frontmatter)),
    0,
  );
  const remainingBudget = Math.max(0, maxTokens - reservedTokens);

  // Pass 2: sort unreserved by score, fill remaining budget
  unreserved.sort((a, b) =>
    (finalScoreMap.get(b.frontmatter.id) ?? 0) - (finalScoreMap.get(a.frontmatter.id) ?? 0),
  );
  const fromUnreserved = greedyFill(unreserved, remainingBudget);

  // Merge and re-sort by score for output ordering
  const merged = [...reserved, ...fromUnreserved];
  merged.sort((a, b) =>
    (finalScoreMap.get(b.frontmatter.id) ?? 0) - (finalScoreMap.get(a.frontmatter.id) ?? 0),
  );
  return merged;
}

function greedyFill(atoms: Atom[], maxTokens: number): Atom[] {
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
 * Single-hop graph-walk spreading activation (Phase 3).
 *
 * For each edge (source, target): boost the neighbor by source_score * boost_factor.
 * The boost is undirected — high-scoring targets also lift their sources.
 * Diminishing returns formula prevents runaway amplification in dense subgraphs:
 *   accumulated_boost += score * boost * (1 / (1 + accumulated_boost))
 */
function applyGraphBoost(
  scoreMap: Map<string, number>,
  relations: { source_id: string; target_id: string }[],
  boost: number,
): void {
  if (boost === 0) return;
  const boostAccumulator = new Map<string, number>();

  for (const rel of relations) {
    const sourceScore = scoreMap.get(rel.source_id);
    const targetScore = scoreMap.get(rel.target_id);

    // Boost target from source
    if (sourceScore !== undefined && sourceScore > 0) {
      const current = boostAccumulator.get(rel.target_id) ?? 0;
      boostAccumulator.set(rel.target_id, current + sourceScore * boost * (1 / (1 + current)));
    }

    // Boost source from target (undirected walk)
    if (targetScore !== undefined && targetScore > 0) {
      const current = boostAccumulator.get(rel.source_id) ?? 0;
      boostAccumulator.set(rel.source_id, current + targetScore * boost * (1 / (1 + current)));
    }
  }

  for (const [atomId, addedBoost] of boostAccumulator) {
    scoreMap.set(atomId, (scoreMap.get(atomId) ?? 0) + addedBoost);
  }
}

/**
 * Rough token estimate (4 chars per token).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
