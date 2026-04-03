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
    .action((opts: { dir: string; dryRun?: boolean; apply?: boolean }) => {
      if (!opts.dryRun && !opts.apply) {
        console.error('✗ Specify --dry-run to preview or --apply to write changes.');
        process.exit(1);
      }

      const memoryDir = path.resolve(opts.dir);
      if (!fs.existsSync(memoryDir)) {
        console.error(`✗ Memory directory not found: ${memoryDir}`);
        process.exit(1);
      }

      const result = relinkAll(memoryDir, { dryRun: !!opts.dryRun });

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
