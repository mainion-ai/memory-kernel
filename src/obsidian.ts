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

import type { Relation } from './types.js';
import { ATOM_TYPES } from './types.js';

/** Sentinel marking the start of the machine-managed relations section. */
export const RELATIONS_SENTINEL = '<!-- mk:relations -->';

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

  for (const [type, targets] of grouped) {
    // Juggl-compatible typed links: "- type [[target]]"
    // Juggl requires single-word type labels, so replace underscores
    const jugglType = type.replace(/_/g, '');
    for (const target of targets.sort()) {
      lines.push(`- ${jugglType} [[${target}]]`);
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
