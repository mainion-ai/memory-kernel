/**
 * Concept-name citation extractor.
 *
 * Extracts cross-references between atoms by matching concept names
 * (derived from atom slugs) against body text. This captures the
 * informal reference layer that atom-ID matching (mk relink) misses.
 *
 * Empirical finding: concept-name citations are 3.5x larger than
 * atom-ID citations (160 vs 46 on a 93-atom store). Together they
 * provide the frequency signal for ACT-R base-level activation.
 *
 * Three citation types:
 * 1. atom_id — exact atom ID pattern match (handled by mk relink)
 * 2. concept_name — slug-derived keyword match (this module)
 * 3. combined — both types summed (used in wander activation)
 */

import { openIndex, indexExists } from './index-db.js';
import { listAtoms } from './store.js';
import type { Atom } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CitationEntry {
  /** Atom doing the citing */
  sourceId: string;
  /** Atom being cited */
  targetId: string;
  /** Number of times the concept name appears in the source body */
  count: number;
  /** How the citation was detected */
  type: 'atom_id' | 'concept_name';
}

export interface CitationResult {
  /** Total citation entries found */
  total: number;
  /** Citations by type */
  byType: { atom_id: number; concept_name: number };
  /** Number of unique target atoms cited */
  uniqueTargets: number;
  /** Top cited atoms (target_id → total count) */
  topCited: Array<{ atomId: string; count: number }>;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const CREATE_CITATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS atom_citations (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  type TEXT NOT NULL DEFAULT 'concept_name',
  PRIMARY KEY (source_id, target_id, type),
  FOREIGN KEY (source_id) REFERENCES atoms(atom_id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES atoms(atom_id) ON DELETE CASCADE
)`;

const CREATE_CITATIONS_INDEX =
  'CREATE INDEX IF NOT EXISTS idx_citations_target ON atom_citations(target_id)';

// ---------------------------------------------------------------------------
// Concept name extraction
// ---------------------------------------------------------------------------

/**
 * Derive searchable concept names from an atom ID's slug portion.
 *
 * Atom ID format: TYPE-YYYY-MM-DD-SLUG-COUNTER
 * Example: BELI-2026-03-14-NOTATION-AS-ERASURE-1abc
 *
 * Returns lowercased keyword patterns to match against body text.
 * For compound slugs, generates both the full slug and meaningful
 * sub-phrases (minimum 2 words to avoid false positives).
 */
export function deriveConceptNames(atomId: string): string[] {
  // Extract slug: skip TYPE-YYYY-MM-DD prefix and -COUNTER suffix
  const parts = atomId.split('-');
  // Minimum: TYPE-YYYY-MM-DD-WORD-COUNTER = 6 parts
  if (parts.length < 6) return [];

  // Skip first 4 (TYPE, YYYY, MM, DD) and last 1 (counter+nonce)
  const slugParts = parts.slice(4, -1);
  if (slugParts.length === 0) return [];

  const names: string[] = [];

  // Full slug as hyphenated concept name (e.g., "notation-as-erasure")
  const fullSlug = slugParts.join('-').toLowerCase();

  // Minimum 2 words and 8 chars to avoid false positives
  // (single words like "nenad" or short phrases like "two-tier" match too broadly)
  if (slugParts.length >= 2 && fullSlug.length >= 8) {
    names.push(fullSlug);
  }

  // For longer slugs, also try a shorter prefix (first 3-5 words)
  // Only if the full slug is long enough that truncation is meaningful
  if (slugParts.length > 5) {
    const shortSlug = slugParts.slice(0, 5).join('-').toLowerCase();
    if (shortSlug !== fullSlug && shortSlug.length >= 10) {
      names.push(shortSlug);
    }
  }

  return names;
}

/**
 * Count occurrences of concept names in a body text.
 * Case-insensitive matching. Only counts non-overlapping matches.
 */
function countConceptMentions(body: string, conceptNames: string[]): number {
  if (!body || conceptNames.length === 0) return 0;
  const lowerBody = body.toLowerCase();
  let total = 0;

  for (const name of conceptNames) {
    // Use word-boundary-aware matching to avoid partial matches
    // Match concept-name as hyphenated or with spaces/underscores
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Allow hyphens to match hyphens, spaces, or underscores
    const pattern = escaped.replace(/-/g, '[-_ ]');
    const regex = new RegExp(`\\b${pattern}\\b`, 'gi');
    const matches = lowerBody.match(regex);
    if (matches) {
      total += matches.length;
    }
  }

  return total;
}

// ---------------------------------------------------------------------------
// Core extraction
// ---------------------------------------------------------------------------

/**
 * Extract all concept-name citations across the memory store.
 * Returns citation entries without writing to the database.
 */
export function extractCitations(memoryDir: string): CitationEntry[] {
  const atoms = listAtoms(memoryDir);
  if (atoms.length === 0) return [];

  // Build concept-name lookup: atomId → concept names
  const conceptMap = new Map<string, string[]>();
  for (const atom of atoms) {
    const id = atom.frontmatter.id;
    if (!id) continue;
    const names = deriveConceptNames(id);
    if (names.length > 0) {
      conceptMap.set(id, names);
    }
  }

  const citations: CitationEntry[] = [];

  for (const source of atoms) {
    const sourceId = source.frontmatter.id;
    if (!sourceId || !source.body) continue;

    // Check this atom's body against all other atoms' concept names
    for (const [targetId, conceptNames] of conceptMap) {
      if (targetId === sourceId) continue; // skip self-citation

      const count = countConceptMentions(source.body, conceptNames);
      if (count > 0) {
        citations.push({
          sourceId,
          targetId,
          count,
          type: 'concept_name',
        });
      }
    }
  }

  return citations;
}

/**
 * Extract concept-name citations and store in SQLite index.
 * Replaces all existing concept_name citations (idempotent).
 *
 * Also extracts atom-ID citations for a complete picture.
 */
export function indexCitations(memoryDir: string): CitationResult {
  if (!indexExists(memoryDir)) {
    return { total: 0, byType: { atom_id: 0, concept_name: 0 }, uniqueTargets: 0, topCited: [] };
  }

  const db = openIndex(memoryDir);

  // Ensure table exists
  db.exec(CREATE_CITATIONS_TABLE);
  db.exec(CREATE_CITATIONS_INDEX);

  const atoms = listAtoms(memoryDir);
  if (atoms.length === 0) {
    return { total: 0, byType: { atom_id: 0, concept_name: 0 }, uniqueTargets: 0, topCited: [] };
  }

  const knownIds = new Set(atoms.map(a => a.frontmatter.id).filter(Boolean) as string[]);

  // Build concept-name lookup
  const conceptMap = new Map<string, string[]>();
  for (const atom of atoms) {
    const id = atom.frontmatter.id;
    if (!id) continue;
    const names = deriveConceptNames(id);
    if (names.length > 0) {
      conceptMap.set(id, names);
    }
  }

  // Atom ID pattern (same as relink)
  const ATOM_ID_PATTERN = /\b([A-Z]{2,8}-\d{4}-\d{2}-\d{2}-[A-Za-z0-9][A-Za-z0-9-]*)\b/g;

  const allCitations: CitationEntry[] = [];

  for (const source of atoms) {
    const sourceId = source.frontmatter.id;
    if (!sourceId || !source.body) continue;

    // 1. Atom-ID citations
    ATOM_ID_PATTERN.lastIndex = 0;
    const idCounts = new Map<string, number>();
    let match: RegExpExecArray | null;
    while ((match = ATOM_ID_PATTERN.exec(source.body)) !== null) {
      const targetId = match[1];
      if (targetId === sourceId) continue;
      if (!knownIds.has(targetId)) continue;
      idCounts.set(targetId, (idCounts.get(targetId) ?? 0) + 1);
    }

    for (const [targetId, count] of idCounts) {
      allCitations.push({ sourceId, targetId, count, type: 'atom_id' });
    }

    // 2. Concept-name citations
    for (const [targetId, conceptNames] of conceptMap) {
      if (targetId === sourceId) continue;
      const count = countConceptMentions(source.body, conceptNames);
      if (count > 0) {
        allCitations.push({ sourceId, targetId, count, type: 'concept_name' });
      }
    }
  }

  // Write to SQLite (replace all)
  db.transaction(() => {
    db.prepare('DELETE FROM atom_citations').run();

    const insert = db.prepare(`
      INSERT INTO atom_citations (source_id, target_id, count, type)
      VALUES (?, ?, ?, ?)
    `);

    for (const c of allCitations) {
      insert.run(c.sourceId, c.targetId, c.count, c.type);
    }
  })();

  // Compute summary
  const byType = { atom_id: 0, concept_name: 0 };
  const targetCounts = new Map<string, number>();

  for (const c of allCitations) {
    byType[c.type] += c.count;
    targetCounts.set(c.targetId, (targetCounts.get(c.targetId) ?? 0) + c.count);
  }

  const topCited = [...targetCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([atomId, count]) => ({ atomId, count }));

  return {
    total: allCitations.reduce((sum, c) => sum + c.count, 0),
    byType,
    uniqueTargets: targetCounts.size,
    topCited,
  };
}
