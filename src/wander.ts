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

import { openIndex, indexExists } from './index-db.js';
import { listAtoms } from './store.js';

// --- Types ---

/** Graph node: one atom with its tags, type, precomputed base activation, and explicit relation neighbors. */
interface GraphNode {
  tags: string[];
  type: string;
  updated_at: string;
  base_activation: number;
  neighbors: Set<string>;
}

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
  /** Weight for activation flow through explicit relations (default: 0.5) */
  relationWeight?: number;
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
 * Compute base-level activation for an atom using ACT-R-inspired
 * recency weighting. More recently updated atoms get higher activation.
 *
 * B_i = ln(1 / age_days)  (clamped to avoid -Infinity)
 *
 * Age is measured in days since last update. Minimum age = 0.01 days (~14 min)
 * to avoid ln(Infinity).
 */
function baseLevelActivation(updatedAt: string, now: number): number {
  const updatedMs = new Date(updatedAt).getTime();
  if (Number.isNaN(updatedMs)) return 0;
  const ageDays = Math.max((now - updatedMs) / (1000 * 60 * 60 * 24), 0.01);
  return Math.log(1 / ageDays);
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
function loadAtomGraph(memoryDir: string, now: number): Map<string, GraphNode> {
  const db = openIndex(memoryDir);

  const ATOM_FILTER = `
    a.status NOT IN ('archived', 'expired')
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
      SELECT r.source_id, r.target_id
      FROM atom_relations r
      INNER JOIN atoms s ON r.source_id = s.atom_id
      INNER JOIN atoms t ON r.target_id = t.atom_id
      WHERE ${ATOM_FILTER.replace(/\ba\./g, 's.')}
        AND ${ATOM_FILTER.replace(/\ba\./g, 't.')}
    `).all() as { source_id: string; target_id: string }[];

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

  const graph = new Map<string, GraphNode>();
  for (const atom of atoms) {
    graph.set(atom.atom_id, {
      tags: [...new Set(tagsByAtom.get(atom.atom_id) ?? [])],
      type: atom.type,
      updated_at: atom.updated_at,
      base_activation: baseLevelActivation(atom.updated_at, now),
      neighbors: new Set(),
    });
  }

  // Populate relation neighbors (bidirectional)
  for (const rel of relationRows) {
    const sourceNode = graph.get(rel.source_id);
    const targetNode = graph.get(rel.target_id);
    if (sourceNode && targetNode) {
      sourceNode.neighbors.add(rel.target_id);
      targetNode.neighbors.add(rel.source_id);
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

  while (depth < maxDepth && frontier.size > 0) {
    depth++;
    const nextFrontier = new Set<string>();

    for (const currentAtom of frontier) {
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
          }
        }
      }
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

          // Modulate by base-level activation (recency boost)
          // Normalize to 0-1 range with sigmoid
          const baseBoost = 1 / (1 + Math.exp(-neighborData.base_activation));
          const incoming = spreadPerNeighbor * baseBoost;

          newActivation.set(
            neighborId,
            (newActivation.get(neighborId) ?? 0) + incoming,
          );
        }
      }
    }

    // Spread through explicit relation neighbors
    const relationWeight = options.relationWeight ?? 0.5;
    if (relationWeight > 0) {
      for (const [atomId, act] of activation) {
        const atomData = graph.get(atomId);
        if (!atomData || atomData.neighbors.size === 0) continue;

        const spreadPerNeighbor = (act * decay * relationWeight) / atomData.neighbors.size;

        for (const neighborId of atomData.neighbors) {
          if (neighborId === atomId) continue;
          const neighborData = graph.get(neighborId);
          if (!neighborData) continue;

          const baseBoost = 1 / (1 + Math.exp(-neighborData.base_activation));
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
  const graph = loadAtomGraph(memoryDir, now);

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

  const atoms = listAtoms(memoryDir);
  if (atoms.length === 0) {
    return {
      collisions: [],
      activated: [],
      steps_taken: 0,
      duration_ms: Date.now() - start,
      seeds_used: [],
    };
  }

  const now = Date.now();
  const graph = new Map<string, GraphNode>();

  for (const atom of atoms) {
    const fm = atom.frontmatter;
    if (!fm.id) continue;
    if (fm.status === 'archived' || fm.status === 'expired') continue;
    if (fm.type === 'conflict') continue;
    if (fm.classification === 'SECRET' || fm.classification === 'PERSONAL') continue;

    graph.set(fm.id, {
      tags: [...new Set(fm.scope?.tags ?? [])],
      type: fm.type,
      updated_at: fm.updated_at,
      base_activation: baseLevelActivation(fm.updated_at, now),
      neighbors: new Set(),
    });
  }

  // Populate relation neighbors from frontmatter (bidirectional)
  for (const atom of atoms) {
    const fm = atom.frontmatter;
    if (!fm.id || !fm.relations) continue;
    const sourceNode = graph.get(fm.id);
    if (!sourceNode) continue;
    for (const rel of fm.relations) {
      const targetNode = graph.get(rel.target);
      if (!targetNode) continue;
      sourceNode.neighbors.add(rel.target);
      targetNode.neighbors.add(fm.id);
    }
  }

  return wanderWithGraph(graph, options, start);
}
