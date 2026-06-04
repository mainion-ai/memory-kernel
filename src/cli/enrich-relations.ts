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
import { resolveDir } from './resolve-dir.js';
import { exitWithError } from './cli-util.js';
import { enrichRelations } from '../enrich-relations.js';

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
    .option('--ollama-url <url>', 'Ollama API base URL', 'http://localhost:11434')
    .option('--model <model>', 'Model name (Ollama or Anthropic)', 'qwen2.5:14b-instruct-q4_K_M')
    .option('--min-confidence <n>', 'Minimum confidence threshold', '0.7')
    .option('--provider <provider>', 'LLM provider: ollama or anthropic', 'ollama')
    .option('--api-key <key>', 'API key (required for anthropic provider)')
    .option('--base-url <url>', 'API base URL override (for anthropic provider)')
    .option('--json', 'Output as JSON')
    .action(async (opts: {
      dir: string;
      dryRun?: boolean;
      apply?: boolean;
      ollamaUrl: string;
      model: string;
      minConfidence: string;
      provider: string;
      apiKey?: string;
      baseUrl?: string;
      json?: boolean;
    }) => {
      if (!opts.dryRun && !opts.apply) {
        exitWithError('Specify --dry-run to preview or --apply to write changes.', opts.json);
      }

      const memoryDir = resolveDir(opts.dir, program.opts().agent);
      if (!fs.existsSync(memoryDir)) {
        exitWithError(`Memory directory not found: ${memoryDir}`, opts.json);
      }

      const minConfidence = parseFloat(opts.minConfidence);
      if (isNaN(minConfidence) || minConfidence < 0 || minConfidence > 1) {
        exitWithError('--min-confidence must be a number between 0 and 1.', opts.json);
      }

      if (opts.provider !== 'ollama' && opts.provider !== 'anthropic') {
        exitWithError('--provider must be "ollama" or "anthropic".', opts.json);
      }

      if (opts.provider === 'anthropic' && !opts.apiKey) {
        // Try environment variable as fallback
        const envKey = process.env.ANTHROPIC_API_KEY;
        if (!envKey) {
          exitWithError('--api-key is required for anthropic provider (or set ANTHROPIC_API_KEY).', opts.json);
        }
        opts.apiKey = envKey;
      }

      const result = await enrichRelations(memoryDir, {
        dryRun: !!opts.dryRun,
        ollamaUrl: opts.ollamaUrl,
        model: opts.model,
        minConfidence,
        provider: opts.provider as 'ollama' | 'anthropic',
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
        onProgress: opts.json ? undefined : (current, total) => {
          process.stderr.write(`Processing ${current}/${total}...\n`);
        },
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
