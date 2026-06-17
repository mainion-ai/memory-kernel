/**
 * CLI commands for managing typed relations between atoms.
 * Phase 3: Relationship Edges
 */

import fs from 'fs';
import type { Command } from 'commander';
import { resolveDir } from './resolve-dir.js';
import {
  readAtom,
  writeAtom,
  indexExists,
  getRelationsForAtom,
} from '../index.js';
import { indexAtom } from '../index-db.js';
import { assertWithinDir } from '../store.js';
import { normalizeTimestamp } from '../format.js';
import { RELATION_TYPES } from '../types.js';
import type { Relation } from '../types.js';
import { exitWithError } from './cli-util.js';
import { findAtomFile } from '../atom-lookup.js';

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
      const memoryDir = resolveDir(opts.dir, program.opts().agent);
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

      try {
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
        atom.frontmatter.updated_at = normalizeTimestamp();

        // Defense-in-depth: sourceFile is derived from a user-supplied atom ID
        // via index lookup or scan; assert it lives under memoryDir before I/O.
        assertWithinDir(memoryDir, sourceFile);

        // Write updated atom
        writeAtom(atom, sourceFile);

        // Sync index if it exists
        if (indexExists(memoryDir)) {
          atom.filePath = sourceFile;
          indexAtom(memoryDir, atom);
        }
      } catch (err) {
        exitWithError(err instanceof Error ? err.message : String(err), opts.json);
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
      const memoryDir = resolveDir(opts.dir, program.opts().agent);
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

