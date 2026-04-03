/**
 * Relink — extract atom cross-references from body text and create relations.
 *
 * Two modes:
 * 1. Batch: `relinkAll()` scans all atoms and proposes/applies new relations
 * 2. Single: `relinkAtom()` extracts references from one atom (used at remember-time)
 *
 * Extracted from the migrate-relations algorithm with a cleaner API
 * and no legacy `links.related` handling.
 */

import {
  listAtoms,
  writeAtom,
  indexExists,
  indexAtom,
} from './index.js';
import type { Atom, Relation, RelationType } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Matches atom ID patterns like BELI-2026-03-31-DESIRE-PATHS-1abc */
export const ATOM_ID_PATTERN =
  /\b([A-Z]{2,8}-\d{4}-\d{2}-\d{2}-[A-Za-z0-9][A-Za-z0-9-]*)\b/g;

/** Context words for inferring relation type from surrounding text */
export const RELATION_CONTEXT: ReadonlyArray<{ words: RegExp; type: RelationType }> = [
  { words: /extends|builds on|elaborates|generalizes/i, type: 'extends' },
  { words: /contradicts|conflicts with|disagrees|opposes/i, type: 'contradicts' },
  { words: /supports|confirms|agrees with|evidence for/i, type: 'supports' },
  { words: /caused by|because of|due to|triggered by/i, type: 'caused_by' },
  { words: /supersedes|replaces|obsoletes/i, type: 'supersedes' },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProposedRelation {
  sourceId: string;
  targetId: string;
  type: RelationType;
}

export interface RelinkResult {
  proposed: ProposedRelation[];
  applied: number;
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Infer relation type from the sentence context around a matched atom ID.
 * Looks at 100 chars before and after the match position.
 */
export function inferRelationType(body: string, matchIndex: number): RelationType {
  const start = Math.max(0, matchIndex - 100);
  const end = Math.min(body.length, matchIndex + 100);
  const context = body.slice(start, end).toLowerCase();
  for (const { words, type } of RELATION_CONTEXT) {
    if (words.test(context)) return type;
  }
  return 'related';
}

/**
 * Extract body-text references from a single atom's body.
 * Returns proposed relations (not yet deduplicated against existing relations).
 */
export function extractBodyReferences(
  body: string,
  selfId: string,
  knownIds: Set<string>,
): Array<{ targetId: string; type: RelationType }> {
  const results: Array<{ targetId: string; type: RelationType }> = [];
  const seen = new Set<string>();

  ATOM_ID_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATOM_ID_PATTERN.exec(body)) !== null) {
    const targetId = match[1];
    if (targetId === selfId) continue;       // skip self-reference
    if (!knownIds.has(targetId)) continue;    // skip unknown IDs
    const relType = inferRelationType(body, match.index);
    const key = `${targetId}:${relType}`;
    if (seen.has(key)) continue;              // deduplicate within body
    seen.add(key);
    results.push({ targetId, type: relType });
  }

  return results;
}

/**
 * Compute new relations for a single atom, excluding any that already exist.
 */
export function relinkAtom(
  atom: Atom,
  knownIds: Set<string>,
): ProposedRelation[] {
  const selfId = atom.frontmatter.id;
  const existingKeys = new Set(
    (atom.frontmatter.relations ?? []).map((r) => `${r.target}:${r.type}`),
  );

  const bodyRefs = extractBodyReferences(atom.body, selfId, knownIds);
  const proposed: ProposedRelation[] = [];

  for (const ref of bodyRefs) {
    const key = `${ref.targetId}:${ref.type}`;
    if (existingKeys.has(key)) continue;  // already has this relation
    proposed.push({
      sourceId: selfId,
      targetId: ref.targetId,
      type: ref.type,
    });
  }

  return proposed;
}

/**
 * Batch relink: scan all atoms, find body-text references, optionally apply.
 */
export function relinkAll(
  memoryDir: string,
  options: { dryRun: boolean },
): RelinkResult {
  const atoms = listAtoms(memoryDir);
  const knownIds = new Set(atoms.map((a) => a.frontmatter.id));

  const allProposed: ProposedRelation[] = [];
  const changeMap = new Map<string, { atom: Atom; newRelations: ProposedRelation[] }>();

  for (const atom of atoms) {
    const proposed = relinkAtom(atom, knownIds);
    if (proposed.length > 0) {
      allProposed.push(...proposed);
      changeMap.set(atom.frontmatter.id, { atom, newRelations: proposed });
    }
  }

  let applied = 0;
  if (!options.dryRun) {
    for (const { atom, newRelations } of changeMap.values()) {
      const existing: Relation[] = atom.frontmatter.relations ?? [];
      atom.frontmatter.relations = [
        ...existing,
        ...newRelations.map((r) => ({ target: r.targetId, type: r.type })),
      ];

      if (atom.filePath) {
        writeAtom(atom, atom.filePath);
        if (indexExists(memoryDir)) {
          indexAtom(memoryDir, atom);
        }
        applied++;
      }
    }
  }

  return { proposed: allProposed, applied };
}
