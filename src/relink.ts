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
} from './index.js';
import { indexAtom } from './index-db.js';
import { deriveConceptNames } from './citations.js';
import type { Atom, Relation, RelationType } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Matches atom ID patterns like BELI-2026-03-31-DESIRE-PATHS-1abc */
export const ATOM_ID_PATTERN =
  /\b([A-Z]{2,8}-\d{4}-\d{2}-\d{2}-[A-Za-z0-9][A-Za-z0-9-]*)\b/g;

/**
 * Returns a fresh, stateless atom-ID regex. Prefer this over the global
 * `ATOM_ID_PATTERN` constant when calling `.match()` / `.matchAll()` in
 * a loop — the factory eliminates the `lastIndex` reset footgun.
 */
export function createAtomIdPattern(): RegExp {
  return /\b([A-Z]{2,8}-\d{4}-\d{2}-\d{2}-[A-Za-z0-9][A-Za-z0-9-]*)\b/g;
}

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

// ---------------------------------------------------------------------------
// Concept-name extraction
// ---------------------------------------------------------------------------

/**
 * Build a map from concept names to their owning atom IDs.
 * Uses deriveConceptNames() from citations.ts to extract slugs.
 *
 * Accepts either Atom[] or Set<string>/Iterable<string> of atom IDs.
 * The Set<string> overload avoids loading full atoms from disk when
 * only IDs are needed (e.g., at remember-time from getAllAtomIds).
 */
export function buildConceptMap(
  atomsOrIds: Atom[] | Set<string>,
): Map<string, string> {
  const map = new Map<string, string>();

  // Extract IDs from either Atom[] or Set<string>
  const ids: Iterable<string> = atomsOrIds instanceof Set
    ? atomsOrIds
    : (atomsOrIds as Atom[]).map(a => a.frontmatter.id).filter(Boolean) as string[];

  for (const id of ids) {
    for (const name of deriveConceptNames(id)) {
      if (!map.has(name)) {
        map.set(name, id);
      }
    }
  }
  return map;
}

/** A precompiled concept-name pattern, ready for reuse across many bodies. */
export interface CompiledConceptPattern {
  /** The atom ID that owns this concept name. */
  targetId: string;
  /** Word-boundary-aware case-insensitive regex matching the concept name. */
  regex: RegExp;
}

/**
 * Precompile concept-name regexes from a concept map.
 *
 * Hoisted out of `extractConceptReferences()` so callers that scan many
 * atoms against the same `conceptMap` (e.g. `relinkAll`) pay the regex
 * construction cost once instead of N times per atom.
 *
 * The returned patterns are reusable across calls — each call to
 * `extractConceptReferences()` resets `lastIndex` before use.
 */
export function compileConceptPatterns(
  conceptMap: Map<string, string>,
): CompiledConceptPattern[] {
  const out: CompiledConceptPattern[] = [];
  for (const [conceptName, targetId] of conceptMap) {
    // Build word-boundary-aware regex (hyphens match hyphens/spaces/underscores).
    // \b works here because concept names start/end with word characters (letters/digits),
    // so the word boundary fires correctly even though internal hyphens are non-word chars.
    // e.g., "notation-as-erasure" matches \bnotation[-\s_]as[-\s_]erasure\b because
    // 'n' and 'e' are word chars at the edges.
    const escaped = conceptName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = escaped.replace(/-/g, '[-\\s_]');
    out.push({ targetId, regex: new RegExp(`\\b${pattern}\\b`, 'gi') });
  }
  return out;
}

/**
 * Extract concept-name references from a single atom's body.
 * Similar to extractBodyReferences but matches concept names (e.g.,
 * "notation-as-erasure") instead of atom IDs.
 *
 * Uses the same inferRelationType() for context-based relation typing.
 *
 * Accepts either a `Map<string, string>` (concept name → atom ID) or a
 * precompiled `CompiledConceptPattern[]` from `compileConceptPatterns()`.
 * Pass the precompiled form when scanning many atoms against the same
 * concept map so the regex construction (the bulk of the work) happens
 * once for the batch instead of per atom.
 */
export function extractConceptReferences(
  body: string,
  selfId: string,
  conceptMapOrPatterns: Map<string, string> | CompiledConceptPattern[],
): Array<{ targetId: string; type: RelationType }> {
  const results: Array<{ targetId: string; type: RelationType }> = [];
  const seen = new Set<string>();

  const patterns: CompiledConceptPattern[] = Array.isArray(conceptMapOrPatterns)
    ? conceptMapOrPatterns
    : compileConceptPatterns(conceptMapOrPatterns);

  for (const { targetId, regex } of patterns) {
    if (targetId === selfId) continue;

    // Reset lastIndex so a global regex doesn't carry state from any previous
    // body it was scanned against — required when the same precompiled pattern
    // list is reused across multiple atoms.
    regex.lastIndex = 0;
    const match = regex.exec(body);

    if (match && !seen.has(targetId)) {
      seen.add(targetId);
      const relType = inferRelationType(body, match.index);
      results.push({ targetId, type: relType });
    }
  }

  return results;
}

/**
 * Deduplicate references by (targetId, type) pair.
 * When atom-ID and concept-name extraction find the same reference,
 * keep only one (atom-ID refs come first, so they take priority).
 */
export function deduplicateRefs(
  refs: Array<{ targetId: string; type: RelationType }>,
): Array<{ targetId: string; type: RelationType }> {
  const seen = new Set<string>();
  const result: Array<{ targetId: string; type: RelationType }> = [];
  for (const ref of refs) {
    const key = `${ref.targetId}:${ref.type}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(ref);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Relink logic
// ---------------------------------------------------------------------------

/**
 * Compute new relations for a single atom, excluding any that already exist.
 *
 * `conceptMap` accepts either a raw `Map` or a precompiled
 * `CompiledConceptPattern[]` — callers in a loop should compile once via
 * `compileConceptPatterns()` and pass the array form to avoid re-doing the
 * regex construction per atom.
 */
export function relinkAtom(
  atom: Atom,
  knownIds: Set<string>,
  conceptMap?: Map<string, string> | CompiledConceptPattern[],
): ProposedRelation[] {
  const selfId = atom.frontmatter.id;
  const existingKeys = new Set(
    (atom.frontmatter.relations ?? []).map((r) => `${r.target}:${r.type}`),
  );

  // Atom-ID references (existing behavior)
  const idRefs = extractBodyReferences(atom.body, selfId, knownIds);

  // Concept-name references (new)
  const conceptRefs = conceptMap
    ? extractConceptReferences(atom.body, selfId, conceptMap)
    : [];

  // Merge and deduplicate (atom-ID refs take priority)
  const allRefs = deduplicateRefs([...idRefs, ...conceptRefs]);

  const proposed: ProposedRelation[] = [];
  for (const ref of allRefs) {
    const key = `${ref.targetId}:${ref.type}`;
    if (existingKeys.has(key)) continue;
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
  const conceptMap = buildConceptMap(atoms);
  // Precompile once for the whole batch — the per-concept regexes were the
  // expensive part of the inner per-atom loop (see #117).
  const conceptPatterns = compileConceptPatterns(conceptMap);

  const allProposed: ProposedRelation[] = [];
  const changeMap = new Map<string, { atom: Atom; newRelations: ProposedRelation[] }>();

  for (const atom of atoms) {
    const proposed = relinkAtom(atom, knownIds, conceptPatterns);
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
