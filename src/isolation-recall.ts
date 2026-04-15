/**
 * Isolated recall: union of agent store + shared namespace.
 *
 * Calls recall() twice (once for the agent's store, once for shared),
 * merges the results with agent-wins-on-collision dedup, and re-applies
 * the token budget. Core recall.ts is untouched.
 */

import fs from 'fs';
import { recall } from './recall.js';
import { getSharedDir } from './isolation.js';
import { listAtomFiles } from './store.js';
import type { Atom, ContextBundle, RecallQuery } from './types.js';

/**
 * Estimate tokens for an atom (rough: 1 token ≈ 4 chars).
 */
function estimateTokens(atom: Atom): number {
  const bodyLen = atom.body.length;
  const fmLen = JSON.stringify(atom.frontmatter).length;
  return Math.ceil((bodyLen + fmLen) / 4);
}

/**
 * Recall in isolated mode: searches the agent's store + shared namespace.
 *
 * @param agentDir - Resolved agent memory directory
 * @param baseDir - Root memory directory (for locating shared/)
 * @param query - Recall query (same as regular recall)
 * @returns Merged ContextBundle with agent atoms taking priority
 */
export function recallIsolated(
  agentDir: string,
  baseDir: string,
  query: RecallQuery = {},
): ContextBundle {
  // Strip max_tokens from sub-queries so each recall() returns all matching atoms.
  // The token budget is applied once at the merge step below to ensure shared atoms
  // aren't starved when agent atoms alone would fill the budget.
  const unboundedQuery = { ...query, max_tokens: undefined };

  // Primary: agent's own store
  const agentBundle = recall(agentDir, unboundedQuery);

  // Secondary: shared namespace (if it exists and has atoms)
  const sharedDir = getSharedDir(baseDir);
  let sharedBundle: ContextBundle | null = null;

  if (fs.existsSync(sharedDir)) {
    try {
      const sharedAtomFiles = listAtomFiles(sharedDir);
      if (sharedAtomFiles.length > 0) {
        sharedBundle = recall(sharedDir, unboundedQuery);
      }
    } catch {
      // Shared store not initialized or corrupted — skip silently
    }
  }

  // Merge: agent atoms win on ID collision
  const mergedAtoms: Atom[] = [...agentBundle.atoms];

  if (sharedBundle && sharedBundle.atoms.length > 0) {
    const agentIds = new Set(agentBundle.atoms.map((a) => a.frontmatter.id));
    for (const atom of sharedBundle.atoms) {
      if (!agentIds.has(atom.frontmatter.id)) {
        mergedAtoms.push(atom);
      }
    }
  }

  // Apply token budget on merged set (single budget application point)
  const maxTokens = query.max_tokens ?? 8000;
  let tokenCount = 0;
  const budgetedAtoms: Atom[] = [];

  for (const atom of mergedAtoms) {
    const est = estimateTokens(atom);
    if (tokenCount + est > maxTokens && budgetedAtoms.length > 0) break;
    budgetedAtoms.push(atom);
    tokenCount += est;
  }

  // Merge episodes with dedup by episode ID (agent wins on collision)
  const agentEpisodes = agentBundle.episodes ?? [];
  const sharedEpisodes = sharedBundle?.episodes ?? [];
  const episodeIds = new Set(agentEpisodes.map((e) => e.id));
  const episodes = [
    ...agentEpisodes,
    ...sharedEpisodes.filter((e) => !episodeIds.has(e.id)),
  ];

  // Use agent's views (primary), not shared's
  return {
    index: agentBundle.index,
    handoff: agentBundle.handoff,
    constraints: agentBundle.constraints,
    atoms: budgetedAtoms,
    episodes: episodes.length > 0 ? episodes : undefined,
    token_estimate: tokenCount,
  };
}
