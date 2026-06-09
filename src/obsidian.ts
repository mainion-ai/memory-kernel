/**
 * Obsidian-native compatibility for memory atoms.
 *
 * Atom .md files in ENTITIES/ are Obsidian-ready by default:
 * - Relations render as [[wikilinks]] in a sentinel-delimited section
 * - Tags in YAML frontmatter are natively supported
 * - Graph colors configurable via .obsidian/graph.json
 *
 * The ## Relations section is machine-managed: stripped on read (never
 * pollutes Atom.body), regenerated on write from frontmatter.relations[].
 * Files are truth; the section is a derived view.
 */

import type { Relation, RelationType } from './types.js';
import { ATOM_TYPES, RELATION_TYPES } from './types.js';

/** Sentinel marking the start of the machine-managed relations section. */
export const RELATIONS_SENTINEL = '<!-- mk:relations -->';

/** Canonical relation type → Obsidian display form (`caused_by` → `caused-by`). */
export function relationTypeToDisplay(type: string): string {
  return type.replace(/_/g, '-');
}

/** Obsidian display form → canonical relation type (`caused-by` → `caused_by`). */
export function relationDisplayToType(display: string): string {
  return display.replace(/-/g, '_');
}

/** Display forms of every known outgoing relation type. Built once. */
const VALID_RELATION_DISPLAY_TYPES = new Set(RELATION_TYPES.map(relationTypeToDisplay));

/**
 * Parse outgoing edges from an atom's rendered `<!-- mk:relations -->` section.
 *
 * Inverse of {@link renderRelationsSection} — kept here, beside the renderer,
 * so the line format (`- <display-type> [[target]]`) lives in exactly one
 * place. Returns `{type, target}` pairs for bullets whose display type (after
 * hyphen→underscore normalisation) is a known `RELATION_TYPE`; reverse/incoming
 * display types (e.g. `extended-by`) are valid section content but are NOT in
 * `RELATION_TYPES`, so they're ignored. Any Obsidian display alias is stripped
 * (`[[target|alias]]` → `target`).
 *
 * Uses `lastIndexOf` because the section is always rendered at end-of-file; an
 * earlier mention of the sentinel (e.g. quoted in an atom's prose body) must
 * not be mistaken for the section start.
 */
export function parseRelationsSection(
  rawContent: string,
): Array<{ type: RelationType; target: string }> {
  const idx = rawContent.lastIndexOf(RELATIONS_SENTINEL);
  if (idx === -1) return [];

  const edges: Array<{ type: RelationType; target: string }> = [];
  for (const line of rawContent.slice(idx).split('\n')) {
    const m = line.match(/^-\s+(\S+)\s+\[\[([^\]]+)\]\]/);
    if (!m) continue;
    const [, displayType, rawTarget] = m;
    if (VALID_RELATION_DISPLAY_TYPES.has(displayType)) {
      edges.push({
        type: relationDisplayToType(displayType) as RelationType,
        target: rawTarget.split('|')[0].trim(),
      });
    }
  }
  return edges;
}

/**
 * Distinct colors for each atom type, as RGB integers for Obsidian's graph.json.
 * Chosen for visual contrast in a dark-background graph view.
 */
export const TYPE_COLORS: Record<string, number> = {
  belief:          0x4A90D9,  // steel blue
  fact:            0x27AE60,  // emerald green
  decision:        0xE67E22,  // orange
  open_question:   0x9B59B6,  // purple
  preference:      0xE91E63,  // pink
  constraint:      0xE74C3C,  // red
  procedure:       0x1ABC9C,  // teal
  entity_summary:  0xF1C40F,  // yellow
  conflict:        0xFF5722,  // deep orange
};

/** 4-char type prefixes used in atom IDs. */
const TYPE_PREFIXES: Record<string, string> = {
  belief:          'BELI',
  fact:            'FACT',
  decision:        'DECI',
  open_question:   'OPEN',
  preference:      'PREF',
  constraint:      'CONS',
  procedure:       'PROC',
  entity_summary:  'ENTS',
  conflict:        'CONF',
};

/**
 * Render a ## Relations section from an atom's frontmatter relations.
 * Groups by relation type, renders as Obsidian [[wikilink]] bullets.
 * Returns empty string if no relations exist.
 */
export function renderRelationsSection(relations: Relation[] | undefined): string {
  if (!relations || relations.length === 0) return '';

  // Group by relation type, preserving order of first appearance
  const grouped = new Map<string, string[]>();
  for (const rel of relations) {
    const targets = grouped.get(rel.type) ?? [];
    // Deduplicate targets within the same type
    if (!targets.includes(rel.target)) {
      targets.push(rel.target);
    }
    grouped.set(rel.type, targets);
  }

  const lines: string[] = [
    '',
    RELATIONS_SENTINEL,
    '## Relations',
    '',
  ];

  let first = true;
  for (const [type, targets] of grouped) {
    // Blank line between type groups for readability
    if (!first) lines.push('');
    first = false;
    // Typed relation links: "- type [[target]]"
    // Replace underscores with hyphens for readability (caused-by > caused_by).
    const displayType = relationTypeToDisplay(type);
    for (const target of targets.sort()) {
      lines.push(`- ${displayType} [[${target}]]`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Strip the ## Relations section from a body string.
 * Finds the sentinel comment and removes everything from it to end-of-string.
 * Returns the body without the sentinel-delimited section.
 */
export function stripRelationsSection(body: string): string {
  const idx = body.indexOf(RELATIONS_SENTINEL);
  if (idx === -1) return body;
  return body.slice(0, idx).trimEnd();
}

/**
 * Generate Obsidian graph.json configuration with type-based color groups.
 * Uses YAML frontmatter `type` field queries for matching.
 */
export function generateGraphConfig(): Record<string, unknown> {
  const colorGroups = ATOM_TYPES.map((type) => ({
    query: `file:${TYPE_PREFIXES[type] ?? type.toUpperCase().slice(0, 4)}`,
    color: { a: 1, rgb: TYPE_COLORS[type] ?? 0x95A5A6 },
  }));

  return {
    'collapse-filter': false,
    'search': '',
    'showTags': true,
    'showAttachments': false,
    'hideUnresolved': false,
    'showOrphans': false,
    'collapse-color-groups': false,
    colorGroups,
    'collapse-display': true,
    'showArrow': false,
    'textFadeMultiplier': 0.9,
    'nodeSizeMultiplier': 1.51023871527778,
    'lineSizeMultiplier': 1.00939236111111,
    'collapse-forces': true,
    'centerStrength': 0.296961805555556,
    'repelStrength': 12.1467013888889,
    'linkStrength': 0.493967013888889,
    'linkDistance': 500,
  };
}
