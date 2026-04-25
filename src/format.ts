/**
 * Canonicalization and formatting for memory atoms.
 * Ensures deterministic output — same data → identical bytes.
 */

import yaml from 'js-yaml';
import matter from 'gray-matter';
import type { Atom, AtomFrontmatter } from './types.js';
import { renderRelationsSection, stripRelationsSection } from './obsidian.js';

// Stable key order for YAML frontmatter
const KEY_ORDER: (keyof AtomFrontmatter)[] = [
  'id',
  'type',
  'status',
  'confidence',
  'created_at',
  'updated_at',
  'ttl_days',
  'scope',
  'classification',
  'provenance',
  'links',
  'relations',
];

/**
 * Serialize atom frontmatter to YAML with stable key ordering.
 */
export function serializeFrontmatter(fm: AtomFrontmatter): string {
  // Build ordered object, inserting promoted `tags` before `scope`
  // so Obsidian's indexer sees the top-level tags field first.
  const ordered: Record<string, unknown> = {};
  for (const key of KEY_ORDER) {
    // Insert promoted tags right before scope in YAML output
    if (key === 'scope' && fm.scope?.tags && fm.scope.tags.length > 0) {
      ordered.tags = fm.scope.tags;
    }
    if (fm[key] !== undefined) {
      ordered[key] = fm[key];
    }
  }

  return yaml.dump(ordered, {
    sortKeys: false, // We pre-sorted
    lineWidth: -1, // No wrapping
    noRefs: true,
    quotingType: '"',
    forceQuotes: false,
  }).trim();
}

/**
 * Serialize a full atom (frontmatter + body) to markdown with YAML frontmatter.
 */
export function serializeAtom(atom: Atom): string {
  const fm = serializeFrontmatter(atom.frontmatter);
  const relSection = renderRelationsSection(atom.frontmatter.relations);
  return `---\n${fm}\n---\n\n${atom.body.trim()}\n${relSection}`;
}

/**
 * Parse a markdown file with YAML frontmatter into an Atom.
 * Validates that required fields (id, type, status) are present.
 */
export function parseAtom(content: string, filePath?: string): Atom {
  const parsed = matter(content);
  const data = parsed.data;

  // Validate required fields to prevent downstream crashes
  if (!data || typeof data.id !== 'string' || !data.id) {
    throw new Error(`Missing or invalid 'id' in frontmatter${filePath ? ` (${filePath})` : ''}`);
  }
  if (typeof data.type !== 'string' || !data.type) {
    throw new Error(`Missing or invalid 'type' in frontmatter${filePath ? ` (${filePath})` : ''}`);
  }
  if (typeof data.status !== 'string' || !data.status) {
    throw new Error(`Missing or invalid 'status' in frontmatter${filePath ? ` (${filePath})` : ''}`);
  }

  // Handle promoted top-level `tags` — it's a derived view of scope.tags
  // for Obsidian compatibility, not a canonical frontmatter field.
  // If a user edited tags in Obsidian, merge them back into scope.tags.
  if (data.tags) {
    if (Array.isArray(data.tags) && data.tags.length > 0) {
      if (!data.scope) data.scope = {};
      const existing = new Set(data.scope.tags ?? []);
      for (const t of data.tags) {
        if (typeof t === 'string') existing.add(t);
      }
      data.scope.tags = [...existing].sort();
    }
    delete data.tags;
  }

  return {
    frontmatter: data as AtomFrontmatter,
    body: stripRelationsSection(parsed.content.trim()),
    filePath,
  };
}

/**
 * Normalize a timestamp to UTC ISO8601.
 * Throws a clear error for invalid date inputs instead of propagating RangeError.
 */
export function normalizeTimestamp(ts?: string | Date): string {
  const d = ts !== undefined ? new Date(ts) : new Date();
  if (isNaN(d.getTime())) {
    throw new Error(`normalizeTimestamp: invalid timestamp "${String(ts)}"`);
  }
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z'); // Drop milliseconds for cleaner output
}
