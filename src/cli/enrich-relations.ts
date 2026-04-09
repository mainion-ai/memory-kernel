/**
 * CLI command: mk enrich-relations
 *
 * Reclassifies "related" edges using LLM inference via Ollama.
 *
 * Usage:
 *   mk enrich-relations -d <memory-dir> --dry-run    # Preview reclassifications
 *   mk enrich-relations -d <memory-dir> --apply       # Write reclassifications
 */

import fs from 'fs';
import path from 'path';
import type { Command } from 'commander';
import { enrichRelations } from '../enrich-relations.js';

function exitWithError(message: string, json?: boolean): never {
  if (json) {
    console.log(JSON.stringify({ error: message }, null, 2));
  } else {
    console.error(`✗ ${message}`);
  }
  process.exit(1);
}

export function registerEnrichRelationsCommand(program: Command): void {
  program
    .command('enrich-relations')
    .description(
      'Reclassify "related" edges using LLM inference.\n' +
      'Use --dry-run to preview, --apply to write changes.',
    )
    .option('-d, --dir <dir>', 'Memory directory', './memory')
    .option('--dry-run', 'Preview proposed reclassifications without writing')
    .option('--apply', 'Write reclassifications to atom frontmatter and reindex')
    .option('--ollama-url <url>', 'Ollama API base URL', 'http://192.168.1.213:11434')
    .option('--model <model>', 'Ollama model name', 'qwen2.5:14b-instruct-q4_K_M')
    .option('--min-confidence <n>', 'Minimum confidence threshold', '0.7')
    .option('--json', 'Output as JSON')
    .action(async (opts: {
      dir: string;
      dryRun?: boolean;
      apply?: boolean;
      ollamaUrl: string;
      model: string;
      minConfidence: string;
      json?: boolean;
    }) => {
      if (!opts.dryRun && !opts.apply) {
        exitWithError('Specify --dry-run to preview or --apply to write changes.', opts.json);
      }

      const memoryDir = path.resolve(opts.dir);
      if (!fs.existsSync(memoryDir)) {
        exitWithError(`Memory directory not found: ${memoryDir}`, opts.json);
      }

      const minConfidence = parseFloat(opts.minConfidence);
      if (isNaN(minConfidence) || minConfidence < 0 || minConfidence > 1) {
        exitWithError('--min-confidence must be a number between 0 and 1.', opts.json);
      }

      const result = await enrichRelations(memoryDir, {
        dryRun: !!opts.dryRun,
        ollamaUrl: opts.ollamaUrl,
        model: opts.model,
        minConfidence,
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.total_related === 0) {
        console.log('✓ No "related" edges found to enrich.');
        return;
      }

      if (result.proposals.length === 0) {
        console.log(`Scanned ${result.total_related} "related" edges — no reclassifications proposed.`);
        if (result.errors > 0) {
          console.log(`  (${result.errors} LLM errors encountered)`);
        }
        return;
      }

      if (opts.dryRun) {
        console.log(`\nProposed reclassifications (${result.proposals.length} of ${result.total_related} "related" edges):\n`);

        for (const p of result.proposals) {
          console.log(`  ${p.sourceId}`);
          console.log(`    related → ${p.newType} (confidence: ${p.confidence.toFixed(2)})`);
          console.log(`    → ${p.targetId}`);
          console.log(`    reason: ${p.reasoning}`);
          console.log();
        }

        console.log(`Kept as "related": ${result.kept_related}`);
        if (result.errors > 0) {
          console.log(`LLM errors: ${result.errors}`);
        }
        console.log(`\nRun with --apply to write these changes.`);
        return;
      }

      // --apply
      console.log(
        `✓ Applied ${result.applied} reclassifications out of ${result.proposals.length} proposals.`,
      );
      if (result.kept_related > 0) {
        console.log(`  Kept as "related": ${result.kept_related}`);
      }
      if (result.errors > 0) {
        console.log(`  LLM errors: ${result.errors}`);
      }
    });
}
