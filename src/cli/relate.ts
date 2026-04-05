/**
 * CLI commands for managing typed relations between atoms.
 * Phase 3: Relationship Edges
 */

import fs from 'fs';
import path from 'path';
import type { Command } from 'commander';
import {
  listAtomFiles,
  readAtom,
  writeAtom,
  indexExists,
  indexAtom,
  getRelationsForAtom,
  openIndex,
} from '../index.js';
import { RELATION_TYPES } from '../types.js';
import type { Relation } from '../types.js';

/** JSON-aware error exit: emits structured JSON when --json is active, plain text otherwise. */
function exitWithError(message: string, json?: boolean): never {
  if (json) {
    console.log(JSON.stringify({ error: message }, null, 2));
  } else {
    console.error(`✗ ${message}`);
  }
  process.exit(1);
}

/**
 * Register `mk relate <source-id> <relation-type> <target-id>` command.
 */
export function registerRelateCommand(program: Command): void {
  program
    .command('relate')
    .description(`Add a typed relation between two atoms.\nRelation types: ${RELATION_TYPES.join(', ')}`)
    .argument('<source-id>', 'Source atom ID')
    .argument('<relation-type>', 'Relation type (extends, contradicts, supports, caused_by, supersedes, related)')
    .argument('<target-id>', 'Target atom ID')
    .option('-d, --dir <dir>', 'Memory directory', './memory')
    .option('--json', 'Output as JSON')
    .action((sourceId: string, relationType: string, targetId: string, opts: { dir: string; json?: boolean }) => {
      const memoryDir = path.resolve(opts.dir);
      if (!fs.existsSync(memoryDir)) {
        exitWithError(`Memory directory not found: ${memoryDir}`, opts.json);
      }

      // Validate relation type
      if (!(RELATION_TYPES as readonly string[]).includes(relationType)) {
        exitWithError(`Invalid relation type: ${relationType}\n  Valid types: ${RELATION_TYPES.join(', ')}`, opts.json);
      }

      // Find source atom file
      const sourceFile = findAtomFile(memoryDir, sourceId);
      if (!sourceFile) {
        exitWithError(`Source atom not found: ${sourceId}`, opts.json);
      }

      // Warn if target atom doesn't exist (don't abort — target may not be indexed yet)
      const targetFile = findAtomFile(memoryDir, targetId);
      if (!targetFile) {
        process.stderr.write(`⚠ Target atom not found in index: ${targetId} (relation will be recorded but may not resolve)\n`);
      }

      // Read source atom and update relations
      const atom = readAtom(sourceFile);
      const existingRelations: Relation[] = atom.frontmatter.relations ?? [];

      // Idempotent: skip if (target, type) already exists
      const alreadyExists = existingRelations.some(
        (r) => r.target === targetId && r.type === relationType as Relation['type'],
      );
      if (alreadyExists) {
        if (opts.json) {
          console.log(JSON.stringify({ source_id: sourceId, relation_type: relationType, target_id: targetId, created: false }, null, 2));
          return;
        }
        console.log(`✓ Relation already exists: ${sourceId} --[${relationType}]--> ${targetId}`);
        return;
      }

      atom.frontmatter.relations = [
        ...existingRelations,
        { target: targetId, type: relationType as Relation['type'] },
      ];

      // Write updated atom
      writeAtom(atom, sourceFile);

      // Sync index if it exists
      if (indexExists(memoryDir)) {
        atom.filePath = sourceFile;
        indexAtom(memoryDir, atom);
      }

      if (opts.json) {
        console.log(JSON.stringify({ source_id: sourceId, relation_type: relationType, target_id: targetId, created: true }, null, 2));
        return;
      }

      console.log(`✓ Related: ${sourceId} --[${relationType}]--> ${targetId}`);
    });
}

/**
 * Register `mk relations <atom-id>` command.
 */
export function registerRelationsCommand(program: Command): void {
  program
    .command('relations')
    .description("Show an atom's inbound and outbound relations")
    .argument('<atom-id>', 'Atom ID')
    .option('-d, --dir <dir>', 'Memory directory', './memory')
    .option('--json', 'Output as JSON')
    .action((atomId: string, opts: { dir: string; json?: boolean }) => {
      const memoryDir = path.resolve(opts.dir);
      if (!fs.existsSync(memoryDir)) {
        exitWithError(`Memory directory not found: ${memoryDir}`, opts.json);
      }

      if (!indexExists(memoryDir)) {
        exitWithError('No index found. Run `mk reindex` first.', opts.json);
      }

      const { outbound, inbound } = getRelationsForAtom(memoryDir, atomId);

      if (opts.json) {
        console.log(JSON.stringify({ atom_id: atomId, outbound, inbound }, null, 2));
        return;
      }

      if (outbound.length === 0 && inbound.length === 0) {
        console.log(`No relations found for ${atomId}`);
        return;
      }

      if (outbound.length > 0) {
        console.log(`\nOutbound (${atomId} →):`);
        for (const rel of outbound) {
          console.log(`  --[${rel.relation_type}]--> ${rel.target_id}`);
        }
      }

      if (inbound.length > 0) {
        console.log(`\nInbound (→ ${atomId}):`);
        for (const rel of inbound) {
          console.log(`  ${rel.source_id} --[${rel.relation_type}]-->`);
        }
      }
    });
}

/**
 * Find an atom's file path by ID.
 * Queries index first; falls back to full file scan.
 */
function findAtomFile(memoryDir: string, atomId: string): string | null {
  if (indexExists(memoryDir)) {
    try {
      const db = openIndex(memoryDir);
      const row = db.prepare('SELECT file_path FROM atoms WHERE atom_id = ?').get(atomId) as
        | { file_path: string }
        | undefined;
      if (row?.file_path) return row.file_path;
    } catch { /* fall through to file scan */ }
  }

  // File scan fallback
  const files = listAtomFiles(memoryDir);
  for (const fp of files) {
    try {
      const atom = readAtom(fp);
      if (atom.frontmatter.id === atomId) return fp;
    } catch { /* skip corrupted files */ }
  }
  return null;
}
