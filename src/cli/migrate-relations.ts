/**
 * One-time migration: extract atom cross-references from frontmatter and body
 * text and populate the `relations` field.
 *
 * Migrates:
 * - `links.related` entries → `relations: [{ type: 'related', target: X }]`
 * - Atom ID references in body text → inferred relation type from context words
 *
 * Does NOT migrate `links.supersedes` — that is a status relationship, not a graph edge.
 */

import fs from 'fs';
import path from 'path';
import type { Command } from 'commander';
import { resolveDir } from './resolve-dir.js';
import { exitWithError } from './cli-util.js';
import {
  listAtoms,
  writeAtom,
  indexExists,
} from '../index.js';
import { indexAtom } from '../index-db.js';
import type { Atom, Relation, RelationType } from '../types.js';

/** Matches atom ID patterns like BELI-2026-03-31-DESIRE-PATHS-FORM-TREES-1abc
 *  Note: suffix includes lowercase hex (counter + nonce from generateAtomId) */
const ATOM_ID_PATTERN = /\b([A-Z]{2,8}-\d{4}-\d{2}-\d{2}-[A-Za-z0-9][A-Za-z0-9-]*)\b/g;

/** Context words for inferring relation type from surrounding text */
const RELATION_CONTEXT: Array<{ words: RegExp; type: RelationType }> = [
  { words: /extends|builds on|elaborates|generalizes/i, type: 'extends' },
  { words: /contradicts|conflicts with|disagrees|opposes/i, type: 'contradicts' },
  { words: /supports|confirms|agrees with|evidence for/i, type: 'supports' },
  { words: /caused by|because of|due to|triggered by/i, type: 'caused_by' },
  { words: /supersedes|replaces|obsoletes/i, type: 'supersedes' },
];

interface ProposedRelation {
  atomId: string;
  relation: Relation;
  source: 'links.related' | 'body_text';
}

/**
 * Infer relation type from the sentence context around a matched atom ID.
 */
function inferRelationType(body: string, matchIndex: number): RelationType {
  // Look at 100 chars before and after the match for context words
  const context = body.slice(Math.max(0, matchIndex - 100), matchIndex + 100).toLowerCase();
  for (const { words, type } of RELATION_CONTEXT) {
    if (words.test(context)) return type;
  }
  return 'related';
}

/**
 * Extract proposed relations for a single atom.
 */
function extractProposedRelations(
  atom: Atom,
  knownIds: Set<string>,
): ProposedRelation[] {
  const proposals: ProposedRelation[] = [];
  const id = atom.frontmatter.id;
  const existingRelations = atom.frontmatter.relations ?? [];

  // Helper: check if a (target, type) pair is already in frontmatter
  const alreadyHas = (target: string, type: RelationType) =>
    existingRelations.some((r) => r.target === target && r.type === type);

  // 1. Migrate links.related
  for (const target of atom.frontmatter.links?.related ?? []) {
    if (target === id) continue; // skip self-references
    if (!alreadyHas(target, 'related')) {
      proposals.push({ atomId: id, relation: { target, type: 'related' }, source: 'links.related' });
    }
  }

  // 2. Mine body text for atom ID references
  let match: RegExpExecArray | null;
  ATOM_ID_PATTERN.lastIndex = 0; // reset stateful regex
  while ((match = ATOM_ID_PATTERN.exec(atom.body)) !== null) {
    const target = match[1];
    if (target === id) continue; // skip self-reference
    if (!knownIds.has(target)) continue; // cross-check: only real atom IDs
    const relationType = inferRelationType(atom.body, match.index);
    if (!alreadyHas(target, relationType)) {
      proposals.push({ atomId: id, relation: { target, type: relationType }, source: 'body_text' });
    }
  }

  // Deduplicate proposals (same target+type from multiple sources)
  const seen = new Set<string>();
  return proposals.filter((p) => {
    const key = `${p.relation.target}:${p.relation.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Register `mk migrate-relations [--dry-run|--apply]` command.
 */
export function registerMigrateRelationsCommand(program: Command): void {
  program
    .command('migrate-relations')
    .description(
      'Migrate links.related and body text references to typed relations.\n' +
      'Use --dry-run to preview, --apply to write changes.',
    )
    .option('-d, --dir <dir>', 'Memory directory', './memory')
    .option('--dry-run', 'Preview proposed relations without writing')
    .option('--apply', 'Write relations to atom frontmatter and reindex')
    .option('--json', 'Output results as JSON')
    .action((opts: { dir: string; dryRun?: boolean; apply?: boolean; json?: boolean }) => {
      if (!opts.dryRun && !opts.apply) {
        exitWithError('Specify --dry-run to preview or --apply to write changes.', opts.json);
      }

      const memoryDir = resolveDir(opts.dir, program.opts().agent);
      if (!fs.existsSync(memoryDir)) {
        exitWithError(`Memory directory not found: ${memoryDir}`, opts.json);
      }

      const atoms = listAtoms(memoryDir);
      const knownIds = new Set(atoms.map((a) => a.frontmatter.id));

      // Collect all proposed changes
      const changeMap = new Map<string, { atom: Atom; proposals: ProposedRelation[] }>();
      let totalProposals = 0;

      for (const atom of atoms) {
        const proposals = extractProposedRelations(atom, knownIds);
        if (proposals.length > 0) {
          changeMap.set(atom.frontmatter.id, { atom, proposals });
          totalProposals += proposals.length;
        }
      }

      if (totalProposals === 0) {
        if (opts.json) {
          console.log(
            JSON.stringify({ dry_run: !!opts.dryRun, proposed: 0, written: 0, changes: [] }, null, 2),
          );
          return;
        }
        console.log('✓ No new relations to migrate.');
        return;
      }

      if (opts.dryRun) {
        if (opts.json) {
          const changes = Array.from(changeMap.values()).map(({ atom, proposals }) => ({
            atom_id: atom.frontmatter.id,
            proposals: proposals.map((p) => ({
              type: p.relation.type,
              target: p.relation.target,
              source: p.source,
            })),
          }));
          console.log(
            JSON.stringify({ dry_run: true, proposed: totalProposals, written: 0, changes }, null, 2),
          );
          return;
        }
        console.log(`\nProposed relations (${totalProposals} total):\n`);
        for (const { atom, proposals } of changeMap.values()) {
          console.log(`  ${atom.frontmatter.id}`);
          for (const p of proposals) {
            console.log(`    --[${p.relation.type}]--> ${p.relation.target}  (from ${p.source})`);
          }
        }
        console.log(`\nRun with --apply to write these changes.`);
        return;
      }

      // --apply: write changes
      let written = 0;
      for (const { atom, proposals } of changeMap.values()) {
        const existing = atom.frontmatter.relations ?? [];
        atom.frontmatter.relations = [
          ...existing,
          ...proposals.map((p) => p.relation),
        ];

        if (atom.filePath) {
          writeAtom(atom, atom.filePath);
          if (indexExists(memoryDir)) {
            indexAtom(memoryDir, atom);
          }
          written++;
        }
      }

      if (opts.json) {
        console.log(
          JSON.stringify({ dry_run: false, proposed: totalProposals, written, changes: [] }, null, 2),
        );
        return;
      }
      console.log(`✓ Migrated ${totalProposals} relations across ${written} atoms.`);
    });
}
