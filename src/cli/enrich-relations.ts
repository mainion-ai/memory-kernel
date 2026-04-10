/**
 * CLI command: mk enrich-relations
 *
 * Uses an LLM to reclassify 'related' edges into more specific types.
 * Supports Claude (Anthropic API) and Ollama (local) backends.
 *
 * Usage:
 *   mk enrich-relations -d <memory-dir> --dry-run              # Preview with Claude
 *   mk enrich-relations -d <memory-dir> --apply --backend ollama  # Apply with Ollama
 *   mk enrich-relations -d <memory-dir> --apply --recheck      # Re-check all edges
 */

import fs from 'fs';
import path from 'path';
import type { Command } from 'commander';
import { enrichRelations, type EnrichBackend } from '../enrich-relations.js';

export function registerEnrichRelationsCommand(program: Command): void {
  program
    .command('enrich-relations')
    .description(
      'Use an LLM to reclassify relation edges into specific types.\n' +
      'By default, only reclassifies \'related\' edges. Use --recheck for all.',
    )
    .option('-d, --dir <dir>', 'Memory directory', './memory')
    .option('--dry-run', 'Preview proposed changes without writing')
    .option('--apply', 'Write reclassified relations to atom frontmatter')
    .option(
      '--backend <backend>',
      'LLM backend: claude or ollama',
      'claude',
    )
    .option('--model <model>', 'Model name (default: claude-haiku-4-20250414 or llama3.2)')
    .option('--ollama-url <url>', 'Ollama server URL', 'http://localhost:11434')
    .option('--recheck', 'Re-check all edges, not just \'related\' ones')
    .action(
      async (opts: {
        dir: string;
        dryRun?: boolean;
        apply?: boolean;
        backend?: string;
        model?: string;
        ollamaUrl?: string;
        recheck?: boolean;
      }) => {
        if (!opts.dryRun && !opts.apply) {
          console.error(
            '✗ Specify --dry-run to preview or --apply to write changes.',
          );
          process.exit(1);
        }

        const memoryDir = path.resolve(opts.dir);
        if (!fs.existsSync(memoryDir)) {
          console.error(`✗ Memory directory not found: ${memoryDir}`);
          process.exit(1);
        }

        const backend = (opts.backend ?? 'claude') as EnrichBackend;
        if (backend !== 'claude' && backend !== 'ollama') {
          console.error(`✗ Unknown backend: ${backend}. Use 'claude' or 'ollama'.`);
          process.exit(1);
        }

        console.log(
          `\nEnriching relations (${opts.dryRun ? 'dry run' : 'apply'}) ` +
          `with ${backend}${opts.model ? ` (${opts.model})` : ''}...\n`,
        );

        const result = await enrichRelations({
          memoryDir,
          backend,
          model: opts.model,
          ollamaUrl: opts.ollamaUrl,
          dryRun: !!opts.dryRun,
          recheck: opts.recheck,
          onProgress: (done, total) => {
            process.stdout.write(`\r  Progress: ${done}/${total}`);
          },
        });

        // Clear progress line
        if (result.total > 0) process.stdout.write('\n\n');

        if (result.total === 0) {
          console.log('✓ No edges to enrich.');
          return;
        }

        if (result.changes.length > 0) {
          console.log(`Changes (${result.changed}):\n`);
          for (const c of result.changes) {
            console.log(`  ${c.sourceId}`);
            console.log(`    ${c.oldType} → ${c.newType}`);
            console.log(`    ${c.reasoning}`);
            console.log();
          }
        }

        console.log(
          `Summary: ${result.total} edges, ` +
          `${result.changed} changed, ` +
          `${result.kept} kept, ` +
          `${result.errors} errors`,
        );

        if (opts.dryRun && result.changed > 0) {
          console.log('\nRun with --apply to write these changes.');
        }
      },
    );
}
