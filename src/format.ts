/**
 * Canonicalization and formatting for memory atoms.
 * Ensures deterministic output — same data → identical bytes.
 */

import yaml from 'js-yaml';
import matter from 'gray-matter';
import type { Atom, AtomFrontmatter } from './types.js';

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
];

/**
 * Serialize atom frontmatter to YAML with stable key ordering.
 */
export function serializeFrontmatter(fm: AtomFrontmatter): string {
  // Build ordered object
  const ordered: Record<string, unknown> = {};
  for (const key of KEY_ORDER) {
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
  return `---\n${fm}\n---\n\n${atom.body.trim()}\n`;
}

/**
 * Parse a markdown file with YAML frontmatter into an Atom.
 */
export function parseAtom(content: string, filePath?: string): Atom {
  const parsed = matter(content);
  return {
    frontmatter: parsed.data as AtomFrontmatter,
    body: parsed.content.trim(),
    filePath,
  };
}

/**
 * Normalize a timestamp to UTC ISO8601.
 */
export function normalizeTimestamp(ts?: string | Date): string {
  const d = ts ? new Date(ts) : new Date();
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z'); // Drop milliseconds for cleaner output
}
