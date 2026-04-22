/**
 * CLI command: mk consolidate
 *
 * Reviews and promotes auto-extracted draft atoms to active status.
 * This is the lifecycle completion step for `mk extract`.
 *
 * Usage:
 *   mk consolidate [options]
 */

import fs from 'fs';
import type { Command } from 'commander';
import { resolveDir } from './resolve-dir.js';
import { consolidateAtoms } from '../consolidate.js';
import type { ConsolidateAtomResult } from '../types.js';
import { ATOM_TYPES } from '../types.js';

/** JSON-aware error exit: emits structured JSON when --json is active, plain text otherwise. */
function exitWithError(message: string, json?: boolean): never {
  if (json) {
    console.log(JSON.stringify({ error: message }, null, 2));
  } else {
    console.error(`✗ ${message}`);
  }
  process.exit(1);
}

const STATUS_ICONS: Record<ConsolidateAtomResult['status'], string> = {
  promoted: '✓',
  skipped: '~',
  error: '✗',
  would_promote: '✓',
  would_skip: '~',
};

function padRight(str: string, len: number): string {
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
}

export function registerConsolidateCommand(program: Command): void {
  program
    .command('consolidate')
    .description('Review and promote auto-extracted draft atoms to active status')
    .option('-d, --dir <path>', 'Memory directory', './memory')
    .option('--all', 'Process all draft atoms, not just auto-extracted ones')
    .option('--dry-run', 'Preview what would happen without writing')
    .option('--json', 'Output structured JSON')
    .option('--type <type>', `Filter by atom type (${ATOM_TYPES.join(', ')})`)
    .option('--limit <n>', 'Max atoms to process (default: 50)', '50')
    .option('--agent-id <id>', 'Agent ID for promoted atoms')
    .option('--session-id <id>', 'Session ID for promoted atoms')
    .option('--duplicate-threshold <n>', 'BM25 rank threshold for duplicate detection (default: -2.0)', '-2.0')
    .action(async (opts: {
      dir: string;
      all?: boolean;
      dryRun?: boolean;
      json?: boolean;
      type?: string;
      limit?: string;
      agentId?: string;
      sessionId?: string;
      duplicateThreshold?: string;
    }) => {
      const memoryDir = resolveDir(opts.dir, program.opts().agent);
      if (!fs.existsSync(memoryDir)) {
        exitWithError(`Memory directory not found: ${memoryDir}`, opts.json);
      }

      const limit = parseInt(opts.limit ?? '50', 10);
      if (isNaN(limit) || limit < 1) {
        exitWithError('--limit must be a positive integer', opts.json);
      }

      const duplicateThreshold = parseFloat(opts.duplicateThreshold ?? '-2.0');
      if (isNaN(duplicateThreshold)) {
        exitWithError('--duplicate-threshold must be a number', opts.json);
      }

      // Validate type if provided
      if (opts.type && !ATOM_TYPES.includes(opts.type as typeof ATOM_TYPES[number])) {
        exitWithError(
          `Invalid atom type: ${opts.type}. Valid types: ${ATOM_TYPES.join(', ')}`,
          opts.json,
        );
      }

      try {
        const result = await consolidateAtoms({
          memoryDir,
          agentId: opts.agentId,
          sessionId: opts.sessionId,
          dryRun: opts.dryRun,
          all: opts.all,
          type: opts.type as typeof ATOM_TYPES[number] | undefined,
          limit,
          duplicateThreshold,
        });

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        // Plain text output
        if (result.processed === 0) {
          const scope = opts.all ? 'draft atoms' : 'auto-extracted draft atoms';
          console.log(`No ${scope} to process.`);
          return;
        }

        const dryRunNote = opts.dryRun ? ' (dry run — no files written)' : '';
        const action = opts.dryRun ? 'Would process' : 'Processed';
        console.log(`\n${action} ${result.processed} draft atom(s)${dryRunNote}:\n`);

        for (const atom of result.atoms) {
          const icon = STATUS_ICONS[atom.status];
          const idDisplay = padRight(atom.atom_id, 42);
          const typeDisplay = padRight(`[${atom.type}]`, 20);

          if (atom.status === 'promoted' || atom.status === 'would_promote') {
            console.log(`  ${icon} ${idDisplay} ${typeDisplay} ${atom.title}`);
          } else if (atom.status === 'skipped' || atom.status === 'would_skip') {
            const dupNote = atom.possible_duplicate_of
              ? `possible duplicate of ${atom.possible_duplicate_of}`
              : (atom.reason ?? 'skipped');
            console.log(`  ${icon} ${idDisplay} ${typeDisplay} ${atom.title} [${dupNote}]`);
          } else if (atom.status === 'error') {
            console.log(`  ${icon} ${idDisplay} ${typeDisplay} ${atom.title} [error: ${atom.reason ?? 'unknown'}]`);
          }
        }

        console.log('');
        if (opts.dryRun) {
          console.log(`  Would promote: ${result.promoted}`);
          console.log(`  Would skip:    ${result.skipped}`);
          if (result.errors > 0) console.log(`  Errors:        ${result.errors}`);
          console.log('\nRun without --dry-run to apply changes.');
        } else {
          console.log(`  Promoted: ${result.promoted}`);
          console.log(`  Skipped:  ${result.skipped}`);
          if (result.errors > 0) console.log(`  Errors:   ${result.errors}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        exitWithError(msg, opts.json);
      }
    });
}
