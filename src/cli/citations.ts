/**
 * CLI command: mk citations
 *
 * Extracts concept-name and atom-ID citations across all atoms and
 * stores them in the SQLite index. Used by wander for ACT-R
 * base-level activation (frequency component).
 *
 * Usage:
 *   mk citations -d <memory-dir>           # Extract and index citations
 *   mk citations -d <memory-dir> --json    # Output as JSON
 */

import fs from 'fs';
import path from 'path';
import type { Command } from 'commander';
import { resolveDir } from './resolve-dir.js';
import { indexCitations } from '../citations.js';

export function registerCitationsCommand(program: Command): void {
  program
    .command('citations')
    .description(
      'Extract concept-name and atom-ID citations across all atoms.\n' +
      'Stores citation counts in the SQLite index for wander activation.',
    )
    .option('-d, --dir <dir>', 'Memory directory', './memory')
    .option('--json', 'Output as JSON')
    .action((opts: { dir: string; json?: boolean }) => {
      const memoryDir = resolveDir(opts.dir, program.opts().agent);
      if (!fs.existsSync(memoryDir)) {
        console.error(`✗ Memory directory not found: ${memoryDir}`);
        process.exit(1);
      }

      const result = indexCitations(memoryDir);

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`\n✓ Citations indexed:`);
      console.log(`  Total mentions: ${result.total}`);
      console.log(`    atom-ID refs: ${result.byType.atom_id}`);
      console.log(`    concept-name refs: ${result.byType.concept_name}`);
      console.log(`  Unique targets cited: ${result.uniqueTargets}`);

      if (result.topCited.length > 0) {
        console.log(`\n  Top cited:`);
        for (const { atomId, count } of result.topCited) {
          console.log(`    ${count.toString().padStart(4)} │ ${atomId}`);
        }
      }
    });
}
