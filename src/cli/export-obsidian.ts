/**
 * CLI command: mk export-obsidian
 *
 * Exports a memory store to an Obsidian vault directory.
 * Atoms become .md files with wikilinks for graph visualization.
 *
 * Usage:
 *   mk export-obsidian --dir <memory-dir> --out <vault-path>
 *   mk export-obsidian --dir <memory-dir> --out <vault-path> --include-archived
 */

import fs from 'fs';
import path from 'path';
import type { Command } from 'commander';
import { resolveDir } from './resolve-dir.js';
import { exitWithError } from './cli-util.js';
import { listAtoms } from '../store.js';
import type { Atom } from '../types.js';
import { ATOM_TYPES } from '../types.js';

/** Pattern matching atom IDs in body text: TYPE-YYYY-MM-DD-SLUG */
const ATOM_ID_PATTERN = /(?<!\[\[)((?:BELI|FACT|DECI|OPEN|PREF|EP|PROC|ENTI|CONS|CONF)-\d{4}-\d{2}-\d{2}-[A-Z0-9][-A-Z0-9]*)(?!\]\])/g;

/**
 * Distinct colors for each atom type, as RGB integers for Obsidian's graph.json format.
 * Chosen for visual contrast in a dark-background graph view.
 */
const TYPE_COLORS: Record<string, number> = {
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

/**
 * Generate Obsidian vault configuration with type-based color groups for graph view.
 */
function generateGraphConfig(): Record<string, unknown> {
  const colorGroups = ATOM_TYPES.map((type) => ({
    query: `[type: ${type}]`,
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
    'textFadeMultiplier': -0.8,
    'nodeSizeMultiplier': 1,
    'lineSizeMultiplier': 2.85,
    'collapse-forces': true,
    'centerStrength': 0.344,
    'repelStrength': 10,
    'linkStrength': 0.75,
    'linkDistance': 236,
  };
}

/**
 * Resolve a partial atom ID reference to a full atom ID from the known set.
 * Body text often contains truncated IDs (without the hash suffix), or
 * uses the full conceptual name which is longer than the actual truncated slug.
 * Returns the full ID if a unique match is found, otherwise the original.
 */
function resolveAtomId(partialId: string, knownIds: Set<string>): string {
  // Exact match
  if (knownIds.has(partialId)) return partialId;

  // Case 1: partial is a prefix of the actual ID (body has short form, ID has hash suffix)
  const prefixMatches = [...knownIds].filter((id) => id.startsWith(partialId));
  if (prefixMatches.length === 1) return prefixMatches[0];

  // Case 2: actual ID is a prefix of partial (body has full name, ID was truncated + hash)
  // e.g., partial = "...-ERASURE-PROFILE", actual = "...-ERASURE-PRO-1izxr"
  // Strip the hash suffix from known IDs and check if partial starts with the slug portion
  const slugMatches = [...knownIds].filter((id) => {
    // Remove the hash suffix (last -XXXXX where X is alphanumeric, 3-6 chars)
    const slug = id.replace(/-[a-z0-9]{3,6}$/, '');
    return partialId.startsWith(slug) && slug.length > 20;
  });
  if (slugMatches.length === 1) return slugMatches[0];

  // Ambiguous or no match — return as-is
  return partialId;
}

/**
 * Transform an atom into an Obsidian-compatible markdown file.
 */
export function transformAtom(atom: Atom, knownIds: Set<string>): { filename: string; content: string; wikilinkCount: number } {
  const fm = atom.frontmatter;
  const filename = `${fm.id}.md`;

  // Build clean Obsidian frontmatter
  const obsidianFm: Record<string, unknown> = {
    id: fm.id,
    type: fm.type,
    status: fm.status,
    confidence: fm.confidence,
    created_at: fm.created_at,
    updated_at: fm.updated_at,
  };

  // Promote scope.tags to top-level tags (Obsidian reads this natively)
  if (fm.scope?.tags && fm.scope.tags.length > 0) {
    obsidianFm.tags = fm.scope.tags;
  }

  if (fm.classification) {
    obsidianFm.classification = fm.classification;
  }

  // Serialize frontmatter as YAML
  const yamlLines = ['---'];
  for (const [key, value] of Object.entries(obsidianFm)) {
    if (Array.isArray(value)) {
      yamlLines.push(`${key}:`);
      for (const item of value) {
        yamlLines.push(`  - ${item}`);
      }
    } else if (value === null || value === undefined) {
      yamlLines.push(`${key}: null`);
    } else if (typeof value === 'string' && (value.includes(':') || value.includes('"') || value.startsWith('{') || value.startsWith('['))) {
      // Backslash must be escaped before quote — otherwise a trailing "\" in the
      // value becomes \" in the output and YAML reads it as an escaped quote,
      // leaving the string unterminated.
      const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      yamlLines.push(`${key}: "${escaped}"`);
    } else {
      yamlLines.push(`${key}: ${value}`);
    }
  }
  yamlLines.push('---');

  // Transform body: wrap inline atom ID references in wikilinks
  let wikilinkCount = 0;
  let body = atom.body;

  // Replace atom ID patterns in body text with [[wikilinks]]
  // Resolve partial IDs to full atom IDs to avoid ghost nodes in Obsidian
  body = body.replace(ATOM_ID_PATTERN, (_match, id) => {
    const resolved = resolveAtomId(id, knownIds);
    wikilinkCount++;
    return `[[${resolved}]]`;
  });

  // Build relations section from frontmatter relations
  const relationsLines: string[] = [];
  if (fm.relations && fm.relations.length > 0) {
    relationsLines.push('', '## Relations');
    for (const rel of fm.relations) {
      relationsLines.push(`- ${rel.type} [[${rel.target}]]`);
      wikilinkCount++;
    }
  }

  const content = yamlLines.join('\n') + '\n\n' + body.trim() + (relationsLines.length > 0 ? '\n' + relationsLines.join('\n') + '\n' : '\n');

  return { filename, content, wikilinkCount };
}

export function registerExportObsidianCommand(program: Command): void {
  program
    .command('export-obsidian')
    .description(
      'Export memory store to an Obsidian vault directory.\n' +
      'Atoms become .md files with [[wikilinks]] for graph visualization.',
    )
    .requiredOption('--out <path>', 'Output vault directory (created if missing)')
    .option('-d, --dir <dir>', 'Memory directory', './memory')
    .option('--include-archived', 'Include archived atoms (default: skip)')
    .option('--json', 'Output as JSON')
    .action((opts: { out: string; dir: string; includeArchived?: boolean; json?: boolean }) => {
      const memoryDir = resolveDir(opts.dir, program.opts().agent);
      if (!fs.existsSync(memoryDir)) {
        exitWithError(
          `Memory directory not found: ${memoryDir}\n  Run "mk init" first.`,
          opts.json,
        );
      }

      const outDir = path.resolve(opts.out);
      fs.mkdirSync(outDir, { recursive: true });

      // Load atoms
      let atoms = listAtoms(memoryDir);

      // Filter archived unless explicitly included
      if (!opts.includeArchived) {
        atoms = atoms.filter((a) => a.frontmatter.status !== 'archived');
      }

      // Build set of known atom IDs for resolving partial references
      const knownIds = new Set(atoms.map((a) => a.frontmatter.id));

      // Transform and write
      let totalWikilinks = 0;
      const typeCounts = new Map<string, number>();

      for (const atom of atoms) {
        const { filename, content, wikilinkCount } = transformAtom(atom, knownIds);
        const outPath = path.join(outDir, filename);
        fs.writeFileSync(outPath, content);
        totalWikilinks += wikilinkCount;
        const t = atom.frontmatter.type;
        typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
      }

      // Write Obsidian vault config with type-based color groups
      const obsidianDir = path.join(outDir, '.obsidian');
      fs.mkdirSync(obsidianDir, { recursive: true });
      const graphConfig = generateGraphConfig();
      fs.writeFileSync(path.join(obsidianDir, 'graph.json'), JSON.stringify(graphConfig, null, 2));

      // Build summary
      const typeSummary = [...typeCounts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([type, count]) => `${count} ${type}s`)
        .join(', ');

      if (opts.json) {
        console.log(JSON.stringify({
          exported: atoms.length,
          by_type: Object.fromEntries(typeCounts),
          wikilinks: totalWikilinks,
          output_dir: outDir,
        }, null, 2));
        return;
      }

      console.log(`\u2713 Exported ${atoms.length} atoms (${typeSummary}) with ${totalWikilinks} wikilinks to ${outDir}`);
    });
}
