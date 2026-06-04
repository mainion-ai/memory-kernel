/**
 * CLI command: mk relink
 *
 * Scans all atom bodies for cross-references to other atoms and creates
 * typed relation edges. Uses context words to infer relation type
 * (extends, supports, contradicts, etc.) — defaults to 'related'.
 *
 * Usage:
 *   mk relink -d <memory-dir> --dry-run    # Preview proposed relations
 *   mk relink -d <memory-dir> --apply       # Write relations to frontmatter
 */

import fs from 'fs';
import path from 'path';
import type { Command } from 'commander';
import { resolveDir } from './resolve-dir.js';
import { exitWithError } from './cli-util.js';
import { relinkAll } from '../relink.js';

export function registerRelinkCommand(program: Command): void {
  program
    .command('relink')
    .description(
      'Extract atom cross-references from body text and create relation edges.\n' +
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

      const result = relinkAll(memoryDir, { dryRun: !!opts.dryRun });

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              dry_run: !!opts.dryRun,
              proposed: result.proposed.length,
              applied: result.applied ?? 0,
              changes: result.proposed.map((p) => ({
                source_id: p.sourceId,
                target_id: p.targetId,
                type: p.type,
              })),
            },
            null,
            2,
          ),
        );
        return;
      }

      if (result.proposed.length === 0) {
        console.log('✓ No new relations found in body text.');
        return;
      }

      if (opts.dryRun) {
        console.log(`\nProposed relations (${result.proposed.length} total):\n`);

        // Group by source for readability
        const bySource = new Map<string, typeof result.proposed>();
        for (const p of result.proposed) {
          const list = bySource.get(p.sourceId) ?? [];
          list.push(p);
          bySource.set(p.sourceId, list);
        }

        for (const [sourceId, proposals] of bySource) {
          console.log(`  ${sourceId}`);
          for (const p of proposals) {
            console.log(`    --[${p.type}]--> ${p.targetId}`);
          }
        }

        console.log(`\nRun with --apply to write these changes.`);
        return;
      }

      // --apply
      console.log(
        `✓ Created ${result.proposed.length} relations across ${result.applied} atoms.`,
      );
    });
}
