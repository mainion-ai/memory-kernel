/**
 * Canonicalization and formatting for memory atoms.
 * Ensures deterministic output — same data → identical bytes.
 */

import yaml from 'js-yaml';
import { parseFrontmatter } from './internal/frontmatter.js';
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
  'executed_at',
];

/**
 * Normalize tags: split comma-separated strings into individual tags,
 * trim whitespace, deduplicate, and sort.
 * Handles the common case where CLI users pass --tags "tag1,tag2,tag3"
 * as a single string instead of separate arguments.
 */
export function normalizeTags(tags: string[]): string[] {
  const result = new Set<string>();
  for (const t of tags) {
    for (const part of t.split(',')) {
      const trimmed = part.trim();
      if (trimmed) result.add(trimmed);
    }
  }
  return [...result].sort();
}

/**
 * A well-formed tag is a single token with no whitespace (#262). Tags in the mk
 * convention are hyphen-separated, never space-separated — a tag containing
 * whitespace (e.g. `"AIRE peer-review N-version"`, from an LLM emitting a
 * space-joined list as one YAML item, or `mk remember --tags "foo bar"` quoted)
 * is one opaque token that breaks FTS tag queries and tag filtering. Shared by
 * the `tag-format` doctor check and `mk remember`'s write-time warning.
 */
export function isValidTag(tag: string): boolean {
  return tag.length > 0 && !/\s/.test(tag);
}

/**
 * Legacy Juggl typed-link frontmatter keys (no longer generated).
 * Stripped on parse for backward compatibility with atoms serialized
 * before Juggl support was removed.
 */
const LEGACY_TYPED_LINK_KEYS = new Set([
  'extends', 'supports', 'contradicts', 'caused-by',
  'related', 'applied-to',
  'causedby', 'appliedto',
]);

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
      ordered.tags = normalizeTags(fm.scope.tags);
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
  const parsed = parseFrontmatter(content);
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

  // Strip legacy Juggl typed-link frontmatter keys (no longer generated,
  // but may exist in atoms serialized before Juggl support was removed)
  for (const key of LEGACY_TYPED_LINK_KEYS) {
    delete data[key];
  }

  // Handle promoted top-level `tags` — it's a derived view of scope.tags
  // for Obsidian compatibility, not a canonical frontmatter field.
  // If a user edited tags in Obsidian, merge them back into scope.tags.
  if (data.tags) {
    if (Array.isArray(data.tags) && data.tags.length > 0) {
      if (!data.scope) data.scope = {};
      // Normalize both existing and incoming tags (splits comma-separated strings)
      const allTags = [
        ...normalizeTags(data.scope.tags ?? []),
        ...normalizeTags(data.tags.filter((t: unknown) => typeof t === 'string') as string[]),
      ];
      data.scope.tags = [...new Set(allTags)].sort();
    }
    delete data.tags;
  }

  // Normalize scope.tags even without promoted tags (fixes comma-separated strings)
  if (data.scope?.tags && Array.isArray(data.scope.tags)) {
    data.scope.tags = normalizeTags(data.scope.tags);
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
