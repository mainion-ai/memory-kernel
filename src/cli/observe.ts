/**
 * CLI command: mk observe
 *
 * Extracts compressed observations from a conversation log using LLM.
 * Appends observations to {memoryDir}/observations.md.
 *
 * Usage:
 *   mk observe <log-path> [options]
 */

import fs from 'fs';
import path from 'path';
import type { Command } from 'commander';
import { resolveDir } from './resolve-dir.js';
import { observeConversation } from '../observe.js';

/** JSON-aware error exit: emits structured JSON when --json is active, plain text otherwise. */
function exitWithError(message: string, json?: boolean): never {
  if (json) {
    console.log(JSON.stringify({ error: message }, null, 2));
  } else {
    console.error(`\u2717 ${message}`);
  }
  process.exit(1);
}

export function registerObserveCommand(program: Command): void {
  program
    .command('observe')
    .description('Extract observations from a conversation log using LLM')
    .argument('<log-path>', 'Path to the conversation log file')
    .option('-d, --dir <path>', 'Memory directory', './memory')
    .option('--session-date <date>', 'Session date label (default: today, YYYY-MM-DD)')
    .option('--model <model>', 'LLM model: omit for claude -p (default), or Ollama model e.g. "qwen2.5:14b"')
    .option('--temperature <n>', 'LLM temperature (0.0-1.0)', '0.3')
    .option('--max-tokens <n>', 'Max tokens for LLM response', '2000')
    .option('--skip-lines <n>', 'Skip first N lines (e.g. to skip CLAUDE.md preamble)', '0')
    .option('--dry-run', 'Preview observations without writing')
    .option('--json', 'Output structured JSON')
    .action(async (logPath: string, opts: {
      dir: string;
      sessionDate?: string;
      model?: string;
      temperature?: string;
      maxTokens?: string;
      skipLines?: string;
      dryRun?: boolean;
      json?: boolean;
    }) => {
      const resolvedLog = path.resolve(logPath);
      if (!fs.existsSync(resolvedLog)) {
        exitWithError(`Log file not found: ${resolvedLog}`, opts.json);
      }

      const memoryDir = resolveDir(opts.dir, program.opts().agent);
      if (!fs.existsSync(memoryDir)) {
        exitWithError(`Memory directory not found: ${memoryDir}`, opts.json);
      }

      const temperature = parseFloat(opts.temperature ?? '0.3');
      if (isNaN(temperature) || temperature < 0 || temperature > 2) {
        exitWithError('--temperature must be a number between 0.0 and 2.0', opts.json);
      }

      const maxTokens = parseInt(opts.maxTokens ?? '2000', 10);
      if (isNaN(maxTokens) || maxTokens < 1) {
        exitWithError('--max-tokens must be a positive integer', opts.json);
      }

      const skipLines = parseInt(opts.skipLines ?? '0', 10);
      if (isNaN(skipLines) || skipLines < 0) {
        exitWithError('--skip-lines must be a non-negative integer', opts.json);
      }

      try {
        const result = await observeConversation({
          logPath: resolvedLog,
          memoryDir,
          sessionDate: opts.sessionDate,
          model: opts.model,
          temperature,
          maxTokens,
          dryRun: opts.dryRun,
          skipLines,
        });

        if (opts.json) {
          console.log(JSON.stringify({
            session_date: result.sessionDate,
            observations_path: result.observationsPath,
            written: result.written,
            observations: result.observations,
            dry_run: opts.dryRun ?? false,
          }, null, 2));
          return;
        }

        // Plain text output
        const logName = path.basename(resolvedLog);

        if (!result.observations.trim()) {
          console.log(`Nothing observed from ${logName} (conversation too short or empty)`);
          return;
        }

        const dryRunNote = opts.dryRun ? ' (dry run \u2014 not written)' : '';
        console.log(`\nObservations from ${logName} [${result.sessionDate}]${dryRunNote}:\n`);
        console.log(result.observations);

        if (result.written) {
          console.log(`\n\u2713 Appended to ${result.observationsPath}`);
        } else if (opts.dryRun) {
          console.log('\nRun without --dry-run to write observations.');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        exitWithError(msg, opts.json);
      }
    });
}
