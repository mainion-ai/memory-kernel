/**
 * CLI command: mk extract
 *
 * Extracts atoms from a conversation log file using LLM inference.
 *
 * Usage:
 *   mk extract <log-path> [options]
 */

import fs from 'fs';
import path from 'path';
import type { Command } from 'commander';
import { resolveDir } from './resolve-dir.js';
import { exitWithError } from './cli-util.js';
import { extractFromLog, ExtractInputTooLargeError } from '../extract.js';
import type { ExtractedAtomResult } from '../types.js';

const STATUS_ICONS: Record<ExtractedAtomResult['status'] | 'skipped', string> = {
  new: '✓',
  possible_duplicate: '~',
  skipped: '-',
};

function padRight(str: string, len: number): string {
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
}

export function registerExtractCommand(program: Command): void {
  program
    .command('extract')
    .description('Extract atoms from a conversation log using LLM')
    .argument('<log-path>', 'Path to the conversation log file')
    .option('-d, --dir <path>', 'Memory directory', './memory')
    .option('--agent-id <id>', 'Agent ID for new atoms')
    .option('--session-id <id>', 'Session ID to tag extracted atoms')
    .option('--dry-run', 'Preview extractions without writing')
    .option('--json', 'Output structured JSON')
    .option('--model <model>', 'LLM model: omit for claude -p (default), or Ollama model e.g. "qwen2.5:14b"')
    .option('--max-atoms <n>', 'Max atoms to extract per run', '20')
    .option('--skip-lines <n>', 'Skip first N lines (e.g. to skip CLAUDE.md preamble)', '0')
    .option('--no-conflict-detect', 'Disable Tier-1+Tier-2 semantic conflict detection during ingestion')
    .option('--conflict-confirm-model <model>', 'LLM model used for Tier-2 conflict confirmation (default: same as --model)')
    .option('--preference-pass', 'Run a dedicated second LLM pass focused exclusively on preference extraction, enforcing specific vocabulary preservation')
    .option('--max-input-chars <n>', 'Max characters for the assembled prompt (system + user); over-budget input fails (exit 2) unless --truncate')
    .option('--truncate', 'Truncate oversized input to fit the size budget instead of failing (oldest/head content dropped, newest kept, a marker prepended)')
    .action(async (logPath: string, opts: {
      dir: string;
      agentId?: string;
      sessionId?: string;
      dryRun?: boolean;
      json?: boolean;
      model?: string;
      maxAtoms?: string;
      skipLines?: string;
      conflictDetect?: boolean;
      conflictConfirmModel?: string;
      preferencePass?: boolean;
      maxInputChars?: string;
      truncate?: boolean;
    }) => {
      const resolvedLog = path.resolve(logPath);
      if (!fs.existsSync(resolvedLog)) {
        exitWithError(`Log file not found: ${resolvedLog}`, opts.json);
      }

      const memoryDir = resolveDir(opts.dir, program.opts().agent);
      if (!fs.existsSync(memoryDir)) {
        exitWithError(`Memory directory not found: ${memoryDir}`, opts.json);
      }

      const maxAtoms = parseInt(opts.maxAtoms ?? '20', 10);
      if (isNaN(maxAtoms) || maxAtoms < 1) {
        exitWithError('--max-atoms must be a positive integer', opts.json);
      }

      const skipLines = parseInt(opts.skipLines ?? '0', 10);
      if (isNaN(skipLines) || skipLines < 0) {
        exitWithError('--skip-lines must be a non-negative integer', opts.json);
      }

      let maxInputChars: number | undefined;
      if (opts.maxInputChars !== undefined) {
        const parsed = Number(opts.maxInputChars);
        if (!Number.isInteger(parsed) || parsed < 1) {
          exitWithError('--max-input-chars must be a positive integer', opts.json);
        }
        maxInputChars = parsed;
      }

      try {
        const result = await extractFromLog({
          logPath: resolvedLog,
          memoryDir,
          agentId: opts.agentId,
          sessionId: opts.sessionId,
          dryRun: opts.dryRun,
          model: opts.model,
          maxAtoms,
          skipLines,
          conflictDetect: opts.conflictDetect,
          conflictConfirmModel: opts.conflictConfirmModel,
          preferencePass: opts.preferencePass,
          maxInputChars,
          truncate: opts.truncate,
        });

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        // Plain text output
        const logName = path.basename(resolvedLog);

        if (result.truncation) {
          const t = result.truncation;
          console.log(
            `⚠ input truncated: sent ${t.sent_chars} of ${t.original_chars} chars (${t.omitted_chars} omitted from the beginning)`,
          );
        }

        if (result.atoms.length === 0 && result.skipped === 0) {
          console.log(`Nothing extracted from ${logName}`);
          return;
        }

        const dryRunNote = opts.dryRun ? ' (dry run — no files written)' : '';
        console.log(`\nExtracted ${result.extracted} atoms from ${logName}${dryRunNote}:\n`);

        for (const atom of result.atoms) {
          const icon = STATUS_ICONS[atom.status];
          const idDisplay = atom.atom_id
            ? padRight(atom.atom_id, 40)
            : padRight(`(${atom.type}:${atom.slug})`, 40);

          if (atom.status === 'skipped') {
            console.log(`  ${icon} ${idDisplay} [skipped — ${atom.reason ?? 'unknown'}]`);
          } else if (atom.status === 'possible_duplicate') {
            console.log(
              `  ${icon} ${idDisplay} [possible duplicate — similar to ${atom.possible_duplicate_of ?? 'existing atom'}]`,
            );
          } else {
            console.log(`  ${icon} ${idDisplay} [new]`);
          }
        }

        if (result.conflicts > 0) {
          console.log(`\n  ${result.conflicts} auto-superseded by conflict detection`);
          for (const a of result.atoms) {
            for (const c of a.conflicts ?? []) {
              if (c.action === 'superseded' || c.action === 'would_supersede') {
                console.log(`    ↳ ${c.new_atom_id} supersedes ${c.old_atom_id} (${c.subject}.${c.predicate})`);
              }
            }
          }
        }

        if (result.skipped > 0) {
          console.log(`\n  ${result.skipped} skipped (slug collision or invalid type)`);
        }

        if (opts.dryRun) {
          console.log('\nRun without --dry-run to write atoms.');
        }
      } catch (err) {
        // Distinguishable signal for oversized input: exit code 2 + a structured
        // JSON payload, so a cron wrapper can branch on it (retry with --truncate
        // / --skip-lines) instead of treating it as a generic crash.
        if (err instanceof ExtractInputTooLargeError) {
          if (opts.json) {
            console.log(
              JSON.stringify(
                {
                  error: err.message,
                  reason: 'input_too_large',
                  exit_code: 2,
                  input_chars: err.inputChars,
                  limit: err.limit,
                },
                null,
                2,
              ),
            );
          } else {
            console.error(`✗ ${err.message}`);
          }
          process.exit(2);
        }
        const msg = err instanceof Error ? err.message : String(err);
        exitWithError(msg, opts.json);
      }
    });
}
