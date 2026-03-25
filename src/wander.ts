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

import type Database from 'better-sqlite3';
import { openIndex, indexExists } from './index-db.js';
import { listAtoms } from './store.js';
import type { Atom } from './types.js';

// --- Types ---

export interface WanderOptions {
  /** Memory directory */
  memoryDir: string;
  /** Seed atom IDs to start activation from */
  seeds?: string[];
  /** Seed tags (alternative to atom IDs) */
  seedTags?: string[];
  /** Number of spreading steps (default: 3) */
  steps?: number;
  /** Minimum activation to keep a node alive (default: 0.05) */
  threshold?: number;
  /** Max atoms to keep active per step — lateral inhibition (default: 20) */
  topK?: number;
  /** Decay factor for spreading (0-1, default: 0.5) */
  decay?: number;
  /** Number of collision candidates to return (default: 5) */
  maxCollisions?: number;
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
  /** Tags shared between the two atoms */
  shared_tags: string[];
  /** Combined activation score */
  score: number;
  /** Type of atom A */
  type_a: string;
  /** Type of atom B */
  type_b: string;
  /** Minimum hops between the two atoms in the tag graph */
  distance: number;
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
  const ageDays = Math.max((now - updatedMs) / (1000 * 60 * 60 * 24), 0.01);
  return Math.log(1 / ageDays);
}

// --- Core engine ---

/**
 * Build the tag co-occurrence graph from the SQLite index.
 * Returns a map: atom_id -> { tags, type, updated_at, base_activation }
 */
function loadAtomGraph(db: Database.Database, now: number): Map<string, {
  tags: string[];
  type: string;
  updated_at: string;
  base_activation: number;
}> {
  const atoms = db.prepare(`
    SELECT a.atom_id, a.type, a.updated_at
    FROM atoms a
    WHERE a.status NOT IN ('archived', 'expired')
      AND (a.classification IS NULL OR a.classification NOT IN ('SECRET', 'PERSONAL'))
  `).all() as { atom_id: string; type: string; updated_at: string }[];

  const tagRows = db.prepare(`
    SELECT atom_id, tag FROM atom_tags
  `).all() as { atom_id: string; tag: string }[];

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

  const graph = new Map<string, {
    tags: string[];
    type: string;
    updated_at: string;
    base_activation: number;
  }>();

  for (const atom of atoms) {
    graph.set(atom.atom_id, {
      tags: tagsByAtom.get(atom.atom_id) ?? [],
      type: atom.type,
      updated_at: atom.updated_at,
      base_activation: baseLevelActivation(atom.updated_at, now),
    });
  }

  return graph;
}

/**
 * Build a reverse index: tag -> set of atom_ids
 */
function buildTagIndex(graph: Map<string, { tags: string[] }>): Map<string, Set<string>> {
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
  graph: Map<string, { base_activation: number }>,
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
 * Uses BFS through the tag co-occurrence graph. Returns Infinity if unreachable.
 */
function tagDistance(
  atomA: string,
  atomB: string,
  graph: Map<string, { tags: string[] }>,
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

  return Infinity;
}

/**
 * Spreading activation — the core algorithm.
 *
 * 1. Initialize activation for seed atoms
 * 2. For each step:
 *    a. For each active atom, spread activation through shared tags
 *    b. Modulate by base-level activation (recency)
 *    c. Apply lateral inhibition (keep top-K)
 *    d. Prune below threshold
 * 3. Detect collisions — activated atom pairs from different types
 *    with high combined activation but large tag-graph distance
 */
export function wander(options: WanderOptions): WanderResult {
  const {
    memoryDir,
    seeds: seedIds,
    seedTags,
    steps = 3,
    threshold = 0.05,
    topK = 20,
    decay = 0.5,
    maxCollisions = 5,
  } = options;

  const start = Date.now();

  // Require index
  if (!indexExists(memoryDir)) {
    return {
      collisions: [],
      activated: [],
      steps_taken: 0,
      duration_ms: Date.now() - start,
      seeds_used: [],
    };
  }

  const db = openIndex(memoryDir);
  const now = Date.now();
  const graph = loadAtomGraph(db, now);
  const tagIndex = buildTagIndex(graph);

  // Resolve seeds
  let seeds: string[] = [];

  if (seedIds && seedIds.length > 0) {
    // Use provided atom IDs (filter to existing)
    seeds = seedIds.filter((id) => graph.has(id));
  }

  if (seedTags && seedTags.length > 0) {
    // Add atoms matching seed tags
    const tagSeeds = resolveTagSeeds(seedTags, tagIndex);
    seeds = [...new Set([...seeds, ...tagSeeds])];
  }

  if (seeds.length === 0) {
    // Auto-seed from most recent atoms
    seeds = autoSeeds(graph, 3);
  }

  if (seeds.length === 0) {
    return {
      collisions: [],
      activated: [],
      steps_taken: 0,
      duration_ms: Date.now() - start,
      seeds_used: [],
    };
  }

  // Initialize activation map
  const activation = new Map<string, number>();
  for (const seed of seeds) {
    activation.set(seed, 1.0);
  }

  // Spreading steps
  let stepsTaken = 0;
  for (let step = 0; step < steps; step++) {
    stepsTaken++;
    const newActivation = new Map<string, number>();

    // Copy existing activation (with decay)
    for (const [atomId, act] of activation) {
      newActivation.set(atomId, act * (1 - decay * 0.5)); // Slight self-decay
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
        // Divide spread among all neighbors of this tag
        const spreadPerNeighbor = spreadPerTag / neighborCount;

        for (const neighborId of neighbors) {
          if (neighborId === atomId) continue;

          const neighborData = graph.get(neighborId);
          if (!neighborData) continue;

          // Modulate by base-level activation (recency boost)
          // Normalize base_activation to 0-1 range with sigmoid
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

  // Detect collisions — pairs of activated atoms from different types
  // Score = combined_activation * distance (higher distance = more surprising)
  const collisions: Collision[] = [];
  const activatedIds = activated.map((a) => a.atom_id);

  for (let i = 0; i < activatedIds.length; i++) {
    for (let j = i + 1; j < activatedIds.length; j++) {
      const idA = activatedIds[i];
      const idB = activatedIds[j];
      const dataA = graph.get(idA)!;
      const dataB = graph.get(idB)!;

      // Skip same-type pairs (less interesting)
      if (dataA.type === dataB.type) continue;

      // Find shared tags
      const tagsA = new Set(dataA.tags);
      const sharedTags = dataB.tags.filter((t) => tagsA.has(t));

      // Skip if no shared tags (no structural overlap)
      if (sharedTags.length === 0) continue;

      // Compute distance
      const dist = tagDistance(idA, idB, graph, tagIndex);

      // Score: activation product * distance bonus
      // Higher distance = more surprising collision
      const actA = activation.get(idA) ?? 0;
      const actB = activation.get(idB) ?? 0;
      const distanceBonus = Math.max(dist, 1);
      const score = actA * actB * distanceBonus;

      collisions.push({
        atom_a: idA,
        atom_b: idB,
        shared_tags: sharedTags,
        score: Math.round(score * 1000) / 1000,
        type_a: dataA.type,
        type_b: dataB.type,
        distance: dist,
      });
    }
  }

  // Sort by score descending, take top N
  collisions.sort((a, b) => b.score - a.score);
  const topCollisions = collisions.slice(0, maxCollisions);

  return {
    collisions: topCollisions,
    activated,
    steps_taken: stepsTaken,
    duration_ms: Date.now() - start,
    seeds_used: seeds,
  };
}

/**
 * Convenience: wander from file-scan when no index exists.
 * Builds a temporary in-memory graph from atom files.
 * Slower but works without pre-built index.
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

  // Build in-memory graph from atoms
  const now = Date.now();
  const graph = new Map<string, {
    tags: string[];
    type: string;
    updated_at: string;
    base_activation: number;
  }>();

  for (const atom of atoms) {
    const fm = atom.frontmatter;
    if (fm.status === 'archived' || fm.status === 'expired') continue;
    if (fm.classification === 'SECRET' || fm.classification === 'PERSONAL') continue;

    graph.set(fm.id, {
      tags: fm.scope?.tags ?? [],
      type: fm.type,
      updated_at: fm.updated_at,
      base_activation: baseLevelActivation(fm.updated_at, now),
    });
  }

  // Delegate to the shared spreading logic
  return wanderWithGraph(graph, options, start);
}

/**
 * Internal: Run spreading activation on a pre-built graph.
 * Shared by both index-backed and file-backed paths.
 */
function wanderWithGraph(
  graph: Map<string, {
    tags: string[];
    type: string;
    updated_at: string;
    base_activation: number;
  }>,
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

    for (const [atomId, act] of activation) {
      newActivation.set(atomId, act * (1 - decay * 0.5));
    }

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

          const baseBoost = 1 / (1 + Math.exp(-neighborData.base_activation));
          const incoming = spreadPerNeighbor * baseBoost;

          newActivation.set(
            neighborId,
            (newActivation.get(neighborId) ?? 0) + incoming,
          );
        }
      }
    }

    const sorted = [...newActivation.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK);

    activation.clear();
    for (const [atomId, act] of sorted) {
      if (act >= threshold) {
        activation.set(atomId, act);
      }
    }

    if (activation.size === 0) break;
  }

  // Build result
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

  // Detect collisions
  const collisions: Collision[] = [];
  const activatedIds = activated.map((a) => a.atom_id);

  for (let i = 0; i < activatedIds.length; i++) {
    for (let j = i + 1; j < activatedIds.length; j++) {
      const idA = activatedIds[i];
      const idB = activatedIds[j];
      const dataA = graph.get(idA)!;
      const dataB = graph.get(idB)!;

      if (dataA.type === dataB.type) continue;

      const tagsA = new Set(dataA.tags);
      const sharedTags = dataB.tags.filter((t) => tagsA.has(t));
      if (sharedTags.length === 0) continue;

      const dist = tagDistance(idA, idB, graph, tagIndex);
      const actA = activation.get(idA) ?? 0;
      const actB = activation.get(idB) ?? 0;
      const distanceBonus = Math.max(dist, 1);
      const score = actA * actB * distanceBonus;

      collisions.push({
        atom_a: idA,
        atom_b: idB,
        shared_tags: sharedTags,
        score: Math.round(score * 1000) / 1000,
        type_a: dataA.type,
        type_b: dataB.type,
        distance: dist,
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
