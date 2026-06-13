import fs from 'fs';
import type { Command } from 'commander';
import { resolveDir } from './resolve-dir.js';
import { exitWithError } from './cli-util.js';
import { runUpgrade, type UpgradeResult } from '../upgrade.js';

/**
 * `mk upgrade --to <ver>` — host-side one-command agent upgrade (#331).
 *
 * Runs the whole sequence (install at the agent's MK_BIN → idempotent re-seed →
 * cron regen → doctor gate) and prints a single PASS/FAIL.
 */
export function registerUpgradeCommand(program: Command): void {
  program
    .command('upgrade')
    .description(
      'Host-side agent upgrade: install <ver> at the agent binary (MK_BIN), re-seed\n' +
      'lifecycle atoms idempotently, regenerate the cron wrapper, and gate on `mk doctor`.\n' +
      'Run this ON THE HOST (the agent cannot upgrade its own in-container binary), ideally\n' +
      'from the target version: `npx memory-kernel@<ver> upgrade --to <ver>`.',
    )
    .requiredOption('--to <version>', 'Target memory-kernel version to install at the agent binary')
    .option('-d, --dir <dir>', 'Agent kernel store to seed + doctor', './memory')
    .option('--mk-bin <path>', 'Path to the agent binary (defaults to the MK_BIN env var)')
    .option('--cron-wrapper <path>', 'Cron wrapper to regenerate via `mk init --cron --update`')
    .option('--dry-run', 'Report the plan and current doctor state without installing/seeding/regenerating')
    .option('--json', 'Output as JSON')
    .action(async (opts: {
      to: string;
      dir: string;
      mkBin?: string;
      cronWrapper?: string;
      dryRun?: boolean;
      json?: boolean;
    }) => {
      const memoryDir = resolveDir(opts.dir, program.opts().agent);
      if (!fs.existsSync(memoryDir)) {
        exitWithError(`Memory directory not found: ${memoryDir}\n  Run "mk init" first.`, opts.json);
      }

      let result: UpgradeResult;
      try {
        result = await runUpgrade({
          to: opts.to,
          memoryDir,
          // The version of THIS mk — its bundled seed set + doctor gate are what
          // validate the upgrade, so runUpgrade hard-fails if it ≠ --to.
          runningVersion: program.version() || undefined,
          mkBin: opts.mkBin,
          cronWrapper: opts.cronWrapper,
          dryRun: opts.dryRun,
          env: process.env,
        });
      } catch (err) {
        exitWithError(err instanceof Error ? err.message : String(err), opts.json);
        return; // unreachable
      }

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const banner = result.dry_run ? '[dry-run] ' : '';
        console.log(`${banner}mk upgrade → memory-kernel@${result.to}`);
        for (const s of result.steps) {
          const mark = s.skipped ? '–' : s.ok ? '✓' : '✗';
          console.log(`  ${mark} ${s.step}: ${s.detail}`);
        }
        if (result.doctor?.issues.length) {
          console.log('  doctor:');
          for (const line of result.doctor.issues) console.log(`      ${line}`);
        }
        console.log(result.pass ? `\n✓ PASS — agent on ${result.to}, doctor clean` : `\n✗ FAIL — see steps above`);
      }

      // Non-zero exit on failure so a host wrapper / CI can gate on it.
      if (!result.pass) process.exit(1);
    });
}
