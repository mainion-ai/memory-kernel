/**
 * Graph-walk spreading-activation scoring.
 *
 * Pure ranking primitive extracted from recall.ts so it can be unit-tested in
 * isolation. Mutates the passed score map in place. Internal to the recall
 * pipeline (not part of the public barrel).
 */

/**
 * Single-hop graph-walk spreading activation (Phase 3).
 *
 * For each edge (source, target): boost the neighbor by source_score * boost_factor.
 * The boost is undirected — high-scoring targets also lift their sources.
 * Diminishing returns formula prevents runaway amplification in dense subgraphs:
 *   accumulated_boost += score * boost * (1 / (1 + accumulated_boost))
 */
export function applyGraphBoost(
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
