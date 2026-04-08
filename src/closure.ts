/**
 * closure.ts — Operational closure metrics for memory stores
 *
 * Computes how self-referential a memory store is, which predicts:
 * - Automation resistance (how well external tools can classify/process the store)
 * - Transplant resistance (how compatible atoms are with other agents' stores)
 *
 * Based on Luhmann's operational closure: a system that responds based on
 * internal structure rather than external input.
 *
 * The closure index combines two components:
 * - Type composition: what fraction of atoms are beliefs (self-referential by nature)
 * - Entanglement: how many cross-references exist per atom (graph density)
 *
 * @module
 */

import fs from 'fs';
import path from 'path';
import { listAtoms } from './index.js';
import { getAllRelations, indexExists } from './index-db.js';

/** Result of a closure analysis */
export interface ClosureResult {
  /** Total atoms in the store */
  atom_count: number;
  /** Number of belief atoms */
  belief_count: number;
  /** Belief atoms as percentage of total (0-100) */
  belief_pct: number;
  /** Average explicit relations per atom (from index) */
  avg_relations: number;
  /** Average body-text references per belief (concept-name refs) */
  avg_body_refs: number;
  /** Combined closure index: belief_pct * (avg_relations + avg_body_refs) / 100 */
  closure_index: number;
  /** Entanglement ratio: avg_body_refs / (atom_count - 1), as pct of theoretical max */
  entanglement_pct: number;
  /** Which component is currently driving closure growth */
  phase: 'type-composition' | 'entanglement' | 'early';
  /** Type distribution */
  by_type: Record<string, number>;
  /** Relation type distribution */
  relation_types: Record<string, number>;
  /** Daily trajectory (if events available) */
  trajectory: TrajectoryPoint[];
  /** Tooling predictions based on closure level */
  predictions: ToolPrediction[];
}

export interface TrajectoryPoint {
  date: string;
  atoms: number;
  beliefs: number;
  belief_pct: number;
  avg_relations: number;
  avg_body_refs: number;
  closure_index: number;
}

export interface ToolPrediction {
  tool: string;
  status: 'reliable' | 'degraded' | 'untested';
  detail: string;
}

/** Regex to match atom ID references in body text */
const ATOM_REF_PATTERN = /\b(BELI|FACT|DECI|OPEN|PREF|PROC|IMPU|EPIS)-\d{4}-\d{2}-\d{2}[A-Za-z0-9-]*/g;

/**
 * Compute operational closure metrics for a memory store.
 *
 * @param memoryDir - Path to the memory directory
 * @param options - Optional: include trajectory, limit trajectory days
 * @returns ClosureResult with all metrics
 */
export function closure(
  memoryDir: string,
  options?: { trajectory?: boolean; trajectoryDays?: number },
): ClosureResult {
  const includeTrajectory = options?.trajectory ?? false;

  const atoms = listAtoms(memoryDir);
  const atomCount = atoms.length;

  if (atomCount === 0) {
    return {
      atom_count: 0,
      belief_count: 0,
      belief_pct: 0,
      avg_relations: 0,
      avg_body_refs: 0,
      closure_index: 0,
      entanglement_pct: 0,
      phase: 'early',
      by_type: {},
      relation_types: {},
      trajectory: [],
      predictions: makePredictions(0),
    };
  }

  // Type distribution
  const byType: Record<string, number> = {};
  for (const atom of atoms) {
    const t = atom.frontmatter.type;
    byType[t] = (byType[t] ?? 0) + 1;
  }
  const beliefCount = byType['belief'] ?? 0;
  const beliefPct = (beliefCount / atomCount) * 100;

  // Relations from index
  let relations: { source_id: string; target_id: string; relation_type: string }[] = [];
  const relationTypes: Record<string, number> = {};
  if (indexExists(memoryDir)) {
    relations = getAllRelations(memoryDir);
    for (const r of relations) {
      relationTypes[r.relation_type] = (relationTypes[r.relation_type] ?? 0) + 1;
    }
  }
  const avgRelations = atomCount > 0 ? relations.length / atomCount : 0;

  // Body-text references (read atom files, count cross-references)
  const entitiesDir = path.join(memoryDir, 'ENTITIES');
  let totalBodyRefs = 0;
  let beliefsWithBody = 0;

  if (fs.existsSync(entitiesDir)) {
    for (const atom of atoms) {
      if (atom.frontmatter.type !== 'belief') continue;
      const filePath = path.join(entitiesDir, `${atom.frontmatter.id}.md`);
      if (!fs.existsSync(filePath)) continue;

      const content = fs.readFileSync(filePath, 'utf8');
      // Split off frontmatter
      const parts = content.split('---');
      const body = parts.length >= 3 ? parts.slice(2).join('---') : '';

      // Count unique atom ID references in body
      const refs = new Set(body.match(ATOM_REF_PATTERN) ?? []);
      // Remove self-references
      refs.delete(atom.frontmatter.id);
      totalBodyRefs += refs.size;
      beliefsWithBody++;
    }
  }
  const avgBodyRefs = beliefsWithBody > 0 ? totalBodyRefs / beliefsWithBody : 0;

  // Closure index
  const closureIndex = beliefPct * (avgRelations + avgBodyRefs) / 100;

  // Entanglement as pct of theoretical max
  const maxRefs = Math.max(atomCount - 1, 1);
  const entanglementPct = (avgBodyRefs / maxRefs) * 100;

  // Phase detection: if belief% grew more than entanglement recently, we're in phase 1
  const phase: ClosureResult['phase'] =
    atomCount < 20 ? 'early' :
    beliefPct < 60 ? 'type-composition' :
    'entanglement';

  // Trajectory (optional, computed from atom creation dates)
  const trajectory: TrajectoryPoint[] = [];
  if (includeTrajectory) {
    const days = options?.trajectoryDays;
    buildTrajectory(atoms, entitiesDir, relations, trajectory, days);
  }

  return {
    atom_count: atomCount,
    belief_count: beliefCount,
    belief_pct: round2(beliefPct),
    avg_relations: round2(avgRelations),
    avg_body_refs: round2(avgBodyRefs),
    closure_index: round2(closureIndex),
    entanglement_pct: round2(entanglementPct),
    phase,
    by_type: byType,
    relation_types: relationTypes,
    trajectory,
    predictions: makePredictions(closureIndex),
  };
}

/** Build daily trajectory from atom creation dates */
function buildTrajectory(
  atoms: ReturnType<typeof listAtoms>,
  entitiesDir: string,
  relations: { source_id: string; target_id: string }[],
  trajectory: TrajectoryPoint[],
  limitDays?: number,
): void {
  // Sort atoms by creation date
  const sorted = [...atoms].sort((a, b) =>
    a.frontmatter.created_at.localeCompare(b.frontmatter.created_at),
  );

  // Build per-atom body ref counts
  const bodyRefCounts = new Map<string, number>();
  if (fs.existsSync(entitiesDir)) {
    for (const atom of sorted) {
      if (atom.frontmatter.type !== 'belief') continue;
      const filePath = path.join(entitiesDir, `${atom.frontmatter.id}.md`);
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      const parts = content.split('---');
      const body = parts.length >= 3 ? parts.slice(2).join('---') : '';
      const refs = new Set(body.match(ATOM_REF_PATTERN) ?? []);
      refs.delete(atom.frontmatter.id);
      bodyRefCounts.set(atom.frontmatter.id, refs.size);
    }
  }

  // Build relation count per day (cumulative)
  // Relations are tied to atoms — count relations for atoms created up to each day
  const atomCreationDates = new Map<string, string>();
  for (const a of sorted) {
    atomCreationDates.set(a.frontmatter.id, a.frontmatter.created_at.split('T')[0]);
  }

  // Group by day
  const dayMap = new Map<string, typeof sorted>();
  for (const a of sorted) {
    const day = a.frontmatter.created_at.split('T')[0];
    if (!dayMap.has(day)) dayMap.set(day, []);
    dayMap.get(day)!.push(a);
  }

  const days = [...dayMap.keys()].sort();
  const startIdx = limitDays ? Math.max(0, days.length - limitDays) : 0;

  let cumAtoms = 0;
  let cumBeliefs = 0;
  let cumBodyRefs = 0;
  const atomsSoFar = new Set<string>();

  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    for (const a of dayMap.get(day)!) {
      cumAtoms++;
      atomsSoFar.add(a.frontmatter.id);
      if (a.frontmatter.type === 'belief') {
        cumBeliefs++;
        cumBodyRefs += bodyRefCounts.get(a.frontmatter.id) ?? 0;
      }
    }

    if (i < startIdx) continue;

    // Count relations between atoms that exist by this day
    const cumRels = relations.filter(
      r => atomsSoFar.has(r.source_id) && atomsSoFar.has(r.target_id),
    ).length;

    const bp = cumAtoms > 0 ? (cumBeliefs / cumAtoms) * 100 : 0;
    const ar = cumAtoms > 0 ? cumRels / cumAtoms : 0;
    const abr = cumBeliefs > 0 ? cumBodyRefs / cumBeliefs : 0;
    const ci = bp * (ar + abr) / 100;

    trajectory.push({
      date: day,
      atoms: cumAtoms,
      beliefs: cumBeliefs,
      belief_pct: round2(bp),
      avg_relations: round2(ar),
      avg_body_refs: round2(abr),
      closure_index: round2(ci),
    });
  }
}

/** Generate tooling predictions based on closure index */
function makePredictions(closureIndex: number): ToolPrediction[] {
  const predictions: ToolPrediction[] = [];

  predictions.push({
    tool: 'Graph-structural metrics',
    status: 'reliable',
    detail: 'Degree, betweenness, connectivity — work at any closure level',
  });

  if (closureIndex < 3) {
    predictions.push({
      tool: 'LLM classification (small models)',
      status: 'reliable',
      detail: 'Low self-referential density — classifiers unaffected',
    });
  } else if (closureIndex < 8) {
    predictions.push({
      tool: 'LLM classification (small models)',
      status: 'degraded',
      detail: `Closure ${closureIndex.toFixed(1)} — self-describing body text confounds classifiers (~55% accuracy observed at 5.0)`,
    });
  } else {
    predictions.push({
      tool: 'LLM classification (small models)',
      status: 'degraded',
      detail: `Closure ${closureIndex.toFixed(1)} — high self-reference density, expect <50% accuracy without preprocessing`,
    });
  }

  if (closureIndex < 2) {
    predictions.push({
      tool: 'Cross-agent transplant',
      status: 'reliable',
      detail: 'Low entanglement — most atoms are portable',
    });
  } else if (closureIndex < 5) {
    predictions.push({
      tool: 'Cross-agent transplant',
      status: 'degraded',
      detail: 'Growing entanglement — beliefs require context, facts still portable',
    });
  } else {
    predictions.push({
      tool: 'Cross-agent transplant',
      status: 'degraded',
      detail: `Closure ${closureIndex.toFixed(1)} — 87%+ of beliefs predicted to fail direct transplant. Use indirect processing pathway.`,
    });
  }

  return predictions;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
