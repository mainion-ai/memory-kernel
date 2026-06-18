#!/usr/bin/env node

/**
 * mk — Memory Kernel CLI
 *
 * Usage:
 *   mk init [dir]              Initialize a memory directory
 *   mk checkpoint              Generate a checkpoint/handoff
 *   mk recall [--task "..."]   Load relevant context
 *   mk reflect                 Consolidate, TTL, promote, dedup
 *   mk edit <id>               Edit an atom in $EDITOR, record a human_edit event
 *   mk gc                      Archive expired atoms
 *   mk doctor                  Validate schema, links, conflicts
 *   mk status                  Show memory stats
 *   mk wander                  Explore memory via spreading activation
 *   mk closure                 Compute operational closure metrics
 *   mk observe <log>            Extract observations from a conversation log
 */

import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8'));
import {
  initMemoryDir,
  listAtoms,
  countEvents,
  readEvents,
  validateAtomFrontmatter,
  reindex,
  indexStats,
  indexExists,
  createAtom,
  embeddingStats,
} from '../index.js';
import { isValidTag, normalizeTags } from '../format.js';
import { recall, recallWithEmbeddings } from '../recall.js';
import { reflect } from '../reflect.js';
import { checkpoint } from '../checkpoint.js';
import { bootstrapEvents } from '../bootstrap.js';
import { replayFromFile } from '../replay.js';
import { compactLog } from '../event-log.js';
import { writeEpisode, listEpisodes } from '../episodes.js';
import { mergeEventLogs } from '../merge.js';
import { importFromFile, previewImport } from '../import.js';
import { renderClaudeMd, renderAgentClaudeMd } from '../render.js';
import { wander, wanderFromFiles, WEIGHT_PRESETS } from '../wander.js';
import { embedAtom, embedAllAtoms } from '../embed-sync.js';
import type { Classification } from '../types.js';
import { registerRelateCommand, registerRelationsCommand } from './relate.js';
import { registerMigrateRelationsCommand } from './migrate-relations.js';
import { registerRelinkCommand } from './relink.js';
import { registerCitationsCommand } from './citations.js';
import { registerEnrichRelationsCommand } from './enrich-relations.js';
import { registerLintCommand } from './lint.js';
import { registerGroundingCommand } from './grounding.js';
import { registerEvalCommand } from './eval.js';
import { registerExtractCommand } from './extract.js';
import { registerConsolidateCommand } from './consolidate.js';
import { registerExportObsidianCommand } from './export-obsidian.js';
import { registerObsidianInitCommand } from './obsidian-init.js';
import { registerObserveCommand } from './observe.js';
import { registerSupersedeCommand } from './supersede.js';
import { registerSeedCommand } from './seed.js';
import { registerUpgradeCommand } from './upgrade.js';
import { registerExecuteCommand } from './execute.js';
import { registerEditCommand } from './edit.js';
import { closure } from '../closure.js';
import { isIsolated, initSharedStore, initIsolatedBase, initAgentStore, listAgents } from '../isolation.js';
import { shareAtom, unshareAtom, listSharedAtoms } from '../share.js';
import { migrate } from '../migrate.js';
import { resolveDir as resolveDirBase } from './resolve-dir.js';
import { exitWithError } from './cli-util.js';
import {
  processDeprecatedFlags,
  parseRenderStats,
  degenerateOutputWarning,
} from '../deprecations.js';
import {
  generateCronWrapper,
  parseGeneratedHeader,
  applyCrontabLine,
  DEFAULT_MAX_TOKENS,
} from '../cron-template.js';
import {
  runDoctor,
  runDoctorFix,
  parseSkipCategories,
  flattenIssues,
} from '../doctor/run.js';
import { execFileSync } from 'child_process';

const program = new Command();

program
  .name('mk')
  .description('Memory Kernel CLI — manage AI agent memory')
  .version(pkg.version)
  .option('-a, --agent <id>', 'Agent ID for per-agent isolation');

/** Resolve memoryDir with agent isolation applied. */
function resolveDir(dir: string, agent?: string): string {
  return resolveDirBase(dir, agent);
}

/** Get the --agent value from the root program options. */
function getAgent(): string | undefined {
  return program.opts().agent;
}

/**
 * Resolve the effective memory directory for a command, applying `--agent`
 * isolation. Centralizes the `resolveDir(opts.dir, getAgent())` boilerplate
 * that every command handler opened with (#360). `--dir` is a per-command
 * option with a `./memory` default, so `opts.dir` is always a string.
 */
function resolveContextDir(opts: { dir: string }): string {
  return resolveDir(opts.dir, getAgent());
}

/**
 * Exit with the standard "Memory directory not found" error when `dir` is
 * absent — centralizes the existence-check boilerplate that opened most command
 * handlers (#369). `hint` (default true) controls the `Run "mk init" first.`
 * suffix so each call site keeps its exact message. Does nothing when `dir`
 * exists; otherwise `exitWithError` terminates the process (exit 1). The
 * `mk doctor` handler is intentionally NOT routed through this — it exits 2 with
 * its own JSON/console output.
 */
function requireExistingDir(dir: string, json?: boolean, { hint = true }: { hint?: boolean } = {}): void {
  if (fs.existsSync(dir)) return;
  exitWithError(`Memory directory not found: ${dir}${hint ? '\n  Run "mk init" first.' : ''}`, json);
}

// --- mk init ---
//
// Two modes:
//
//   1. `mk init [dir]` (default) — initialize a memory directory with the
//      canonical on-disk layout. This is the original behavior.
//
//   2. `mk init --cron --dir <memory> --claude-md <out> --output <script>`
//      (#143) — generate the canonical memory-sync wrapper for the current
//      host instead of initializing a memory dir. With `--update`, regenerate
//      an existing wrapper in place, preserving the paths embedded in its
//      header. With `--install-cron <schedule>`, also append/replace the
//      corresponding line in the user's crontab (or the file pointed at by
//      `MK_CRONTAB_FILE` — used by tests to avoid mutating the real crontab).
program
  .command('init')
  .description('Initialize a memory directory, or generate a memory-sync cron wrapper with --cron')
  .argument('[dir]', 'Directory to initialize (ignored with --cron)', './memory')
  .option('--cron', 'Generate a canonical memory-sync wrapper script instead of initializing a directory')
  .option('-d, --dir <dir>', 'Memory directory the wrapper should sync (required with --cron)')
  .option('--claude-md <path>', 'CLAUDE.md path the wrapper should render to (required with --cron)')
  .option('--output <path>', 'Path to write the wrapper script (required with --cron)')
  .option('--memory-repo <path>', 'Git repo to commit/push from (defaults to dirname of --dir)')
  .option('--max-tokens <n>', `Render token budget embedded in the wrapper (default ${DEFAULT_MAX_TOKENS})`)
  .option('--agent-id <id>', 'Agent ID embedded in the wrapper (default: $(hostname -s) at run time)')
  .option('--install-cron <schedule>', 'Idempotently install a crontab entry for the wrapper, e.g. "0 23 * * *"')
  .option('--update', 'Regenerate the wrapper at --output in place, preserving paths from its header')
  .option('--force', 'Overwrite an existing --output file without prompting')
  .action((dir: string, opts: {
    cron?: boolean;
    dir?: string;
    claudeMd?: string;
    output?: string;
    memoryRepo?: string;
    maxTokens?: string;
    agentId?: string;
    installCron?: string;
    update?: boolean;
    force?: boolean;
  }) => {
    if (opts.cron) {
      runInitCron(opts);
      return;
    }

    const memoryDir = path.resolve(dir);
    const agent = getAgent();
    if (agent) {
      // Initialize in per-agent isolation mode with the specified agent store
      initIsolatedBase(memoryDir, agent);
      console.log(`✓ Isolated memory initialized at ${memoryDir}`);
      console.log(`  Created agent store: agents/${agent}/`);
      console.log('  Created shared store: shared/');
      console.log('  Created: config.yaml (isolation: per-agent)');
    } else {
      initMemoryDir(memoryDir);
      console.log(`✓ Memory initialized at ${memoryDir}`);
      console.log('  Created: INDEX.md, HANDOFF.md, DECISIONS.md, CONSTRAINTS.md, OPEN_QUESTIONS.md');
      console.log('  Created: ENTITIES/, EPISODES/, EVIDENCE/, CONFLICTS/, ARCHIVE/');
      console.log('  Created: events.ndjson');
    }
  });

function runInitCron(opts: {
  dir?: string;
  claudeMd?: string;
  output?: string;
  memoryRepo?: string;
  maxTokens?: string;
  agentId?: string;
  installCron?: string;
  update?: boolean;
  force?: boolean;
}): void {
  if (!opts.output) {
    exitWithError('--output <path> is required with --cron');
  }
  const outputPath = path.resolve(opts.output);

  // --update: read paths back from the existing wrapper's mk:* header.
  // CLI-supplied flags still win (e.g. user can rotate --max-tokens by passing
  // both --update and --max-tokens), but anything the user didn't pass is
  // inherited from the existing file rather than re-prompted.
  let memoryDir: string | undefined;
  let claudeMd: string | undefined;
  let memoryRepo: string | undefined;
  let maxTokens: number | undefined;
  let agentId: string | undefined;
  let mkBin: string | undefined;

  if (opts.update) {
    if (!fs.existsSync(outputPath)) {
      exitWithError(`--update requires an existing file at ${outputPath}`);
    }
    const existing = fs.readFileSync(outputPath, 'utf-8');
    const header = parseGeneratedHeader(existing);
    if (!header) {
      exitWithError(
        `Could not read mk: header lines from ${outputPath}. Was it generated by mk init --cron?`,
      );
    }
    memoryDir = header.memoryDir;
    claudeMd = header.claudeMd;
    memoryRepo = header.memoryRepo;
    maxTokens = header.maxTokens;
    agentId = header.agentId ?? undefined;
    mkBin = header.mkBin ?? undefined; // preserve the baked agent binary on --update
  }

  // Bake the agent's own mk binary (#345). The operator runs `mk init --cron`
  // in the agent's environment, where MK_BIN points at the binary the agent
  // actually uses; a fresh MK_BIN in the env refreshes a stale baked value,
  // otherwise the --update-preserved header value stands.
  if (process.env.MK_BIN) mkBin = process.env.MK_BIN;

  // CLI flags override anything pulled from the header (above).
  if (opts.dir) memoryDir = path.resolve(opts.dir);
  if (opts.claudeMd) claudeMd = path.resolve(opts.claudeMd);
  if (opts.memoryRepo) memoryRepo = path.resolve(opts.memoryRepo);
  if (opts.maxTokens) {
    const n = parseInt(opts.maxTokens, 10);
    if (isNaN(n) || n <= 0) exitWithError('--max-tokens must be a positive integer');
    maxTokens = n;
  }
  if (opts.agentId) agentId = opts.agentId;

  if (!memoryDir) exitWithError('--dir <memory-directory> is required with --cron');
  if (!claudeMd) exitWithError('--claude-md <path> is required with --cron');

  // #347: the wrapper runs wherever the timer fires (often the HOST). A baked
  // memory-dir that doesn't exist here is almost always the container-vs-host
  // mistake that silently darkens the nightly. Warn (non-fatal — the store may
  // legitimately be created later); `mk doctor`'s wrapper-memory-dir check is
  // the durable runtime gate on the host where it's installed. Skip the warning
  // when MK_MEMORY_DIR is set — the operator is deliberately baking a placeholder
  // resolved via the runtime override (the wrapper bakes `${MK_MEMORY_DIR:-…}`).
  if (!process.env.MK_MEMORY_DIR && !fs.existsSync(memoryDir)) {
    console.error(
      `⚠ memory-dir does not exist on this host: ${memoryDir}\n` +
      `  The cron wrapper runs where the timer fires — if you generated this in a\n` +
      `  container for a host timer, re-run with the HOST store path so the nightly\n` +
      `  doesn't render to a missing directory (see #347).`,
    );
  }

  // Overwrite guard — refuse silently destroying an existing file unless the
  // user opts in via --force or is in --update mode (which by definition
  // writes back to the same file).
  if (!opts.update && !opts.force && fs.existsSync(outputPath)) {
    exitWithError(
      `${outputPath} already exists. Re-run with --update to regenerate in place, or --force to overwrite.`,
    );
  }

  const script = generateCronWrapper({
    memoryDir,
    claudeMd,
    memoryRepo,
    maxTokens,
    agentId,
    mkBin,
    kernelVersion: pkg.version,
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, script);
  fs.chmodSync(outputPath, 0o755);
  console.log(`✓ Wrote ${outputPath} (${script.split('\n').length - 1} lines, mode 755)`);
  console.log(`  Generated by mk v${pkg.version}.`);

  // Warn at generation time when the wrapper lives inside the memory repo:
  // the generated git step does `git add -A`, which would otherwise commit
  // the wrapper itself on first sync. (See observation on PR #149.)
  const resolvedMemoryRepo = memoryRepo ?? path.dirname(memoryDir);
  const relToRepo = path.relative(resolvedMemoryRepo, outputPath);
  if (relToRepo && !relToRepo.startsWith('..') && !path.isAbsolute(relToRepo)) {
    const scriptName = path.basename(outputPath);
    console.error(
      `mk: note: ${outputPath} is inside ${resolvedMemoryRepo}. Add "${scriptName}" to that repo's .gitignore so the sync step does not commit the wrapper itself.`,
    );
  }

  const cronLine = opts.installCron
    ? `${opts.installCron.trim()} ${outputPath}`
    : null;

  if (cronLine) {
    installCronEntry(cronLine, outputPath);
  } else {
    console.log('');
    console.log('To install on a 23:00 daily schedule, run:');
    console.log(`  (crontab -l 2>/dev/null; echo "0 23 * * * ${outputPath}") | crontab -`);
    console.log('Or re-run with: mk init --cron --update --output <this-file> --install-cron "0 23 * * *"');
  }
}

/**
 * Read the current crontab (or MK_CRONTAB_FILE for tests), apply the new line
 * idempotently, write it back. We never silently mutate the user's crontab
 * without --install-cron.
 */
function installCronEntry(cronLine: string, scriptPath: string): void {
  const fileOverride = process.env.MK_CRONTAB_FILE;

  let current = '';
  if (fileOverride) {
    current = fs.existsSync(fileOverride) ? fs.readFileSync(fileOverride, 'utf-8') : '';
  } else {
    try {
      // `crontab -l` exits non-zero with empty stdout when no crontab exists yet.
      current = execFileSync('crontab', ['-l'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      current = '';
    }
  }

  const next = applyCrontabLine(current, cronLine, scriptPath);

  if (fileOverride) {
    fs.writeFileSync(fileOverride, next);
  } else {
    execFileSync('crontab', ['-'], { input: next, encoding: 'utf-8' });
  }

  console.log(`✓ Installed crontab entry: ${cronLine}`);
}

// --- mk status ---
program
  .command('status')
  .description('Show memory statistics')
  .option('-d, --dir <dir>', 'Memory directory', './memory')
  .option('--all-agents', 'Show status for all agents (isolated mode)')
  .option('--json', 'Output as JSON')
  .action((opts: { dir: string; allAgents?: boolean; json?: boolean }) => {
    const baseDir = path.resolve(opts.dir);

    // --all-agents: show per-agent summary
    if (opts.allAgents) {
      if (!isIsolated(baseDir)) {
        exitWithError('--all-agents requires per-agent isolation mode', opts.json);
      }
      const agents = listAgents(baseDir);
      const sharedDir = path.join(baseDir, 'shared');
      const agentSummaries = agents.map((agentId) => {
        const agentDir = path.join(baseDir, 'agents', agentId);
        const atoms = fs.existsSync(path.join(agentDir, 'ENTITIES')) ? listAtoms(agentDir) : [];
        const events = countEvents(agentDir);
        return { agent_id: agentId, atoms: atoms.length, events };
      });
      const sharedAtoms = fs.existsSync(path.join(sharedDir, 'ENTITIES')) ? listAtoms(sharedDir) : [];

      if (opts.json) {
        console.log(JSON.stringify({
          mode: 'per-agent',
          base_dir: baseDir,
          agents: agentSummaries,
          shared: { atoms: sharedAtoms.length },
        }, null, 2));
        return;
      }

      console.log(`Memory (isolated): ${baseDir}`);
      console.log(`Agents: ${agents.length}`);
      console.log(`Shared atoms: ${sharedAtoms.length}`);
      console.log('');
      for (const summary of agentSummaries) {
        console.log(`  ${summary.agent_id}: ${summary.atoms} atoms, ${summary.events} events`);
      }
      return;
    }

    const memoryDir = resolveContextDir(opts);
    requireExistingDir(memoryDir, opts.json);

    const atoms = listAtoms(memoryDir);
    const eventCount = countEvents(memoryDir);

    // Group by type
    const byType = new Map<string, number>();
    const byStatus = new Map<string, number>();
    for (const atom of atoms) {
      byType.set(atom.frontmatter.type, (byType.get(atom.frontmatter.type) ?? 0) + 1);
      byStatus.set(atom.frontmatter.status, (byStatus.get(atom.frontmatter.status) ?? 0) + 1);
    }

    if (opts.json) {
      const idxStatus = indexExists(memoryDir) ? indexStats(memoryDir) : null;
      const eStats = idxStatus?.embeddings ? embeddingStats(memoryDir) : null;
      console.log(JSON.stringify({
        memory_dir: memoryDir,
        atom_count: atoms.length,
        event_count: eventCount,
        by_type: Object.fromEntries(byType),
        by_status: Object.fromEntries(byStatus),
        index: idxStatus ? { exists: true, atoms: idxStatus.atoms, tags: idxStatus.tags, paths: idxStatus.paths } : { exists: false },
        embeddings: eStats ? { exists: true, count: idxStatus!.embeddings, model: eStats.model ?? 'unknown' } : { exists: false },
      }, null, 2));
      return;
    }

    console.log(`Memory: ${memoryDir}`);
    console.log(`Atoms: ${atoms.length}`);
    console.log(`Events: ${eventCount}`);
    console.log('');

    if (byType.size > 0) {
      console.log('By type:');
      for (const [type, count] of [...byType].sort()) {
        console.log(`  ${type}: ${count}`);
      }
      console.log('');
    }

    if (byStatus.size > 0) {
      console.log('By status:');
      for (const [status, count] of [...byStatus].sort()) {
        console.log(`  ${status}: ${count}`);
      }
      console.log('');
    }

    // Index status
    if (indexExists(memoryDir)) {
      const stats = indexStats(memoryDir);
      if (stats) {
        console.log(`Index: ✓ (${stats.atoms} atoms, ${stats.tags} tags, ${stats.paths} paths)`);
        if (stats.embeddings > 0) {
          const eStats = embeddingStats(memoryDir);
          console.log(`Embeddings: ✓ (${stats.embeddings} vectors, model: ${eStats?.model ?? 'unknown'})`);
        } else {
          console.log('Embeddings: ✗ (set EMBEDDING_PROVIDER + EMBEDDING_API_KEY, then run "mk reindex --embed")');
        }
      }
    } else {
      console.log('Index: ✗ (run "mk reindex" to build)');
    }
  });

// --- mk recall ---
program
  .command('recall')
  .description('Load relevant context for a task')
  .option('-d, --dir <dir>', 'Memory directory', './memory')
  .option('-t, --task <task>', 'Task description (enables FTS-based re-ranking)')
  .option('--paths <paths...>', 'Scope paths to match')
  .option('--types <types...>', 'Filter by atom type')
  .option('--max-tokens <n>', 'Token budget', parseInt)
  .option('--decay-half-life <days>', 'Half-life for temporal decay in days (default: 30)', parseFloat)
  .option('--decay-weight <n>', 'Weight of recency in scoring, 0-1 (default: 0.2)', parseFloat)
  .option('--include-episodes', 'Include EPISODES/ session summaries in context bundle')
  .option('--include-drafts', 'Surface auto-extracted draft atoms (session-end extract output, excluded by default)')
  .option('--graph', 'Enable graph-relation neighbor boost (default: on)')
  .option('--no-graph', 'Disable graph-relation neighbor boost')
  .option('--reservations', 'Enable type-based token reservations (default: on for no-task, off for --task)')
  .option('--no-reservations', 'Disable type-based token reservations')
  .option('--embed', 'Use hybrid FTS + embedding retrieval (requires embeddings built via reindex --embed)')
  .option('--json', 'Output as JSON')
  .action(async (opts: {
    dir: string;
    task?: string;
    paths?: string[];
    types?: string[];
    maxTokens?: number;
    decayHalfLife?: number;
    decayWeight?: number;
    includeEpisodes?: boolean;
    includeDrafts?: boolean;
    graph: boolean; // Commander sets this to true/false via --graph/--no-graph
    reservations?: boolean; // Commander sets via --reservations/--no-reservations
    embed?: boolean;
    json?: boolean;
  }) => {
    const memoryDir = resolveContextDir(opts);
    requireExistingDir(memoryDir, opts.json);
    // Determine no_reservations:
    //   --no-reservations → force off (no_reservations = true)
    //   --reservations    → force on  (no_reservations = false, overrides task auto-disable)
    //   neither           → let getTypeReservations decide (auto-disable for --task)
    const noReservations = opts.reservations === false
      ? true
      : opts.reservations === true
        ? false
        : undefined;
    const recallOpts = {
      task: opts.task,
      paths: opts.paths,
      types: opts.types as any,
      max_tokens: opts.maxTokens,
      decay_half_life: opts.decayHalfLife,
      decay_weight: opts.decayWeight,
      include_episodes: opts.includeEpisodes,
      include_drafts: opts.includeDrafts,
      graph_boost: opts.graph,
      no_reservations: noReservations,
    };
    const bundle = opts.embed
      ? await recallWithEmbeddings(memoryDir, recallOpts)
      : recall(memoryDir, recallOpts);

    if (opts.json) {
      console.log(JSON.stringify(bundle, null, 2));
      return;
    }

    console.log(`=== Context Bundle (≈${bundle.token_estimate} tokens) ===\n`);
    console.log('--- INDEX ---');
    console.log(bundle.index);
    console.log('--- HANDOFF ---');
    console.log(bundle.handoff);
    console.log('--- CONSTRAINTS ---');
    console.log(bundle.constraints);

    if (bundle.atoms.length > 0) {
      console.log(`--- ATOMS (${bundle.atoms.length}) ---`);
      for (const atom of bundle.atoms) {
        console.log(`\n[${atom.frontmatter.type}] ${atom.frontmatter.id} (${atom.frontmatter.status})`);
        console.log(atom.body.slice(0, 200) + (atom.body.length > 200 ? '...' : ''));
      }
    }

    if (bundle.episodes && bundle.episodes.length > 0) {
      console.log(`\n--- EPISODES (${bundle.episodes.length}) ---`);
      for (const ep of bundle.episodes) {
        console.log('\n' + ep);
      }
    }
  });

// --- mk checkpoint ---
program
  .command('checkpoint')
  .description('Generate a checkpoint/handoff bundle')
  .option('-d, --dir <dir>', 'Memory directory', './memory')
  .option('-t, --task <task>', 'Task description for scoping')
  .option('--max-tokens <n>', 'Token budget', parseInt)
  .option('--agent-id <id>', 'Agent ID', 'cli')
  .option('--session-id <id>', 'Session ID', 'cli-session')
  .option('--no-reflect', 'Skip reflect before checkpoint')
  .option('--json', 'Output as JSON')
  .action(async (opts: {
    dir: string; task?: string; maxTokens?: number;
    agentId: string; sessionId: string; reflect: boolean; json?: boolean;
  }) => {
    const memoryDir = resolveContextDir(opts);
    requireExistingDir(memoryDir, opts.json, { hint: false });

    const result = await checkpoint({
      memoryDir,
      agent_id: opts.agentId,
      session_id: opts.sessionId,
      task: opts.task,
      max_tokens: opts.maxTokens,
      skipReflect: !opts.reflect,
    });

    if (opts.json) {
      console.log(JSON.stringify({
        event_id: result.event_id,
        token_estimate: result.bundle.token_estimate,
        atom_count: result.bundle.atoms.length,
        markdown: result.markdown,
        error: result.error ?? null,
      }, null, 2));
      return;
    }

    // Markdown to stdout (pipeable)
    process.stdout.write(result.markdown);

    // Metadata to stderr
    process.stderr.write(
      `\n✓ Checkpoint created (≈${result.bundle.token_estimate} tokens, ${result.bundle.atoms.length} atoms, event: ${result.event_id})\n`,
    );
    if (result.error) {
      process.stderr.write(`  Warning: ${result.error}\n`);
    }
  });

// --- mk reflect ---
program
  .command('reflect')
  .description('Consolidate memory: dedup, TTL, promote, detect conflicts')
  .option('-d, --dir <dir>', 'Memory directory', './memory')
  .option('--agent-id <id>', 'Agent ID', 'cli')
  .option('--session-id <id>', 'Session ID', 'cli-session')
  .option(
    '--backfill-human-edits',
    'Detect off-band filesystem edits and emit synthetic human_edit events for ' +
      'clearly-scattered ones (bulk migration clusters are skipped). See #247.',
  )
  .option('--json', 'Output as JSON')
  .action((opts: {
    dir: string;
    agentId: string;
    sessionId: string;
    backfillHumanEdits?: boolean;
    json?: boolean;
  }) => {
    const memoryDir = resolveContextDir(opts);
    requireExistingDir(memoryDir, opts.json);
    const result = reflect({
      memoryDir,
      agent_id: opts.agentId,
      session_id: opts.sessionId,
      backfillHumanEdits: opts.backfillHumanEdits,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log('✓ Reflect completed:');
    console.log(`  Deduped:    ${result.deduped}`);
    console.log(`  Expired:    ${result.expired}`);
    console.log(`  Promoted:   ${result.promoted}`);
    console.log(`  Archived:   ${result.archived}`);
    console.log(`  Conflicts:  ${result.conflicts_found}`);
    if (opts.backfillHumanEdits) {
      console.log(`  Unprovenanced writes: ${result.unprovenanced_writes ?? 0}`);
      console.log(`  human_edits backfilled: ${result.human_edits_backfilled ?? 0}`);
    }
    console.log(`  Events:     ${result.events_emitted}`);
  });

// --- mk gc ---
program
  .command('gc')
  .description('Garbage collect: archive expired atoms')
  .option('-d, --dir <dir>', 'Memory directory', './memory')
  .option('--agent-id <id>', 'Agent ID', 'cli')
  .option('--session-id <id>', 'Session ID', 'cli-session')
  .option('--json', 'Output as JSON')
  .action((opts: { dir: string; agentId: string; sessionId: string; json?: boolean }) => {
    const memoryDir = resolveContextDir(opts);
    requireExistingDir(memoryDir, opts.json);
    // GC is just reflect with focus on expiry
    const result = reflect({
      memoryDir,
      agent_id: opts.agentId,
      session_id: opts.sessionId,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log('✓ GC completed:');
    console.log(`  Expired:    ${result.expired}`);
    console.log(`  Archived:   ${result.archived}`);
    console.log(`  Deduped:    ${result.deduped}`);
    console.log(`  Promoted:   ${result.promoted}`);
    console.log(`  Conflicts:  ${result.conflicts_found}`);
  });

// --- mk doctor ---
//
// Orchestrator over a check registry (src/doctor/). Exit codes:
//   0 — healthy
//   1 — warn (one or more checks found warn-severity issues)
//   2 — error (a check returned error severity, or a hard runtime error)
//
// JSON output is backward-compatible with the pre-#140 shape:
// `{ healthy, issue_count, issues }`, with a new `checks` array alongside
// for callers that want per-check structure.
program
  .command('doctor')
  .description('Validate memory: schema, links, conflicts, store integrity, wrapper drift')
  .option('-d, --dir <dir>', 'Memory directory', './memory')
  .option('--json', 'Output as JSON')
  .option(
    '--skip <categories>',
    'Comma-separated check categories to skip: wrappers, network, cron, store',
  )
  .option('--fix', 'Apply auto-fixes for safe issues (#157)')
  .option('--dry-run', 'Preview --fix actions without writing (no-op without --fix)')
  .action(
    async (opts: {
      dir: string;
      json?: boolean;
      skip?: string;
      fix?: boolean;
      dryRun?: boolean;
    }) => {
      const memoryDir = resolveContextDir(opts);
      if (!fs.existsSync(memoryDir)) {
        // Hard error: cannot run any check. Exit code 2 per #140 spec.
        const msg = `Memory directory not found: ${memoryDir}\n  Run "mk init" first.`;
        if (opts.json) {
          console.log(JSON.stringify({ error: msg }, null, 2));
        } else {
          console.error(`✗ ${msg}`);
        }
        process.exit(2);
      }

      const doctorCtx = {
        memoryDir,
        kernelVersion: pkg.version,
        skipCategories: parseSkipCategories(opts.skip),
        env: process.env,
      };

      // --dry-run without --fix is a soft no-op: warn and behave like plain doctor.
      if (opts.dryRun && !opts.fix && !opts.json) {
        console.error('Warning: --dry-run has no effect without --fix; running plain doctor.');
      }

      if (opts.fix) {
        const { initialResults, results, fixResults, exitCode } = await runDoctorFix(
          doctorCtx,
          { dryRun: !!opts.dryRun },
        );
        const issues = flattenIssues(initialResults);

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                healthy: issues.length === 0,
                issue_count: issues.length,
                issues,
                checks: results,
                fixes: fixResults.map((f) => ({
                  name: f.name,
                  applied: f.applied,
                  remaining: f.remaining,
                  ...(f.errors ? { errors: f.errors } : {}),
                  dry_run: f.dryRun,
                })),
              },
              null,
              2,
            ),
          );
          process.exit(exitCode);
        }

        // Human output for --fix.
        const verb = opts.dryRun ? '[WOULD FIX]' : '[FIXED]';
        if (fixResults.length === 0 && issues.length === 0) {
          console.log('✓ Memory is healthy. No fixes needed.');
          process.exit(exitCode);
        }
        for (const f of fixResults) {
          if (f.applied.length > 0) {
            console.log(`${verb} ${f.name}:`);
            for (const line of f.applied) console.log(`  - ${line}`);
          }
          if (f.remaining.length > 0) {
            console.log(`[REMAINING] ${f.name}:`);
            for (const line of f.remaining) console.log(`  - ${line}`);
          }
          if (f.errors && f.errors.length > 0) {
            console.log(`[ERROR] ${f.name}:`);
            for (const line of f.errors) console.log(`  - ${line}`);
          }
        }
        // Surface any unfixable issues from non-fixable checks too.
        const fixedNames = new Set(fixResults.map((f) => f.name));
        for (const r of results) {
          if (r.ok || r.skipped || fixedNames.has(r.name)) continue;
          const tag = r.severity === 'error' ? '[ERROR]' : '[WARN]';
          console.log(`${tag} ${r.name}:`);
          for (const i of r.issues) console.log(`  - ${i}`);
        }
        process.exit(exitCode);
      }

      // Plain doctor path (no --fix).
      const { results, exitCode } = await runDoctor(doctorCtx);
      const issues = flattenIssues(results);

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              healthy: issues.length === 0,
              issue_count: issues.length,
              issues,
              checks: results,
            },
            null,
            2,
          ),
        );
        process.exit(exitCode);
      }

      if (issues.length === 0) {
        console.log('✓ Memory is healthy. No issues found.');
        const skipped = results.filter((r) => r.skipped);
        for (const r of skipped) {
          console.log(`  - ${r.name}: skipped (${r.skipped?.reason})`);
        }
        process.exit(exitCode);
      }

      const severityCounts = { error: 0, warn: 0 };
      for (const r of results) {
        if (r.ok || r.skipped) continue;
        if (r.severity === 'error') severityCounts.error += r.issues.length;
        if (r.severity === 'warn') severityCounts.warn += r.issues.length;
      }

      console.log(
        `✗ Found ${issues.length} issue(s) — ${severityCounts.error} error, ${severityCounts.warn} warn:\n`,
      );
      for (const r of results) {
        if (r.ok || r.skipped) continue;
        const tag = r.severity === 'error' ? '[ERROR]' : '[WARN]';
        console.log(`${tag} ${r.name}:`);
        for (const i of r.issues) {
          console.log(`  - ${i}`);
        }
      }
      process.exit(exitCode);
    },
  );

// --- mk reindex ---
program
  .command('reindex')
  .description('Rebuild SQLite index from atom files')
  .option('-d, --dir <dir>', 'Memory directory', './memory')
  .option('--embed', 'Also (re)compute embeddings for all atoms')
  .option('--json', 'Output results as JSON')
  .action(async (opts: { dir: string; embed?: boolean; json?: boolean }) => {
    const memoryDir = resolveContextDir(opts);
    requireExistingDir(memoryDir, opts.json, { hint: false });

    if (!opts.json) {
      console.log(`Rebuilding index for ${memoryDir}...`);
    }
    const result = reindex(memoryDir);
    const stats = indexStats(memoryDir);

    let embedSummary: { embedded: number; skipped: number; errors: number; time_ms: number } | undefined;
    if (opts.embed) {
      if (!opts.json) {
        console.log(`✓ Indexed ${result.indexed} atoms in ${result.timeMs}ms`);
        if (stats) {
          console.log(`  Atoms: ${stats.atoms}, Tags: ${stats.tags}, Paths: ${stats.paths}`);
        }
        console.log(`\nEmbedding atoms...`);
      }
      const embedResult = await embedAllAtoms(memoryDir, {
        onProgress: opts.json
          ? undefined
          : (done, total) => {
              process.stdout.write(`\r  Progress: ${done}/${total}`);
            },
      });
      if (!opts.json) {
        console.log(''); // newline after progress
        console.log(`✓ Embeddings: ${embedResult.embedded} embedded, ${embedResult.skipped} skipped, ${embedResult.errors} errors (${embedResult.timeMs}ms)`);
      }
      embedSummary = {
        embedded: embedResult.embedded,
        skipped: embedResult.skipped,
        errors: embedResult.errors,
        time_ms: embedResult.timeMs,
      };
    }

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            indexed: result.indexed,
            time_ms: result.timeMs,
            stats: stats ?? null,
            embeddings: embedSummary ?? null,
          },
          null,
          2,
        ),
      );
      return;
    }

    if (!opts.embed) {
      console.log(`✓ Indexed ${result.indexed} atoms in ${result.timeMs}ms`);
      if (stats) {
        console.log(`  Atoms: ${stats.atoms}, Tags: ${stats.tags}, Paths: ${stats.paths}`);
      }
    }
  });

// --- mk remember ---
program
  .command('remember')
  .description('Quick atom creation from command line')
  .argument('<body>', 'Atom body text')
  .option('-d, --dir <dir>', 'Memory directory', './memory')
  .option('-t, --type <type>', 'Atom type', 'belief')
  .option('-c, --confidence <n>', 'Confidence (0-1)', parseFloat)
  .option('--slug <slug>', 'Custom slug for atom ID')
  .option('--tags <tags...>', 'Tags for scope')
  .option('--agent-id <id>', 'Agent ID', 'cli')
  .option('--session-id <id>', 'Session ID', 'cli-session')
  .option('--json', 'Output as JSON')
  .action(async (body: string, opts: {
    dir: string; type: string; confidence?: number;
    slug?: string; tags?: string[];
    agentId: string; sessionId: string; json?: boolean;
  }) => {
    const memoryDir = resolveContextDir(opts);
    requireExistingDir(memoryDir, opts.json, { hint: false });

    // Generate slug from body if not provided; fall back to timestamp if body yields empty string
    const slug = (opts.slug ?? body
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40)) || `atom-${Date.now()}`;

    // #262: a quoted `--tags "foo bar"` arrives as one whitespace-containing
    // token that breaks tag queries. Warn (not error — forgiving) and still write.
    // Check the NORMALIZED tags so we agree with the `tag-format` doctor check
    // (both view tags post-`normalizeTags`): a comma-list like "foo, bar" splits
    // cleanly and must NOT warn, while a space-joined "foo bar" survives and does.
    const badTags = normalizeTags(opts.tags ?? []).filter((t) => !isValidTag(t));

    const atom = createAtom({
      memoryDir,
      type: opts.type as any,
      slug,
      body,
      confidence: opts.confidence,
      agent_id: opts.agentId,
      session_id: opts.sessionId,
      scope: opts.tags ? { tags: opts.tags } : undefined,
    });

    // Async: embed the atom if embeddings are configured
    const embedded = await embedAtom(memoryDir, atom);

    if (opts.json) {
      console.log(JSON.stringify({
        id: atom.frontmatter.id,
        type: atom.frontmatter.type,
        status: atom.frontmatter.status,
        confidence: atom.frontmatter.confidence,
        tags: atom.frontmatter.scope?.tags ?? [],
        embedded: !!embedded,
        embedding_warning: (!embedded && process.env.EMBEDDING_PROVIDER && process.env.EMBEDDING_PROVIDER !== 'none')
          ? 'Embedding failed — run "mk reindex --embed" to retry'
          : null,
        tag_warning: badTags.length > 0
          ? `tag(s) contain whitespace (stored as single tokens — quote-joined?): ${badTags.map((t) => `"${t}"`).join(', ')}`
          : null,
      }, null, 2));
      return;
    }

    if (badTags.length > 0) {
      console.warn(`⚠ tag(s) contain whitespace — stored as single tokens, which break tag queries (did you quote \`--tags "a b c"\` instead of \`--tags a b c\`?): ${badTags.map((t) => `"${t}"`).join(', ')}`);
    }

    console.log(`✓ Created: ${atom.frontmatter.id}`);
    console.log(`  Type: ${atom.frontmatter.type}, Status: ${atom.frontmatter.status}`);
    console.log(`  Confidence: ${atom.frontmatter.confidence}`);
    if (opts.tags) console.log(`  Tags: ${opts.tags.join(', ')}`);

    if (embedded) {
      console.log(`  Embedded: ✓`);
    } else if (process.env.EMBEDDING_PROVIDER && process.env.EMBEDDING_PROVIDER !== 'none') {
      console.warn(`  ⚠ Embedding failed — run "mk reindex --embed" to retry`);
    }
  });

// --- mk bootstrap-events ---
program
  .command('bootstrap-events')
  .description('Migrate existing atoms into V2 event log (prepends atom_imported events)')
  .option('-d, --dir <dir>', 'Memory directory', './memory')
  .option('--agent-id <id>', 'Agent ID', 'cli')
  .option('--session-id <id>', 'Session ID', 'cli-bootstrap')
  .option('--json', 'Output results as JSON')
  .action((opts: { dir: string; agentId: string; sessionId: string; json?: boolean }) => {
    const memoryDir = resolveContextDir(opts);
    requireExistingDir(memoryDir, opts.json, { hint: false });

    const result = bootstrapEvents({
      memoryDir,
      agent_id: opts.agentId,
      session_id: opts.sessionId,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log('✓ Bootstrap completed:');
    console.log(`  Imported: ${result.imported} atoms`);
    if (result.skipped > 0) console.log(`  Skipped: ${result.skipped} (already imported)`);
    if (result.events_written > 0) {
      console.log(`  Total events in log: ${result.events_written}`);
      console.log(`  Backup: ${result.backup_path}`);
    } else {
      console.log('  No new atoms to import.');
    }
  });

// --- mk compact ---
program
  .command('compact')
  .description('Compact the event log — keep latest mutation per atom, remove intermediate events')
  .option('-d, --dir <dir>', 'Memory directory', './memory')
  .option('--json', 'Output as JSON')
  .action((opts: { dir: string; json?: boolean }) => {
    const memoryDir = resolveContextDir(opts);
    requireExistingDir(memoryDir, opts.json);

    try {
      const result = compactLog(memoryDir);

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.removed === 0) {
        console.log('✓ Event log is already compact. Nothing to do.');
        console.log(`  Events: ${result.events_before}`);
      } else {
        console.log('✓ Event log compacted:');
        console.log(`  Before: ${result.events_before} events`);
        console.log(`  After:  ${result.events_after} events`);
        console.log(`  Removed: ${result.removed} intermediate events`);
        console.log(`  Backup: ${result.backup_path}`);
      }
    } catch (err) {
      exitWithError(`Compact failed: ${String(err)}`, opts.json);
    }
  });

// --- mk merge ---
program
  .command('merge')
  .description('Merge remote agent event log into local memory (event-log union)')
  .requiredOption('--from <dir>', 'Remote memory directory to merge from')
  .option('-d, --dir <dir>', 'Local memory directory', './memory')
  .option('--agent-id <id>', 'Agent ID for the merge event', 'cli')
  .option('--session-id <id>', 'Session ID for the merge event', 'cli-merge')
  .option('--dry-run', 'Preview changes without writing anything')
  .option('--json', 'Output results as JSON')
  .action((opts: { from: string; dir: string; agentId: string; sessionId: string; dryRun?: boolean; json?: boolean }) => {
    const localDir = resolveContextDir(opts);
    const remoteDir = path.resolve(opts.from);

    if (!fs.existsSync(localDir)) {
      exitWithError(`Local memory directory not found: ${localDir}\n  Run "mk init" first.`, opts.json);
    }

    if (!fs.existsSync(remoteDir)) {
      exitWithError(`Remote directory not found: ${remoteDir}`, opts.json);
    }

    if (opts.dryRun && !opts.json) {
      console.log('Dry run — no changes will be written.\n');
    }

    try {
      const result = mergeEventLogs({
        localDir,
        remoteDir,
        agent_id: opts.agentId,
        session_id: opts.sessionId,
        dryRun: opts.dryRun,
      });

      if (opts.json) {
        console.log(JSON.stringify({ dry_run: !!opts.dryRun, ...result }, null, 2));
        return;
      }

      const prefix = opts.dryRun ? '(dry run) ' : '✓ ';
      console.log(`${prefix}Merge completed:`);
      console.log(`  Events imported:   ${result.events_imported}`);
      console.log(`  Events skipped:    ${result.events_skipped}`);
      console.log(`  Conflicts created: ${result.conflicts_created}`);
      console.log(`  Atoms updated:     ${result.atoms_updated}`);
      if (result.backup_path) {
        console.log(`  Backup:            ${result.backup_path}`);
      }
    } catch (err) {
      exitWithError(`Merge failed: ${String(err)}`, opts.json);
    }
  });

// --- mk replay ---
program
  .command('replay')
  .description('Replay events to reconstruct state')
  // #122: unified --from semantics — accept either an events NDJSON file or a
  // memory-kernel directory (in which case we auto-locate <dir>/events.ndjson).
  // `merge --from <dir>` and `replay --from <file|dir>` now both accept the
  // common "memory-kernel store" shape; `import --from <file>` remains
  // file-only because its source is an arbitrary markdown document, not a
  // memory-kernel input.
  .requiredOption('--from <path>', 'Events NDJSON file, or a memory-kernel directory containing events.ndjson')
  .option('--output-dir <dir>', 'Write reconstructed atoms and views to this directory')
  .option('--evidence-dir <dir>', 'Directory containing evidence blobs')
  .action((opts: { from: string; outputDir?: string; evidenceDir?: string }) => {
    let eventsFile = path.resolve(opts.from);
    if (fs.existsSync(eventsFile) && fs.statSync(eventsFile).isDirectory()) {
      const candidate = path.join(eventsFile, 'events.ndjson');
      if (!fs.existsSync(candidate)) {
        console.error(`✗ --from points to a directory but no events.ndjson found in: ${eventsFile}`);
        process.exit(1);
      }
      eventsFile = candidate;
    }
    if (!fs.existsSync(eventsFile)) {
      console.error(`✗ Events file not found: ${eventsFile}`);
      process.exit(1);
    }

    const result = replayFromFile(eventsFile, {
      outputDir: opts.outputDir ? path.resolve(opts.outputDir) : undefined,
      evidenceDir: opts.evidenceDir ? path.resolve(opts.evidenceDir) : undefined,
    });

    console.log('✓ Replay completed:');
    console.log(`  Events processed: ${result.events_processed}`);
    console.log(`  Atoms reconstructed: ${result.atoms.size}`);

    if (result.errors.length > 0) {
      console.log(`  Errors: ${result.errors.length}`);
      for (const err of result.errors) {
        console.log(`    - ${err}`);
      }
    }

    if (opts.outputDir) {
      console.log(`  Output written to: ${path.resolve(opts.outputDir)}`);
    }
  });

// --- mk episode ---
program
  .command('episode')
  .description('Write a session/episode summary to EPISODES/')
  .requiredOption('--session-id <id>', 'Session ID (used to generate episode file name)')
  .requiredOption('--summary <text>', 'Episode summary text (markdown)')
  .option('-d, --dir <dir>', 'Memory directory', './memory')
  .option('--tags <tags...>', 'Tags for this episode')
  .option('--agent-id <id>', 'Agent ID', 'cli')
  .option('--json', 'Output as JSON')
  .action((opts: { dir: string; sessionId: string; summary: string; tags?: string[]; agentId: string; json?: boolean }) => {
    const memoryDir = resolveContextDir(opts);
    requireExistingDir(memoryDir, opts.json);

    const id = writeEpisode(
      memoryDir,
      opts.sessionId,
      opts.summary,
      { tags: opts.tags },
      { agent_id: opts.agentId },
    );

    if (opts.json) {
      console.log(JSON.stringify({ episode_id: id, file: `EPISODES/${id}.md` }, null, 2));
      return;
    }

    console.log(`✓ Episode written: ${id}`);
    console.log(`  File: EPISODES/${id}.md`);
  });

// --- mk episodes ---
program
  .command('episodes')
  .description('List recent episode summaries from EPISODES/')
  .option('-d, --dir <dir>', 'Memory directory', './memory')
  .option('--limit <n>', 'Max episodes to show', parseInt)
  .option('--json', 'Output as JSON')
  .action((opts: { dir: string; limit?: number; json?: boolean }) => {
    const memoryDir = resolveContextDir(opts);
    requireExistingDir(memoryDir, opts.json);

    const episodes = listEpisodes(memoryDir, { limit: opts.limit });

    if (opts.json) {
      console.log(JSON.stringify(episodes, null, 2));
      return;
    }

    if (episodes.length === 0) {
      console.log('No episodes found. Use "mk episode --session-id <id> --summary <text>" to add one.');
      return;
    }

    console.log(`Episodes (${episodes.length}):\n`);
    for (const ep of episodes) {
      const started = ep.metadata.started_at ?? 'unknown';
      const tags = ep.metadata.tags?.join(', ') ?? '';
      console.log(`  ${ep.id}  ${started}${tags ? '  [' + tags + ']' : ''}`);
      const preview = ep.summary.split('\n')[0]?.slice(0, 80) ?? '';
      if (preview) console.log(`    ${preview}`);
    }
  });

// --- mk import ---
program
  .command('import')
  .description('Import a markdown file as memory atoms (heuristic extraction)')
  .requiredOption('--from <file>', 'Source markdown file to import')
  .option('-d, --dir <dir>', 'Memory directory', './memory')
  .option('-t, --type <type>', 'Force atom type for all imported atoms (default: auto-detect)')
  .option('--classification <c>', 'Classification for all atoms (default: TEAM)')
  .option('--agent-id <id>', 'Agent ID', 'cli')
  .option('--session-id <id>', 'Session ID', 'cli-import')
  .option('--dry-run', 'Preview what would be imported without creating atoms')
  .option('--json', 'Output results as JSON')
  .action((opts: {
    from: string;
    dir: string;
    type?: string;
    classification?: string;
    agentId: string;
    sessionId: string;
    dryRun?: boolean;
    json?: boolean;
  }) => {
    const filePath = path.resolve(opts.from);
    const memoryDir = resolveContextDir(opts);

    if (!fs.existsSync(filePath)) {
      exitWithError(`Source file not found: ${filePath}`, opts.json);
    }

    if (opts.dryRun) {
      const chunks = previewImport(filePath);
      const viable = chunks.filter((c) => c.body.trim().length >= 20);
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              dry_run: true,
              source_file: filePath,
              chunks_found: chunks.length,
              would_create: viable.length,
              would_skip: chunks.length - viable.length,
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(`Dry run — would import from: ${filePath}`);
      console.log(`  Chunks found:  ${chunks.length}`);
      console.log(`  Would create:  ${viable.length} atom(s)`);
      console.log(`  Would skip:    ${chunks.length - viable.length} (too short)`);
      return;
    }

    requireExistingDir(memoryDir, opts.json);

    try {
      const result = importFromFile({
        filePath,
        memoryDir,
        agent_id: opts.agentId,
        session_id: opts.sessionId,
        defaultType: opts.type as any,
        defaultClassification: (opts.classification as Classification) ?? 'TEAM',
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`✓ Import completed:`);
      console.log(`  Source:        ${result.source_file}`);
      console.log(`  Atoms created: ${result.atoms_created}`);
      if (result.atoms_skipped > 0) {
        console.log(`  Skipped:       ${result.atoms_skipped} (too short)`);
      }
      if (result.atom_ids.length > 0) {
        console.log(`  IDs:`);
        for (const id of result.atom_ids) {
          console.log(`    ${id}`);
        }
      }
    } catch (err) {
      exitWithError(`Import failed: ${String(err)}`, opts.json);
    }
  });

// --- mk render ---
program
  .command('render')
  .description('Render memory atoms as a CLAUDE.md context file')
  // #123: prefer `-d, --dir` / `-o, --output` to match the rest of the CLI.
  // The positional <memory-dir> / <output-path> form is still accepted as a
  // deprecated fallback (commander treats `[...]` args as optional). A stderr
  // deprecation warning fires on the old shape.
  .argument('[memory-dir]', '[deprecated] Memory directory — use -d/--dir instead')
  .argument('[output-path]', '[deprecated] Output file path — use -o/--output instead')
  .option('-d, --dir <dir>', 'Memory directory', './memory')
  .option('-o, --output <path>', 'Output file path', './CLAUDE.md')
  .option('--max-tokens <n>', 'Token budget for recall', '16000')
  .option('--no-fill', 'Disable fill mode and use task-driven recall instead')
  .option('--json', 'Output results as JSON')
  .action((memoryDirArg: string | undefined, outputPathArg: string | undefined, opts: {
    dir: string;
    output: string;
    maxTokens: string;
    fill?: boolean;
    json?: boolean;
  }) => {
    // Deprecation: positional args still work but warn on stderr. Flag values
    // win when both are provided; positional fills in when the flag was left
    // at its default.
    const usedPositional = !!(memoryDirArg || outputPathArg);
    if (usedPositional) {
      console.error(
        '⚠ Positional <memory-dir> <output-path> arguments are deprecated. ' +
        'Use `mk render -d <dir> -o <path>` instead. (#123)',
      );
    }
    const memoryDir = memoryDirArg ?? opts.dir;
    const outputPath = outputPathArg ?? opts.output;

    const resolvedDir = resolveDir(memoryDir, getAgent());
    const resolvedOutput = path.resolve(outputPath);

    requireExistingDir(resolvedDir, opts.json);

    const maxTokens = parseInt(opts.maxTokens, 10);
    if (isNaN(maxTokens) || maxTokens <= 0) {
      exitWithError('--max-tokens must be a positive integer', opts.json);
    }

    try {
      const agent = getAgent();
      const baseDir = path.resolve(memoryDir);
      const content = agent && isIsolated(baseDir)
        ? renderAgentClaudeMd(baseDir, agent, { maxTokens, fill: opts.fill })
        : renderClaudeMd(resolvedDir, { maxTokens, fill: opts.fill });
      fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
      fs.writeFileSync(resolvedOutput, content);
      const lineCount = content.split('\n').length - 1;
      const stats = parseRenderStats(content);
      const warning = degenerateOutputWarning(stats);

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              output: resolvedOutput,
              memory_dir: resolvedDir,
              total_atoms: stats.totalAtoms,
              line_count: lineCount,
              warning: warning ?? null,
            },
            null,
            2,
          ),
        );
        return;
      }

      console.log(`✓ Rendered ${stats.totalAtoms} atoms → ${resolvedOutput} (${lineCount} lines)`);
      if (warning) console.error(warning);
    } catch (err) {
      exitWithError(`Render failed: ${String(err)}`, opts.json);
    }
  });

// --- mk wander ---
program
  .command('wander')
  .description('Explore memory via spreading activation — find unexpected connections')
  .option('-d, --dir <dir>', 'Memory directory', './memory')
  .option('--seed <ids...>', 'Seed atom IDs to start from')
  .option('--tags <tags...>', 'Seed tags to start from')
  .option('--steps <n>', 'Number of spreading steps', parseInt)
  .option('--threshold <n>', 'Minimum activation threshold (0-1)', parseFloat)
  .option('--top-k <n>', 'Max active atoms per step (lateral inhibition)', parseInt)
  .option('--decay <n>', 'Spread decay factor (0-1)', parseFloat)
  .option('--max-collisions <n>', 'Max collision candidates to return', parseInt)
  .option('--relation-weight <n>', 'Activation weight for explicit relation edges (default: 2.0)', parseFloat)
  .option('--type-weights <json>', 'Per-relation-type weights as JSON, e.g. \'{"extends":1.5,"related":0.3}\'')
  .option('--weight-preset <name>', 'Use a named weight preset: constitution, tension, narrative')
  .option('--no-diverse-seeds', 'Disable type-diverse auto-seed selection (use plain top-N by citation weight)')
  .option('--json', 'Output as JSON')
  .action((opts: {
    dir: string;
    seed?: string[];
    tags?: string[];
    steps?: number;
    threshold?: number;
    topK?: number;
    decay?: number;
    maxCollisions?: number;
    relationWeight?: number;
    typeWeights?: string;
    weightPreset?: string;
    diverseSeeds?: boolean;
    json?: boolean;
  }) => {
    const memoryDir = resolveContextDir(opts);
    requireExistingDir(memoryDir, opts.json);

    const useFiles = !indexExists(memoryDir);
    if (useFiles && !opts.json) {
      console.error('⚠ No index found — falling back to file scan (slower). Run "mk reindex" for faster results.');
    }

    // Resolve type weights: preset > explicit JSON > defaults
    let typeWeights: Record<string, number> | undefined;
    if (opts.weightPreset) {
      typeWeights = WEIGHT_PRESETS[opts.weightPreset];
      if (!typeWeights) {
        exitWithError(`Unknown weight preset: ${opts.weightPreset}. Available: constitution, tension, narrative`, opts.json);
      }
    } else if (opts.typeWeights) {
      try {
        typeWeights = JSON.parse(opts.typeWeights);
      } catch {
        exitWithError(`Invalid --type-weights JSON: ${opts.typeWeights}`, opts.json);
      }
    }

    // In isolated mode, include shared namespace atoms in the wander graph
    const agent = getAgent();
    const baseResolvedDir = path.resolve(opts.dir);
    const sharedMemoryDir = agent && isIsolated(baseResolvedDir)
      ? path.join(baseResolvedDir, 'shared')
      : undefined;

    const wanderFn = useFiles ? wanderFromFiles : wander;
    const result = wanderFn({
      memoryDir,
      sharedMemoryDir,
      baseDir: sharedMemoryDir ? baseResolvedDir : undefined,
      seeds: opts.seed,
      seedTags: opts.tags,
      steps: opts.steps,
      threshold: opts.threshold,
      topK: opts.topK,
      decay: opts.decay,
      maxCollisions: opts.maxCollisions,
      relationWeight: opts.relationWeight,
      typeWeights,
      diverseSeeds: opts.diverseSeeds,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    // Human-readable output
    console.log(`✓ Wander completed in ${result.duration_ms}ms (${result.steps_taken} steps)\n`);
    console.log(`Seeds: ${result.seeds_used.length}`);
    for (const seed of result.seeds_used) {
      console.log(`  ${seed}`);
    }

    console.log(`\nActivated: ${result.activated.length} atoms`);
    for (const atom of result.activated.slice(0, 10)) {
      const tagStr = atom.tags.length > 0 ? ` [${atom.tags.join(', ')}]` : '';
      console.log(`  ${atom.activation.toFixed(3)}  ${atom.type.padEnd(16)} ${atom.atom_id}${tagStr}`);
    }
    if (result.activated.length > 10) {
      console.log(`  ... and ${result.activated.length - 10} more`);
    }

    if (result.collisions.length > 0) {
      console.log(`\nCollisions: ${result.collisions.length}`);
      for (const c of result.collisions) {
        console.log(`\n  Score: ${c.score.toFixed(3)} (distance: ${c.distance})`);
        console.log(`    ${c.type_a}: ${c.atom_a}`);
        console.log(`    ${c.type_b}: ${c.atom_b}`);
        console.log(`    Shared: [${c.shared_tags.join(', ')}]`);
      }
    } else {
      console.log('\nNo collisions found. Try broader seeds or more steps.');
    }
  });

// --- mk closure ---
program
  .command('closure')
  .description('Compute operational closure metrics for a memory store')
  .option('-d, --dir <dir>', 'Memory directory', './memory')
  .option('--json', 'Output as JSON')
  .option('--trajectory', 'Include daily closure trajectory')
  .option('--trajectory-days <n>', 'Limit trajectory to last N days', parseInt)
  .action((opts: { dir: string; json?: boolean; trajectory?: boolean; trajectoryDays?: number }) => {
    const memoryDir = resolveContextDir(opts);
    requireExistingDir(memoryDir, opts.json);

    const result = closure(memoryDir, {
      trajectory: opts.trajectory,
      trajectoryDays: opts.trajectoryDays,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    // Human-readable output
    console.log(`Memory: ${memoryDir}`);
    console.log(`Atoms: ${result.atom_count}`);
    console.log(`Beliefs: ${result.belief_count} (${result.belief_pct}%)`);
    console.log('');

    console.log('Closure Metrics:');
    console.log(`  Closure index:    ${result.closure_index}`);
    console.log(`  Avg relations:    ${result.avg_relations}`);
    console.log(`  Avg body refs:    ${result.avg_body_refs}`);
    console.log(`  Entanglement:     ${result.entanglement_pct}%`);
    console.log(`  Phase:            ${result.phase}`);
    console.log('');

    if (Object.keys(result.by_type).length > 0) {
      console.log('By type:');
      for (const [type, count] of Object.entries(result.by_type).sort()) {
        console.log(`  ${type}: ${count}`);
      }
      console.log('');
    }

    if (Object.keys(result.relation_types).length > 0) {
      console.log('Relation types:');
      for (const [type, count] of Object.entries(result.relation_types).sort()) {
        console.log(`  ${type}: ${count}`);
      }
      console.log('');
    }

    console.log('Predictions:');
    for (const p of result.predictions) {
      const icon = p.status === 'reliable' ? '✓' : p.status === 'degraded' ? '⚠' : '?';
      console.log(`  ${icon} ${p.tool}: ${p.detail}`);
    }

    if (result.trajectory.length > 0) {
      console.log('\nTrajectory:');
      const cols = [
        { label: 'Date', width: 10, get: (t: typeof result.trajectory[0]) => t.date },
        { label: 'Atoms', width: 7, get: (t: typeof result.trajectory[0]) => String(t.atoms) },
        { label: 'Beliefs', width: 7, get: (t: typeof result.trajectory[0]) => String(t.beliefs) },
        { label: 'Belief%', width: 7, get: (t: typeof result.trajectory[0]) => `${t.belief_pct}%` },
        { label: 'AvgRel', width: 7, get: (t: typeof result.trajectory[0]) => String(t.avg_relations) },
        { label: 'AvgRef', width: 7, get: (t: typeof result.trajectory[0]) => String(t.avg_body_refs) },
        { label: 'Closure', width: 7, get: (t: typeof result.trajectory[0]) => String(t.closure_index) },
      ];
      // Widen columns if any value exceeds the default width
      for (const t of result.trajectory) {
        for (const col of cols) {
          col.width = Math.max(col.width, col.get(t).length);
        }
      }
      console.log('  ' + cols.map(c => c.label.padStart(c.width)).join('  '));
      for (const t of result.trajectory) {
        console.log('  ' + cols.map(c => c.get(t).padStart(c.width)).join('  '));
      }
    }
  });

// --- mk share ---
program
  .command('share')
  .description('Copy an atom from an agent store to the shared namespace (snapshot)')
  .argument('<atom-id>', 'Atom ID to share')
  .requiredOption('--from <agent>', 'Agent ID that owns the atom')
  .option('-d, --dir <dir>', 'Memory directory', './memory')
  .option('--agent-id <id>', 'Agent ID for event log', 'cli')
  .option('--session-id <id>', 'Session ID for event log', 'cli-session')
  .option('--json', 'Output as JSON')
  .action((atomId: string, opts: { from: string; dir: string; agentId: string; sessionId: string; json?: boolean }) => {
    const baseDir = path.resolve(opts.dir);
    requireExistingDir(baseDir, opts.json, { hint: false });
    if (!isIsolated(baseDir)) {
      exitWithError('share requires per-agent isolation mode (set isolation: per-agent in config.yaml)', opts.json);
    }

    try {
      const result = shareAtom(baseDir, atomId, opts.from, {
        agent_id: opts.agentId,
        session_id: opts.sessionId,
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`✓ Shared: ${result.atom_id}`);
      console.log(`  From: ${result.source_agent}`);
      console.log(`  To: shared/${path.basename(result.shared_path)}`);
    } catch (err) {
      exitWithError(`Share failed: ${String(err)}`, opts.json);
    }
  });

// --- mk unshare ---
program
  .command('unshare')
  .description('Remove an atom from the shared namespace')
  .argument('<atom-id>', 'Atom ID to unshare')
  .option('-d, --dir <dir>', 'Memory directory', './memory')
  .option('--agent-id <id>', 'Agent ID for event log', 'cli')
  .option('--session-id <id>', 'Session ID for event log', 'cli-session')
  .option('--json', 'Output as JSON')
  .action((atomId: string, opts: { dir: string; agentId: string; sessionId: string; json?: boolean }) => {
    const baseDir = path.resolve(opts.dir);
    requireExistingDir(baseDir, opts.json, { hint: false });
    if (!isIsolated(baseDir)) {
      exitWithError('unshare requires per-agent isolation mode (set isolation: per-agent in config.yaml)', opts.json);
    }

    try {
      unshareAtom(baseDir, atomId, {
        agent_id: opts.agentId,
        session_id: opts.sessionId,
      });

      if (opts.json) {
        console.log(JSON.stringify({ atom_id: atomId, unshared: true }, null, 2));
        return;
      }

      console.log(`✓ Unshared: ${atomId}`);
    } catch (err) {
      exitWithError(`Unshare failed: ${String(err)}`, opts.json);
    }
  });

// --- mk migrate ---
program
  .command('migrate')
  .description('Migrate a shared-mode store to per-agent isolation')
  .option('-d, --dir <dir>', 'Memory directory', './memory')
  .option('--strategy <strategy>', 'Migration strategy: fresh, partition, clone-to-shared', 'fresh')
  .option('--assign-untagged <agent>', 'Agent ID for untagged atoms (partition strategy)', 'main')
  .option('--json', 'Output as JSON')
  .action((opts: { dir: string; strategy: string; assignUntagged: string; json?: boolean }) => {
    const baseDir = path.resolve(opts.dir);
    requireExistingDir(baseDir, opts.json, { hint: false });

    const strategy = opts.strategy as 'fresh' | 'partition' | 'clone-to-shared';
    if (!['fresh', 'partition', 'clone-to-shared'].includes(strategy)) {
      exitWithError(`Unknown strategy: ${opts.strategy}. Use: fresh, partition, clone-to-shared`, opts.json);
    }

    try {
      const result = migrate({
        baseDir,
        strategy,
        assignUntagged: opts.assignUntagged,
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`✓ Migration complete (strategy: ${result.strategy})`);
      if (result.agents_created.length > 0) {
        console.log(`  Agents created: ${result.agents_created.join(', ')}`);
      }
      if (result.atoms_moved > 0) {
        console.log(`  Atoms moved: ${result.atoms_moved}`);
      }
      if (result.atoms_shared > 0) {
        console.log(`  Atoms shared: ${result.atoms_shared}`);
      }
      console.log(`  Config written: ${result.config_written}`);
    } catch (err) {
      exitWithError(`Migration failed: ${String(err)}`, opts.json);
    }
  });

// --- Phase 3: Relation commands ---
registerRelateCommand(program);
registerRelationsCommand(program);
registerMigrateRelationsCommand(program);
registerRelinkCommand(program);
registerCitationsCommand(program);
registerEnrichRelationsCommand(program);
registerLintCommand(program);
registerGroundingCommand(program);
registerEvalCommand(program);
registerExtractCommand(program);
registerConsolidateCommand(program);
registerExportObsidianCommand(program);
registerObsidianInitCommand(program);
registerObserveCommand(program);
registerSupersedeCommand(program);
registerSeedCommand(program);
registerUpgradeCommand(program);
registerExecuteCommand(program);
registerEditCommand(program);

// Rewrite argv to strip/translate deprecated flags before commander parses.
// Without this, `mk render --fill` (from an old wrapper) would fail with a
// bare "unknown option" error instead of a migration hint (#141).
const rewrittenArgv = processDeprecatedFlags(process.argv.slice(2));
program.parse(rewrittenArgv, { from: 'user' });
