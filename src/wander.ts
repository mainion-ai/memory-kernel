/**
 * Spreading activation for associative memory exploration.
 *
 * Tier 1 (cheap): Pure SQLite graph walk through tag co-occurrence
 * and shared references. ACT-R-inspired base-level activation with
 * recency/frequency decay. Lateral inhibition sharpens signal.
 *
 * Returns collision candidates — pairs of atoms from distant domains
 * that light up together through unexpected structural overlap.
 *
 * No LLM calls. Pure computation.
 *
 * Inspired by:
 * - ACT-R (Anderson & Lebiere 1998): base-level activation = ln(recency) + ln(frequency)
 * - Collins & Loftus (1975): spreading activation through semantic network
 * - Floop (nvandessel): Hebbian-strengthened behavior graphs
 */

import path from 'path';
import { openIndex, indexExists } from './index-db.js';
import { listAtoms, assertWithinDir } from './store.js';

// --- Types ---

/** Graph node: one atom with its tags, type, precomputed base activation, and explicit relation neighbors. */
interface GraphNode {
  tags: string[];
  type: string;
  updated_at: string;
  base_activation: number;
  /** Explicit relation neighbors: neighbor_id -> relation_type (strongest typed edge wins). */
  neighbors: Map<string, string>;
  /** Number of times this atom is cited by other atoms (concept-name + ID refs). */
  citation_count: number;
}

/** Default weights per relation type for spreading activation. */
export const DEFAULT_TYPE_WEIGHTS: Record<string, number> = {
  extends: 1.5, // Developmental chains — backbone of belief arcs
  supports: 0.7, // Evidential connections — real but secondary
  caused_by: 0.8, // Narrative/temporal arcs
  contradicts: 0.4, // Tensions — worth visiting but shouldn't dominate
  supersedes: 0.3, // Historical — don't amplify superseded version
  applied_to: 0.6, // Cross-domain application — moderate, valuable connections
  related: 0.3, // Residual/unclassified — keep visible at low priority
};

/**
 * Hard cap on BFS frontier expansion in {@link tagDistance}. Prevents a
 * single hub tag (shared by thousands of atoms) from pulling the entire
 * graph into one BFS step — see #102 (performance cliff at scale).
 * When the cap fires, distance results are conservative (some real
 * neighbors aren't visited at the deepest depth), and a one-shot stderr
 * warning is emitted per call. Internal tuning parameter; not exported.
 * @internal
 */
const BFS_FRONTIER_CAP = 500;

/** Weight presets for mode-specific walks. */
export const WEIGHT_PRESETS: Record<string, Record<string, number>> = {
  constitution: {
    extends: 1.5, supports: 0.7, contradicts: 0.3,
    caused_by: 0.5, supersedes: 0.2, applied_to: 0.6, related: 0.2,
  },
  tension: {
    extends: 0.5, supports: 0.3, contradicts: 2.0,
    caused_by: 0.3, supersedes: 0.5, applied_to: 0.3, related: 0.2,
  },
  narrative: {
    extends: 0.8, supports: 0.3, contradicts: 0.3,
    caused_by: 2.0, supersedes: 1.0, applied_to: 0.5, related: 0.2,
  },
};

export interface WanderOptions {
  /** Memory directory */
  memoryDir: string;
  /** Seed atom IDs to start activation from */
  seeds?: string[];
  /** Seed tags (alternative to atom IDs) */
  seedTags?: string[];
  /** Number of spreading steps (default: 3). When 0, seeds are initialized
   *  but no spreading or collision detection occurs. */
  steps?: number;
  /** Minimum activation to keep a node alive (default: 0.05) */
  threshold?: number;
  /** Max atoms to keep active per step — lateral inhibition (default: 20) */
  topK?: number;
  /** Decay factor for spreading (0-1, default: 0.5) */
  decay?: number;
  /** Number of collision candidates to return (default: 5) */
  maxCollisions?: number;
  /** Weight for activation flow through explicit relations (default: 2.0) */
  relationWeight?: number;
  /** Per-relation-type weights for spreading activation.
   *  Defaults to DEFAULT_TYPE_WEIGHTS. Set a preset name ('constitution',
   *  'tension', 'narrative') or provide a custom record. */
  typeWeights?: Record<string, number>;
  /** If set, shared namespace atoms participate in the graph (per-agent isolation). */
  sharedMemoryDir?: string;
  /** Root memory directory (used for path validation when sharedMemoryDir is set). */
  baseDir?: string;
}

export interface ActivatedAtom {
  atom_id: string;
  activation: number;
  type: string;
  tags: string[];
  updated_at: string;
}

export interface Collision {
  /** First atom in the collision */
  atom_a: string;
  /** Second atom in the collision */
  atom_b: string;
  /** Tags shared between the two atoms (may be empty for fully disjoint pairs) */
  shared_tags: string[];
  /** Combined activation score */
  score: number;
  /** Type of atom A */
  type_a: string;
  /** Type of atom B */
  type_b: string;
  /** Minimum hops between the two atoms in the tag graph (capped at maxDepth+1 if unreachable) */
  distance: number;
  /** Tag Jaccard dissimilarity (1 - |A∩B|/|A∪B|), range [0,1] */
  dissimilarity: number;
}

export interface WanderResult {
  /** Collision candidates — atoms from distant domains with unexpected overlap */
  collisions: Collision[];
  /** All activated atoms after spreading (sorted by activation, descending) */
  activated: ActivatedAtom[];
  /** Number of steps taken */
  steps_taken: number;
  /** Wall-clock time in milliseconds */
  duration_ms: number;
  /** Seed atoms used */
  seeds_used: string[];
}

// --- ACT-R base-level activation ---

/**
 * Compute base-level activation using ACT-R power-law decay with frequency.
 *
 *   B_i = ln(n · t^{-d})  =  ln(n) − d·ln(t)
 *
 * Where:
 *   n = citation count + 1 (minimum 1 so uncited atoms still have recency signal)
 *   t = age in days since last update (clamped to ≥0.01)
 *   d = 0.5 (ACT-R standard decay, vs the previous effective d=1.0)
 *
 * The frequency term ln(n) means a belief cited 28 times gets ln(28)≈3.3
 * boost over an uncited belief. This makes foundational beliefs outrank
 * recent-but-isolated ones — the correct behavior for constitution and drift.
 *
 * Reference: Anderson & Lebiere (1998), The Atomic Components of Thought.
 */
function baseLevelActivation(
  updatedAt: string,
  now: number,
  citationCount: number = 0,
): number {
  const updatedMs = new Date(updatedAt).getTime();
  if (Number.isNaN(updatedMs)) return 0;
  const ageDays = Math.max((now - updatedMs) / (1000 * 60 * 60 * 24), 0.01);
  const n = Math.max(citationCount + 1, 1);
  const d = 0.5; // ACT-R standard decay (was effectively 1.0 before)
  return Math.log(n) - d * Math.log(ageDays);
}

// --- Graph construction ---

/**
 * Build the tag co-occurrence graph from the SQLite index.
 * Only includes active, non-SECRET/PERSONAL, non-conflict atoms. Tags are
 * joined to the filtered atom set to avoid scanning archived/expired tags.
 *
 * Both queries run inside a single transaction to guarantee a consistent
 * snapshot (SQLite WAL mode can otherwise return different snapshots for
 * separate SELECTs).
 */
function loadAtomGraph(memoryDir: string, now: number, options?: Pick<WanderOptions, 'typeWeights'>): Map<string, GraphNode> {
  const db = openIndex(memoryDir);

  const ATOM_FILTER = `
    a.status NOT IN ('archived', 'expired', 'superseded')
    AND a.type != 'conflict'
    AND (a.classification IS NULL OR a.classification NOT IN ('SECRET', 'PERSONAL'))
  `;

  const { atoms, tagRows, relationRows } = db.transaction(() => {
    const atoms = db.prepare(`
      SELECT a.atom_id, a.type, a.updated_at
      FROM atoms a
      WHERE ${ATOM_FILTER}
    `).all() as { atom_id: string; type: string; updated_at: string }[];

    const tagRows = db.prepare(`
      SELECT t.atom_id, t.tag
      FROM atom_tags t
      INNER JOIN atoms a ON t.atom_id = a.atom_id
      WHERE ${ATOM_FILTER}
    `).all() as { atom_id: string; tag: string }[];

    const relationRows = db.prepare(`
      SELECT r.source_id, r.target_id, r.relation_type
      FROM atom_relations r
      INNER JOIN atoms s ON r.source_id = s.atom_id
      INNER JOIN atoms t ON r.target_id = t.atom_id
      WHERE ${ATOM_FILTER.replace(/\ba\./g, 's.')}
        AND ${ATOM_FILTER.replace(/\ba\./g, 't.')}
    `).all() as { source_id: string; target_id: string; relation_type: string }[];

    return { atoms, tagRows, relationRows };
  })();

  // Build tag lookup
  const tagsByAtom = new Map<string, string[]>();
  for (const row of tagRows) {
    const existing = tagsByAtom.get(row.atom_id);
    if (existing) {
      existing.push(row.tag);
    } else {
      tagsByAtom.set(row.atom_id, [row.tag]);
    }
  }

  // Load citation counts from atom_citations table (schema v6+).
  // Populated by `mk citations` / indexCitations(). Empty until first run.
  const citationCounts = new Map<string, number>();
  try {
    const citationRows = db.prepare(`
      SELECT target_id, SUM(count) as total
      FROM atom_citations
      GROUP BY target_id
    `).all() as { target_id: string; total: number }[];
    for (const row of citationRows) {
      citationCounts.set(row.target_id, row.total);
    }
  } catch {
    // Table empty or not yet populated — all counts stay 0
  }

  const graph = new Map<string, GraphNode>();
  for (const atom of atoms) {
    const citations = citationCounts.get(atom.atom_id) ?? 0;
    graph.set(atom.atom_id, {
      tags: [...new Set(tagsByAtom.get(atom.atom_id) ?? [])],
      type: atom.type,
      updated_at: atom.updated_at,
      base_activation: baseLevelActivation(atom.updated_at, now, citations),
      neighbors: new Map(),
      citation_count: citations,
    });
  }

  // Populate relation neighbors (bidirectional).
  // When multiple edges exist between the same pair, keep the one with the
  // highest type weight so typed edges dominate over 'related' fallbacks.
  const typeWeightLookup = options?.typeWeights ?? DEFAULT_TYPE_WEIGHTS;
  for (const rel of relationRows) {
    const sourceNode = graph.get(rel.source_id);
    const targetNode = graph.get(rel.target_id);
    if (sourceNode && targetNode) {
      const relType = rel.relation_type || 'related';
      const newWeight = typeWeightLookup[relType] ?? 0.3;

      const existingSourceType = sourceNode.neighbors.get(rel.target_id);
      if (!existingSourceType || newWeight > (typeWeightLookup[existingSourceType] ?? 0.3)) {
        sourceNode.neighbors.set(rel.target_id, relType);
      }

      const existingTargetType = targetNode.neighbors.get(rel.source_id);
      if (!existingTargetType || newWeight > (typeWeightLookup[existingTargetType] ?? 0.3)) {
        targetNode.neighbors.set(rel.source_id, relType);
      }
    }
  }

  return graph;
}

/**
 * Build a reverse index: tag -> set of atom_ids
 */
function buildTagIndex(graph: Map<string, GraphNode>): Map<string, Set<string>> {
  const tagIndex = new Map<string, Set<string>>();
  for (const [atomId, data] of graph) {
    for (const tag of data.tags) {
      const existing = tagIndex.get(tag);
      if (existing) {
        existing.add(atomId);
      } else {
        tagIndex.set(tag, new Set([atomId]));
      }
    }
  }
  return tagIndex;
}

/**
 * Resolve seed atom IDs from tags. Returns atom IDs that have any of the seed tags.
 */
function resolveTagSeeds(
  seedTags: string[],
  tagIndex: Map<string, Set<string>>,
): string[] {
  const seeds = new Set<string>();
  for (const tag of seedTags) {
    const atoms = tagIndex.get(tag);
    if (atoms) {
      for (const atomId of atoms) {
        seeds.add(atomId);
      }
    }
  }
  return [...seeds];
}

/**
 * Select top N seeds by recency when no explicit seeds provided.
 */
function autoSeeds(
  graph: Map<string, GraphNode>,
  n: number,
): string[] {
  return [...graph.entries()]
    .sort((a, b) => b[1].base_activation - a[1].base_activation)
    .slice(0, n)
    .map(([id]) => id);
}

/**
 * Compute the shortest tag-graph distance between two atoms.
 * Distance 0 = same atom. Distance 1 = share a tag directly.
 * Distance 2 = connected through one intermediate atom, etc.
 *
 * Uses BFS through the tag co-occurrence graph.
 * Returns maxDepth + 1 if unreachable (JSON-safe, avoids Infinity → null).
 */
function tagDistance(
  atomA: string,
  atomB: string,
  graph: Map<string, GraphNode>,
  tagIndex: Map<string, Set<string>>,
  maxDepth: number = 4,
): number {
  if (atomA === atomB) return 0;

  const visited = new Set<string>([atomA]);
  let frontier = new Set<string>([atomA]);
  let depth = 0;
  // One-shot warning per tagDistance call (not per BFS step) — avoids
  // spamming stderr in a multi-level BFS that repeatedly hits the cap.
  let warned = false;

  while (depth < maxDepth && frontier.size > 0) {
    depth++;
    const nextFrontier = new Set<string>();
    let capped = false;

    outer: for (const currentAtom of frontier) {
      const atomData = graph.get(currentAtom);
      if (!atomData) continue;

      for (const tag of atomData.tags) {
        const neighbors = tagIndex.get(tag);
        if (!neighbors) continue;

        for (const neighbor of neighbors) {
          if (neighbor === atomB) return depth;
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            nextFrontier.add(neighbor);
            // Hub-tag guard (#102): cap frontier expansion at 500 nodes
            // per step. Without this, a single tag shared by thousands
            // of atoms causes O(N) → O(N^2) blowup across BFS depths.
            if (nextFrontier.size >= BFS_FRONTIER_CAP) {
              capped = true;
              break outer;
            }
          }
        }
      }
    }

    if (capped && !warned) {
      warned = true;
      process.stderr.write(
        'mk: warning: BFS frontier capped at 500 nodes in tagDistance (hub-tag effect) — distance results may be conservative\n',
      );
    }

    frontier = nextFrontier;
  }

  // Unreachable within maxDepth — return sentinel (JSON-safe)
  return maxDepth + 1;
}

// --- Core algorithm ---

/**
 * Run spreading activation on a pre-built graph.
 *
 * Shared by both index-backed (wander) and file-backed (wanderFromFiles) paths.
 *
 * Algorithm:
 * 1. Initialize activation for seed atoms (1.0 each)
 * 2. For each step:
 *    a. Self-decay existing activation
 *    b. Spread activation through shared tags, modulated by base-level (recency)
 *    b2. Spread activation through explicit relation neighbors
 *    c. Lateral inhibition: keep top-K atoms
 *    d. Prune below threshold
 * 3. Detect collisions: activated atom pairs with high tag Jaccard
 *    dissimilarity (> 0.7), scored by activation_product * dissimilarity
 */
function wanderWithGraph(
  graph: Map<string, GraphNode>,
  options: WanderOptions,
  startTime: number,
): WanderResult {
  const {
    seeds: seedIds,
    seedTags,
    steps = 3,
    threshold = 0.05,
    topK = 20,
    decay = 0.5,
    maxCollisions = 5,
  } = options;

  const tagIndex = buildTagIndex(graph);

  // Resolve seeds
  let seeds: string[] = [];

  if (seedIds && seedIds.length > 0) {
    seeds = seedIds.filter((id) => graph.has(id));
    // Warn about unresolved seeds — silent fallback to autoSeeds is a testing trap
    const unresolved = seedIds.filter((id) => !graph.has(id));
    if (unresolved.length > 0) {
      console.error(`⚠ Seed(s) not found in graph: ${unresolved.join(', ')}`);
    }
  }

  if (seedTags && seedTags.length > 0) {
    const tagSeeds = resolveTagSeeds(seedTags, tagIndex);
    seeds = [...new Set([...seeds, ...tagSeeds])];
  }

  if (seeds.length === 0) {
    seeds = autoSeeds(graph, 3);
  }

  if (seeds.length === 0) {
    return {
      collisions: [],
      activated: [],
      steps_taken: 0,
      duration_ms: Date.now() - startTime,
      seeds_used: [],
    };
  }

  // Initialize activation
  const activation = new Map<string, number>();
  for (const seed of seeds) {
    activation.set(seed, 1.0);
  }

  // Spreading steps
  let stepsTaken = 0;
  for (let step = 0; step < steps; step++) {
    stepsTaken++;
    const newActivation = new Map<string, number>();

    // Self-decay existing activation
    for (const [atomId, act] of activation) {
      newActivation.set(atomId, act * (1 - decay * 0.5));
    }

    // Spread through tags
    for (const [atomId, act] of activation) {
      const atomData = graph.get(atomId);
      if (!atomData || atomData.tags.length === 0) continue;

      const spreadPerTag = (act * decay) / atomData.tags.length;

      for (const tag of atomData.tags) {
        const neighbors = tagIndex.get(tag);
        if (!neighbors) continue;

        const neighborCount = neighbors.size;
        const spreadPerNeighbor = spreadPerTag / neighborCount;

        for (const neighborId of neighbors) {
          if (neighborId === atomId) continue;

          const neighborData = graph.get(neighborId);
          if (!neighborData) continue;

          // Modulate by base-level activation (recency + frequency).
          // sqrt-sigmoid: 1/sqrt(1 + exp(-B_i)) — compresses to [0.707, 1.0].
          // Gentler than full sigmoid [0.5, 1.0], preserves activation of
          // important but infrequently-updated (old) hub atoms.
          const baseBoost = 1 / Math.sqrt(1 + Math.exp(-neighborData.base_activation));
          const incoming = spreadPerNeighbor * baseBoost;

          newActivation.set(
            neighborId,
            (newActivation.get(neighborId) ?? 0) + incoming,
          );
        }
      }
    }

    // Spread through explicit relation neighbors.
    // Default 2.0 = deliberate associations dominate accidental tag co-occurrence.
    // Empirically validated: at 2.0, hub beliefs activate full extends chains;
    // at 1.0, tag noise drowns out relation signal for sparse graphs.
    const relationWeight = options.relationWeight ?? 2.0;
    const typeWeights = options.typeWeights ?? DEFAULT_TYPE_WEIGHTS;
    if (relationWeight > 0) {
      for (const [atomId, act] of activation) {
        const atomData = graph.get(atomId);
        if (!atomData || atomData.neighbors.size === 0) continue;

        for (const [neighborId, relType] of atomData.neighbors) {
          if (neighborId === atomId) continue;
          const neighborData = graph.get(neighborId);
          if (!neighborData) continue;

          // Type-specific weight modulates within the global relationWeight.
          // extends (1.5) = strong developmental chains; related (0.3) = residual.
          const typeWeight = typeWeights[relType] ?? 0.3;
          const spreadPerNeighbor = (act * decay * relationWeight * typeWeight) / atomData.neighbors.size;

          // sqrt-sigmoid baseBoost — same as tag spreading above.
          const baseBoost = 1 / Math.sqrt(1 + Math.exp(-neighborData.base_activation));
          const incoming = spreadPerNeighbor * baseBoost;

          newActivation.set(
            neighborId,
            (newActivation.get(neighborId) ?? 0) + incoming,
          );
        }
      }
    }

    // Lateral inhibition — keep top K
    const sorted = [...newActivation.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK);

    activation.clear();
    for (const [atomId, act] of sorted) {
      if (act >= threshold) {
        activation.set(atomId, act);
      }
    }

    // Early exit if activation died out
    if (activation.size === 0) break;
  }

  // Build activated atoms list
  const activated: ActivatedAtom[] = [...activation.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([atomId, act]) => {
      const data = graph.get(atomId)!;
      return {
        atom_id: atomId,
        activation: Math.round(act * 1000) / 1000,
        type: data.type,
        tags: data.tags,
        updated_at: data.updated_at,
      };
    });

  // Detect collisions — pairs of activated atoms with high tag dissimilarity
  // Score = combined_activation * Jaccard dissimilarity (higher dissimilarity = more surprising)
  // Distance cache avoids redundant BFS walks (O(n^2) pairs with topK=20 → 190 lookups)
  const collisions: Collision[] = [];
  const activatedIds = activated.map((a) => a.atom_id);
  const distanceCache = new Map<string, number>();

  for (let i = 0; i < activatedIds.length; i++) {
    for (let j = i + 1; j < activatedIds.length; j++) {
      const idA = activatedIds[i];
      const idB = activatedIds[j];
      const dataA = graph.get(idA)!;
      const dataB = graph.get(idB)!;

      // Find shared tags and compute Jaccard dissimilarity
      const tagsA = new Set(dataA.tags);
      const sharedTags = dataB.tags.filter((t) => tagsA.has(t));
      const unionSize = new Set([...dataA.tags, ...dataB.tags]).size;

      // Skip if either atom has no tags (no data to judge)
      if (unionSize === 0) continue;

      const dissimilarity = 1 - sharedTags.length / unionSize;

      // Skip if tags are too similar (threshold: 0.7)
      if (dissimilarity <= 0.7) continue;

      // Compute distance (memoized — BFS is symmetric)
      const pairKey = idA < idB ? `${idA}\0${idB}` : `${idB}\0${idA}`;
      let dist = distanceCache.get(pairKey);
      if (dist === undefined) {
        dist = tagDistance(idA, idB, graph, tagIndex);
        distanceCache.set(pairKey, dist);
      }

      // Score: activation product * dissimilarity
      const actA = activation.get(idA) ?? 0;
      const actB = activation.get(idB) ?? 0;
      const score = actA * actB * dissimilarity;

      collisions.push({
        atom_a: idA,
        atom_b: idB,
        shared_tags: sharedTags,
        score: Math.round(score * 1000) / 1000,
        type_a: dataA.type,
        type_b: dataB.type,
        distance: dist,
        dissimilarity: Math.round(dissimilarity * 1000) / 1000,
      });
    }
  }

  collisions.sort((a, b) => b.score - a.score);

  return {
    collisions: collisions.slice(0, maxCollisions),
    activated,
    steps_taken: stepsTaken,
    duration_ms: Date.now() - startTime,
    seeds_used: seeds,
  };
}

// --- Public API ---

/**
 * Explore memory associations via spreading activation through the tag
 * co-occurrence graph. Returns collision candidates — atom pairs from
 * different domains with unexpected structural overlap.
 *
 * Requires a SQLite index (run `mk reindex` first). Returns empty result
 * if no index exists. For index-free operation, use {@link wanderFromFiles}.
 *
 * **Connection lifecycle:** This function uses the module-level SQLite
 * connection cache (via `openIndex`). The connection is reused across calls
 * and is NOT closed automatically. For long-running processes (MCP servers,
 * daemons), call `closeIndex(memoryDir)` or `closeAllIndexes()` when done
 * to release the database handle.
 *
 * @example
 * ```typescript
 * import { wander, closeIndex } from 'memory-kernel';
 *
 * const result = wander({
 *   memoryDir: './memory',
 *   seedTags: ['philosophy', 'accounting'],
 *   steps: 5,
 * });
 *
 * // In long-running processes, clean up when done:
 * closeIndex('./memory');
 * ```
 */
export function wander(options: WanderOptions): WanderResult {
  const { memoryDir } = options;
  const start = Date.now();

  if (!indexExists(memoryDir)) {
    return {
      collisions: [],
      activated: [],
      steps_taken: 0,
      duration_ms: Date.now() - start,
      seeds_used: [],
    };
  }

  const now = Date.now();
  const graph = loadAtomGraph(memoryDir, now, options);

  // Merge shared namespace graph if provided (validate path is within base directory)
  if (options.sharedMemoryDir) {
    // Shared dir must be within the base memory directory
    const resolvedShared = path.resolve(options.sharedMemoryDir);
    const resolvedMemory = path.resolve(memoryDir);
    // Use explicit baseDir when provided; fall back to parent-of-parent for agents/{id} layout
    const baseDir = options.baseDir
      ? path.resolve(options.baseDir)
      : path.dirname(path.dirname(resolvedMemory));
    assertWithinDir(baseDir, resolvedShared);
  }
  if (options.sharedMemoryDir && indexExists(options.sharedMemoryDir)) {
    const sharedGraph = loadAtomGraph(options.sharedMemoryDir, now, options);
    for (const [id, node] of sharedGraph) {
      if (!graph.has(id)) {
        graph.set(id, node);
      }
    }
  }

  return wanderWithGraph(graph, options, start);
}

/**
 * Convenience: wander from file-scan when no index exists.
 * Builds a temporary in-memory graph from atom files, including
 * relation neighbors from frontmatter.
 * Slower but works without pre-built index.
 *
 * No SQLite connection is opened — safe for any environment.
 */
export function wanderFromFiles(options: WanderOptions): WanderResult {
  const { memoryDir } = options;
  const start = Date.now();

  const now = Date.now();
  const graph = buildGraphFromFiles(memoryDir, now, options);

  // Merge shared namespace graph if provided (validate path is within base directory).
  // Mirrors the index-backed wander() path so isolated-mode agents see shared atoms
  // even when the SQLite index is absent.
  if (options.sharedMemoryDir) {
    const resolvedShared = path.resolve(options.sharedMemoryDir);
    const resolvedMemory = path.resolve(memoryDir);
    const baseDir = options.baseDir
      ? path.resolve(options.baseDir)
      : path.dirname(path.dirname(resolvedMemory));
    assertWithinDir(baseDir, resolvedShared);
    const sharedGraph = buildGraphFromFiles(options.sharedMemoryDir, now, options);
    for (const [id, node] of sharedGraph) {
      if (!graph.has(id)) {
        graph.set(id, node);
      }
    }
  }

  if (graph.size === 0) {
    return {
      collisions: [],
      activated: [],
      steps_taken: 0,
      duration_ms: Date.now() - start,
      seeds_used: [],
    };
  }

  return wanderWithGraph(graph, options, start);
}

/**
 * Build an in-memory graph from on-disk atom files for a single directory.
 * Shared by wanderFromFiles() for both the agent store and the shared namespace.
 */
function buildGraphFromFiles(
  dir: string,
  now: number,
  options: WanderOptions,
): Map<string, GraphNode> {
  const graph = new Map<string, GraphNode>();
  const atoms = listAtoms(dir);
  if (atoms.length === 0) return graph;

  for (const atom of atoms) {
    const fm = atom.frontmatter;
    if (!fm.id) continue;
    if (fm.status === 'archived' || fm.status === 'expired' || fm.status === 'superseded') continue;
    if (fm.type === 'conflict') continue;
    if (fm.classification === 'SECRET' || fm.classification === 'PERSONAL') continue;

    // NOTE: citation_count is always 0 in file-scan mode because citation
    // counts live in SQLite (atom_citations table). The ACT-R frequency
    // component (ln(n)) degrades to ln(1)=0 here. This is an acceptable
    // limitation — file-scan is the fallback path when no index exists.
    graph.set(fm.id, {
      tags: [...new Set(fm.scope?.tags ?? [])],
      type: fm.type,
      updated_at: fm.updated_at,
      base_activation: baseLevelActivation(fm.updated_at, now, 0),
      neighbors: new Map(),
      citation_count: 0,
    });
  }

  // Populate relation neighbors from frontmatter (bidirectional).
  // Keep strongest typed edge when multiple edges exist for same pair.
  const twLookup = options.typeWeights ?? DEFAULT_TYPE_WEIGHTS;
  for (const atom of atoms) {
    const fm = atom.frontmatter;
    if (!fm.id || !fm.relations) continue;
    const sourceNode = graph.get(fm.id);
    if (!sourceNode) continue;
    for (const rel of fm.relations) {
      const targetNode = graph.get(rel.target);
      if (!targetNode) continue;
      const relType = rel.type || 'related';
      const newWeight = twLookup[relType] ?? 0.3;

      const existingSrc = sourceNode.neighbors.get(rel.target);
      if (!existingSrc || newWeight > (twLookup[existingSrc] ?? 0.3)) {
        sourceNode.neighbors.set(rel.target, relType);
      }
      const existingTgt = targetNode.neighbors.get(fm.id);
      if (!existingTgt || newWeight > (twLookup[existingTgt] ?? 0.3)) {
        targetNode.neighbors.set(fm.id, relType);
      }
    }
  }

  return graph;
}
