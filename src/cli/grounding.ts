/**
 * CLI command for `mk grounding` — confidence-vs-usage reconciliation (advisory).
 *
 * Read-only: derives a usage `grounding_score` from the event log and bins each
 * atom into a 2×2 `prior × grounding` quadrant. Never writes atom files. The
 * destructive write-back (updating `confidence`) is Phase 2, gated on #247.
 */

import fs from 'fs';
import type { Command } from 'commander';
import { resolveDir } from './resolve-dir.js';
import { exitWithError } from './cli-util.js';
import { listAtoms } from '../store.js';
import { readEvents } from '../event-log.js';
import { computeGrounding, DEFAULT_PRIOR_THRESHOLD, DEFAULT_GROUNDING_THRESHOLD } from '../grounding.js';
import type { GroundingQuadrant, GroundingReport } from '../grounding.js';
import { reconcileGrounding } from '../reconcile.js';

const QUADRANT_LABELS: Record<GroundingQuadrant, string> = {
  'well-grounded': 'Well-grounded (confidence matches use)',
  review: 'Review (stated confidently, not validated by use)',
  promote: 'Promote (written cautiously, grounded by use)',
  noise: 'Noise (low confidence, low use)',
};

// Actionable quadrants first, then the inert one.
const QUADRANT_ORDER: GroundingQuadrant[] = ['review', 'promote', 'noise', 'well-grounded'];

function fmt(n: number): string {
  return n.toFixed(2);
}

function parseThreshold(raw: string | undefined, fallback: number, flag: string, json?: boolean): number {
  if (raw === undefined) return fallback;
  const v = Number(raw);
  if (Number.isNaN(v) || v < 0 || v > 1) {
    exitWithError(`${flag} must be a number between 0 and 1`, json);
  }
  return v;
}

export function registerGroundingCommand(program: Command): void {
  program
    .command('grounding')
    .description('Reconcile atom confidence (prior) against usage grounding. Advisory by default; --apply writes back')
    .option('-d, --dir <dir>', 'Memory directory', './memory')
    .option('--json', 'Output as JSON')
    .option('--prior-threshold <n>', 'Confidence threshold for the high/low prior split (0–1)')
    .option('--grounding-threshold <n>', 'Grounding threshold for the high/low split (0–1)')
    .option('--actionable-only', 'Show only atoms flagged actionable')
    .option('--include-all', 'Include non-active atoms and conflict-type atoms (default: active, non-conflict only)')
    .option('--apply', 'Write reconciled confidence back to review/promote atoms (#364). Emits atom_reconciled events')
    .option('--dry-run', 'With --apply: preview the write-back without mutating files or emitting events')
    .option('--override', 'With --apply: also adjust atoms a human has edited (default: skip human_edit-touched atoms)')
    .option('--agent-id <id>', 'Agent ID recorded on emitted atom_reconciled events', 'cli')
    .option('--session-id <id>', 'Session ID recorded on emitted atom_reconciled events', 'mk-grounding')
    .action(
      (opts: {
        dir: string;
        json?: boolean;
        priorThreshold?: string;
        groundingThreshold?: string;
        actionableOnly?: boolean;
        includeAll?: boolean;
        apply?: boolean;
        dryRun?: boolean;
        override?: boolean;
        agentId: string;
        sessionId: string;
      }) => {
        const memoryDir = resolveDir(opts.dir, program.opts().agent);
        if (!fs.existsSync(memoryDir)) {
          exitWithError(`Memory directory not found: ${memoryDir}`, opts.json);
        }

        // --dry-run / --override only modify the write-back; without --apply the
        // command silently runs the read-only report, so a forgotten --apply
        // would masquerade as a previewed write-back. Fail loudly instead.
        if ((opts.dryRun || opts.override) && !opts.apply) {
          exitWithError('--dry-run and --override only apply with --apply (the write-back path)', opts.json);
        }

        const priorThreshold = parseThreshold(opts.priorThreshold, DEFAULT_PRIOR_THRESHOLD, '--prior-threshold', opts.json);
        const groundingThreshold = parseThreshold(
          opts.groundingThreshold,
          DEFAULT_GROUNDING_THRESHOLD,
          '--grounding-threshold',
          opts.json,
        );

        // --- Phase 2 write-back path (#364) ---
        if (opts.apply) {
          const r = reconcileGrounding({
            memoryDir,
            agent_id: opts.agentId,
            session_id: opts.sessionId,
            dryRun: opts.dryRun,
            override: opts.override,
            grounding: { priorThreshold, groundingThreshold, includeAll: opts.includeAll },
          });

          if (opts.json) {
            console.log(JSON.stringify(r, null, 2));
            return;
          }

          const prefix = r.dry_run ? '[dry-run] ' : '';
          console.log(`⚖️  ${prefix}Grounding write-back (#364)\n`);
          if (r.changes.length === 0) {
            console.log('No confidence changes — no actionable review/promote atoms cleared the gates.');
          } else {
            for (const c of r.changes) {
              const arrow = c.delta < 0 ? '↓' : '↑';
              console.log(
                `  ${arrow} ${c.atom_id} [${c.type}] ${c.quadrant}: ` +
                  `${fmt(c.prior)} → ${fmt(c.reconciled_confidence)} ` +
                  `(grounding ${fmt(c.grounding_score)}, Δ ${c.delta >= 0 ? '+' : ''}${c.delta})`,
              );
            }
            console.log();
          }
          console.log(
            `Summary: ${r.candidates} candidate${r.candidates === 1 ? '' : 's'} · ` +
              `${prefix ? 'would apply' : 'applied'} ${r.changes.length} · ` +
              `skipped ${r.skipped_human_edit} human-edited, ${r.skipped_below_min_delta} below min-delta`,
          );
          return;
        }

        const atoms = listAtoms(memoryDir);
        const events = readEvents(memoryDir);
        const result = computeGrounding(atoms, events, {
          priorThreshold,
          groundingThreshold,
          includeAll: opts.includeAll,
        });

        const reports = opts.actionableOnly
          ? result.reports.filter((r) => r.actionable)
          : result.reports;

        if (opts.json) {
          // Keep the engine's full summary; `reports` reflects any --actionable-only
          // filter and `shown` makes the filtered row-count machine-readable so a
          // consumer never mistakes summary.total for the number of rows present.
          console.log(JSON.stringify({ ...result, reports, shown: reports.length }, null, 2));
          return;
        }

        console.log('⚖️  Grounding report (advisory — no atom files were modified)\n');

        if (result.summary.total === 0) {
          console.log('No gradeable atoms found (need active, non-conflict atoms).');
          return;
        }

        if (reports.length === 0) {
          // total > 0 but --actionable-only filtered everything out; note it, then
          // fall through to the (still useful) summary line below.
          console.log('No actionable atoms — every graded atom is well-grounded or below the action guards.\n');
        }

        const byQuadrant = new Map<GroundingQuadrant, GroundingReport[]>();
        for (const r of reports) {
          const arr = byQuadrant.get(r.quadrant);
          if (arr) arr.push(r);
          else byQuadrant.set(r.quadrant, [r]);
        }

        for (const q of QUADRANT_ORDER) {
          const rows = byQuadrant.get(q);
          if (!rows || rows.length === 0) continue;
          console.log(`${QUADRANT_LABELS[q]} — ${rows.length}:`);
          for (const r of rows) {
            const flag = r.actionable ? '→ ' : '  ';
            console.log(
              `  ${flag}${r.atom_id} [${r.type}]  prior ${fmt(r.prior)} · grounding ${fmt(r.grounding_score)}` +
                `  (reads ${r.inputs.n_access}/${r.inputs.session_diversity} sess` +
                `${r.inputs.n_conflict > 0 ? `, ${r.inputs.n_conflict} conflict` : ''})`,
            );
            console.log(`      ${r.reason}`);
          }
          console.log();
        }

        const q = result.summary.by_quadrant;
        console.log(
          `Summary: ${result.summary.total} atom${result.summary.total === 1 ? '' : 's'} graded · ` +
            `${result.summary.actionable} actionable · ` +
            `well-grounded ${q['well-grounded']}, review ${q.review}, promote ${q.promote}, noise ${q.noise}`,
        );
        console.log('\nAdvisory by default. Run with --apply to write reconciled confidence back to review/promote atoms (#364; --dry-run to preview).');
      },
    );
}
