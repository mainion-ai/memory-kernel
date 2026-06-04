/**
 * CLI command for mk lint — semantic health checking.
 */

import fs from 'fs';
import type { Command } from 'commander';
import { resolveDir } from './resolve-dir.js';
import { exitWithError } from './cli-util.js';
import { lintMemoryStore } from '../lint.js';
import type { LintFinding } from '../lint.js';

const CATEGORY_LABELS: Record<LintFinding['category'], string> = {
  contradiction: 'Contradictions',
  stale: 'Stale atoms',
  orphan: 'Orphaned atoms',
  duplicate: 'Near-duplicates',
  confidence_drift: 'Confidence drift',
  ttl_warning: 'TTL warnings',
};

const SEVERITY_ICONS: Record<LintFinding['severity'], string> = {
  warning: '⚠',
  info: 'ℹ',
};

export function registerLintCommand(program: Command): void {
  program
    .command('lint')
    .description('Check semantic health of the memory store')
    .option('-d, --dir <dir>', 'Memory directory', './memory')
    .option('--json', 'Output as JSON')
    .option('--stale-days <n>', 'Days before fact/decision is stale', '90')
    .option('--fix', 'Auto-fix issues (placeholder)')
    .action((opts: { dir: string; json?: boolean; staleDays?: string; fix?: boolean }) => {
      const memoryDir = resolveDir(opts.dir, program.opts().agent);
      if (!fs.existsSync(memoryDir)) {
        exitWithError(`Memory directory not found: ${memoryDir}`, opts.json);
      }

      const staleDays = parseInt(opts.staleDays ?? '90', 10);
      if (isNaN(staleDays) || staleDays < 1) {
        exitWithError('--stale-days must be a positive integer', opts.json);
      }

      if (opts.fix) {
        if (opts.json) {
          console.log(JSON.stringify({ warning: '--fix is not yet implemented' }));
        } else {
          console.warn('⚠ --fix is not yet implemented; running lint in read-only mode.\n');
        }
      }

      const result = lintMemoryStore(memoryDir, { staleDays });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      // Pretty-print
      console.log('🔍 Linting memory store...\n');

      if (result.findings.length === 0) {
        console.log('✓ No issues found.');
        return;
      }

      // Group findings by category (preserve order)
      const categories: LintFinding['category'][] = [
        'contradiction',
        'stale',
        'orphan',
        'duplicate',
        'confidence_drift',
        'ttl_warning',
      ];

      for (const cat of categories) {
        const catFindings = result.findings.filter((f) => f.category === cat);
        if (catFindings.length === 0) continue;

        console.log(`${CATEGORY_LABELS[cat]} (${catFindings.length}):`);
        for (const f of catFindings) {
          console.log(`  ${SEVERITY_ICONS[f.severity]} ${f.message}`);
        }
        console.log();
      }

      console.log(
        `Summary: ${result.summary.total} finding${result.summary.total === 1 ? '' : 's'} (${result.summary.warnings} warning${result.summary.warnings === 1 ? '' : 's'}, ${result.summary.info} info)`,
      );
    });
}
