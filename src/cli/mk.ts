#!/usr/bin/env node

/**
 * mk — Memory Kernel CLI
 *
 * Usage:
 *   mk init [dir]              Initialize a memory directory
 *   mk checkpoint              Generate a checkpoint/handoff
 *   mk recall [--task "..."]   Load relevant context
 *   mk reflect                 Consolidate, TTL, promote, dedup
 *   mk gc                      Archive expired atoms
 *   mk doctor                  Validate schema, links, conflicts
 *   mk status                  Show memory stats
 *   mk wander                  Explore memory via spreading activation
 *   mk closure                 Compute operational closure metrics
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
import { recall } from '../recall.js';
import { reflect } from '../reflect.js';
import { checkpoint } from '../checkpoint.js';
import { bootstrapEvents } from '../bootstrap.js';
import { replayFromFile } from '../replay.js';
import { compactLog } from '../event-log.js';
import { writeEpisode, listEpisodes } from '../episodes.js';
import { mergeEventLogs } from '../merge.js';
import { importFromFile, previewImport } from '../import.js';
import { renderClaudeMd } from '../render.js';
import { wander, wanderFromFiles, WEIGHT_PRESETS } from '../wander.js';
import { embedAtom, embedAllAtoms } from '../embed-sync.js';
import type { Classification } from '../types.js';
import { registerRelateCommand, registerRelationsCommand } from './relate.js';
import { registerMigrateRelationsCommand } from './migrate-relations.js';
import { registerRelinkCommand } from './relink.js';
import { registerCitationsCommand } from './citations.js';
import { registerEnrichRelationsCommand } from './enrich-relations.js';
import { closure } from '../closure.js';
import { isIsolated, initSharedStore, listAgents } from '../isolation.js';
import { shareAtom, unshareAtom, listSharedAtoms } from '../share.js';
import { migrate } from '../migrate.js';
import { resolveDir as resolveDirBase } from './resolve-dir.js';

const program = new Command();

/** JSON-aware error exit: emits structured JSON when --json is active, plain text otherwise. */
function exitWithError(message: string, json?: boolean): never {
  if (json) {
    console.log(JSON.stringify({ error: message }, null, 2));
  } else {
    console.error(`✗ ${message}`);
  }
  process.exit(1);
}

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

// --- mk init ---
program
  .command('init')
  .description('Initialize a memory directory with canonical layout')
  .argument('[dir]', 'Directory to initialize', './memory')
  .action((dir: string) => {
    const memoryDir = path.resolve(dir);
    initMemoryDir(memoryDir);
    console.log(`✓ Memory initialized at ${memoryDir}`);
    console.log('  Created: INDEX.md, HANDOFF.md, DECISIONS.md, CONSTRAINTS.md, OPEN_QUESTIONS.md');
    console.log('  Created: ENTITIES/, EPISODES/, EVIDENCE/, CONFLICTS/, ARCHIVE/');
    console.log('  Created: events.ndjson');
  });

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

    const memoryDir = resolveDir(opts.dir, getAgent());
    if (!fs.existsSync(memoryDir)) {
      exitWithError(`Memory directory not found: ${memoryDir}\n  Run "mk init" first.`, opts.json);
    }

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
  .option('--graph', 'Enable graph-relation neighbor boost (default: on)')
  .option('--no-graph', 'Disable graph-relation neighbor boost')
  .option('--json', 'Output as JSON')
  .action((opts: {
    dir: string;
    task?: string;
    paths?: string[];
    types?: string[];
    maxTokens?: number;
    decayHalfLife?: number;
    decayWeight?: number;
    includeEpisodes?: boolean;
    graph: boolean; // Commander sets this to true/false via --graph/--no-graph
    json?: boolean;
  }) => {
    const memoryDir = resolveDir(opts.dir, getAgent());
    if (!fs.existsSync(memoryDir)) {
      exitWithError(`Memory directory not found: ${memoryDir}\n  Run "mk init" first.`, opts.json);
    }
    const bundle = recall(memoryDir, {
      task: opts.task,
      paths: opts.paths,
      types: opts.types as any,
      max_tokens: opts.maxTokens,
      decay_half_life: opts.decayHalfLife,
      decay_weight: opts.decayWeight,
      include_episodes: opts.includeEpisodes,
      graph_boost: opts.graph,
    });

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
  .action((opts: {
    dir: string; task?: string; maxTokens?: number;
    agentId: string; sessionId: string; reflect: boolean; json?: boolean;
  }) => {
    const memoryDir = resolveDir(opts.dir, getAgent());
    if (!fs.existsSync(memoryDir)) {
      exitWithError(`Memory directory not found: ${memoryDir}`, opts.json);
    }

    const result = checkpoint({
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
  .option('--json', 'Output as JSON')
  .action((opts: { dir: string; agentId: string; sessionId: string; json?: boolean }) => {
    const memoryDir = resolveDir(opts.dir, getAgent());
    if (!fs.existsSync(memoryDir)) {
      exitWithError(`Memory directory not found: ${memoryDir}\n  Run "mk init" first.`, opts.json);
    }
    const result = reflect({
      memoryDir,
      agent_id: opts.agentId,
      session_id: opts.sessionId,
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
    const memoryDir = resolveDir(opts.dir, getAgent());
    if (!fs.existsSync(memoryDir)) {
      exitWithError(`Memory directory not found: ${memoryDir}\n  Run "mk init" first.`, opts.json);
    }
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
program
  .command('doctor')
  .description('Validate memory: schema, links, conflicts')
  .option('-d, --dir <dir>', 'Memory directory', './memory')
  .option('--json', 'Output as JSON')
  .action((opts: { dir: string; json?: boolean }) => {
    const memoryDir = resolveDir(opts.dir, getAgent());
    if (!fs.existsSync(memoryDir)) {
      exitWithError(`Memory directory not found: ${memoryDir}\n  Run "mk init" first.`, opts.json);
    }
    const atoms = listAtoms(memoryDir);
    const issues: string[] = [];

    // Check schema
    for (const atom of atoms) {
      const result = validateAtomFrontmatter(atom.frontmatter);
      if (!result.success) {
        issues.push(`Schema: ${atom.frontmatter.id} — ${JSON.stringify(result.error.issues)}`);
      }
    }

    // Check for broken links
    const allIds = new Set(atoms.map((a) => a.frontmatter.id));
    for (const atom of atoms) {
      const links = [
        ...(atom.frontmatter.links?.related ?? []),
        ...(atom.frontmatter.links?.supersedes ?? []),
        ...(atom.frontmatter.links?.blocked_by ?? []),
      ];
      for (const link of links) {
        if (!allIds.has(link)) {
          issues.push(`Broken link: ${atom.frontmatter.id} → ${link}`);
        }
      }
    }

    // Check for active conflicts
    const conflicts = atoms.filter(
      (a) => a.frontmatter.type === 'conflict' && a.frontmatter.status === 'active',
    );
    for (const c of conflicts) {
      issues.push(`Active conflict: ${c.frontmatter.id}`);
    }

    if (opts.json) {
      console.log(JSON.stringify({
        healthy: issues.length === 0,
        issue_count: issues.length,
        issues,
      }, null, 2));
      if (issues.length > 0) process.exit(1);
      return;
    }

    if (issues.length === 0) {
      console.log('✓ Memory is healthy. No issues found.');
    } else {
      console.log(`✗ Found ${issues.length} issue(s):\n`);
      for (const issue of issues) {
        console.log(`  - ${issue}`);
      }
      process.exit(1);
    }
  });

// --- mk reindex ---
program
  .command('reindex')
  .description('Rebuild SQLite index from atom files')
  .option('-d, --dir <dir>', 'Memory directory', './memory')
  .option('--embed', 'Also (re)compute embeddings for all atoms')
  .action(async (opts: { dir: string; embed?: boolean }) => {
    const memoryDir = resolveDir(opts.dir, getAgent());
    if (!fs.existsSync(memoryDir)) {
      console.error(`✗ Memory directory not found: ${memoryDir}`);
      process.exit(1);
    }

    console.log(`Rebuilding index for ${memoryDir}...`);
    const result = reindex(memoryDir);
    console.log(`✓ Indexed ${result.indexed} atoms in ${result.timeMs}ms`);

    const stats = indexStats(memoryDir);
    if (stats) {
      console.log(`  Atoms: ${stats.atoms}, Tags: ${stats.tags}, Paths: ${stats.paths}`);
    }

    // Optionally (re)compute embeddings
    if (opts.embed) {
      console.log(`\nEmbedding atoms...`);
      const embedResult = await embedAllAtoms(memoryDir, {
        onProgress: (done, total) => {
          process.stdout.write(`\r  Progress: ${done}/${total}`);
        },
      });
      console.log(''); // newline after progress
      console.log(`✓ Embeddings: ${embedResult.embedded} embedded, ${embedResult.skipped} skipped, ${embedResult.errors} errors (${embedResult.timeMs}ms)`);
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
    const memoryDir = resolveDir(opts.dir, getAgent());
    if (!fs.existsSync(memoryDir)) {
      exitWithError(`Memory directory not found: ${memoryDir}`, opts.json);
    }

    // Generate slug from body if not provided; fall back to timestamp if body yields empty string
    const slug = (opts.slug ?? body
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40)) || `atom-${Date.now()}`;

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
      }, null, 2));
      return;
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
  .action((opts: { dir: string; agentId: string; sessionId: string }) => {
    const memoryDir = resolveDir(opts.dir, getAgent());
    if (!fs.existsSync(memoryDir)) {
      console.error(`✗ Memory directory not found: ${memoryDir}`);
      process.exit(1);
    }

    const result = bootstrapEvents({
      memoryDir,
      agent_id: opts.agentId,
      session_id: opts.sessionId,
    });

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
    const memoryDir = resolveDir(opts.dir, getAgent());
    if (!fs.existsSync(memoryDir)) {
      exitWithError(`Memory directory not found: ${memoryDir}\n  Run "mk init" first.`, opts.json);
    }

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
  .action((opts: { from: string; dir: string; agentId: string; sessionId: string; dryRun?: boolean }) => {
    const localDir = resolveDir(opts.dir, getAgent());
    const remoteDir = path.resolve(opts.from);

    if (!fs.existsSync(localDir)) {
      console.error(`✗ Local memory directory not found: ${localDir}`);
      console.error('  Run "mk init" first.');
      process.exit(1);
    }

    if (!fs.existsSync(remoteDir)) {
      console.error(`✗ Remote directory not found: ${remoteDir}`);
      process.exit(1);
    }

    if (opts.dryRun) {
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
      console.error(`✗ Merge failed: ${String(err)}`);
      process.exit(1);
    }
  });

// --- mk replay ---
program
  .command('replay')
  .description('Replay events to reconstruct state')
  .requiredOption('--from <file>', 'Events NDJSON file to replay')
  .option('--output-dir <dir>', 'Write reconstructed atoms and views to this directory')
  .option('--evidence-dir <dir>', 'Directory containing evidence blobs')
  .action((opts: { from: string; outputDir?: string; evidenceDir?: string }) => {
    const eventsFile = path.resolve(opts.from);
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
    const memoryDir = resolveDir(opts.dir, getAgent());
    if (!fs.existsSync(memoryDir)) {
      exitWithError(`Memory directory not found: ${memoryDir}\n  Run "mk init" first.`, opts.json);
    }

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
    const memoryDir = resolveDir(opts.dir, getAgent());
    if (!fs.existsSync(memoryDir)) {
      exitWithError(`Memory directory not found: ${memoryDir}\n  Run "mk init" first.`, opts.json);
    }

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
  .action((opts: {
    from: string;
    dir: string;
    type?: string;
    classification?: string;
    agentId: string;
    sessionId: string;
    dryRun?: boolean;
  }) => {
    const filePath = path.resolve(opts.from);
    const memoryDir = resolveDir(opts.dir, getAgent());

    if (!fs.existsSync(filePath)) {
      console.error(`✗ Source file not found: ${filePath}`);
      process.exit(1);
    }

    if (opts.dryRun) {
      const chunks = previewImport(filePath);
      const viable = chunks.filter((c) => c.body.trim().length >= 20);
      console.log(`Dry run — would import from: ${filePath}`);
      console.log(`  Chunks found:  ${chunks.length}`);
      console.log(`  Would create:  ${viable.length} atom(s)`);
      console.log(`  Would skip:    ${chunks.length - viable.length} (too short)`);
      return;
    }

    if (!fs.existsSync(memoryDir)) {
      console.error(`✗ Memory directory not found: ${memoryDir}`);
      console.error('  Run "mk init" first.');
      process.exit(1);
    }

    try {
      const result = importFromFile({
        filePath,
        memoryDir,
        agent_id: opts.agentId,
        session_id: opts.sessionId,
        defaultType: opts.type as any,
        defaultClassification: (opts.classification as Classification) ?? 'TEAM',
      });

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
      console.error(`✗ Import failed: ${String(err)}`);
      process.exit(1);
    }
  });

// --- mk render ---
program
  .command('render')
  .description('Render memory atoms as a CLAUDE.md context file')
  .argument('<memory-dir>', 'Memory directory')
  .argument('<output-path>', 'Output file path')
  .option('--max-tokens <n>', 'Token budget for recall', '8000')
  .action((memoryDir: string, outputPath: string, opts: { maxTokens: string }) => {
    const resolvedDir = resolveDir(memoryDir, getAgent());
    const resolvedOutput = path.resolve(outputPath);

    if (!fs.existsSync(resolvedDir)) {
      console.error(`✗ Memory directory not found: ${resolvedDir}`);
      console.error('  Run "mk init" first.');
      process.exit(1);
    }

    const maxTokens = parseInt(opts.maxTokens, 10);
    if (isNaN(maxTokens) || maxTokens <= 0) {
      console.error('✗ --max-tokens must be a positive integer');
      process.exit(1);
    }

    try {
      const content = renderClaudeMd(resolvedDir, { maxTokens });
      fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
      fs.writeFileSync(resolvedOutput, content);
      const lineCount = content.split('\n').length - 1;
      const atomCount = (content.match(/^### /gm) ?? []).length;
      console.log(`✓ Rendered ${atomCount} atoms → ${resolvedOutput} (${lineCount} lines)`);
    } catch (err) {
      console.error(`✗ Render failed: ${String(err)}`);
      process.exit(1);
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
    json?: boolean;
  }) => {
    const memoryDir = resolveDir(opts.dir, getAgent());
    if (!fs.existsSync(memoryDir)) {
      exitWithError(`Memory directory not found: ${memoryDir}\n  Run "mk init" first.`, opts.json);
    }

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

    const wanderFn = useFiles ? wanderFromFiles : wander;
    const result = wanderFn({
      memoryDir,
      seeds: opts.seed,
      seedTags: opts.tags,
      steps: opts.steps,
      threshold: opts.threshold,
      topK: opts.topK,
      decay: opts.decay,
      maxCollisions: opts.maxCollisions,
      relationWeight: opts.relationWeight,
      typeWeights,
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
    const memoryDir = resolveDir(opts.dir, getAgent());
    if (!fs.existsSync(memoryDir)) {
      exitWithError(`Memory directory not found: ${memoryDir}\n  Run "mk init" first.`, opts.json);
    }

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
    if (!fs.existsSync(baseDir)) {
      exitWithError(`Memory directory not found: ${baseDir}`, opts.json);
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
    if (!fs.existsSync(baseDir)) {
      exitWithError(`Memory directory not found: ${baseDir}`, opts.json);
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
  .option('--agent-id <id>', 'Agent ID for event log', 'cli')
  .option('--session-id <id>', 'Session ID for event log', 'cli-session')
  .option('--json', 'Output as JSON')
  .action((opts: { dir: string; strategy: string; assignUntagged: string; agentId: string; sessionId: string; json?: boolean }) => {
    const baseDir = path.resolve(opts.dir);
    if (!fs.existsSync(baseDir)) {
      exitWithError(`Memory directory not found: ${baseDir}`, opts.json);
    }

    const strategy = opts.strategy as 'fresh' | 'partition' | 'clone-to-shared';
    if (!['fresh', 'partition', 'clone-to-shared'].includes(strategy)) {
      exitWithError(`Unknown strategy: ${opts.strategy}. Use: fresh, partition, clone-to-shared`, opts.json);
    }

    try {
      const result = migrate({
        baseDir,
        strategy,
        assignUntagged: opts.assignUntagged,
        agent_id: opts.agentId,
        session_id: opts.sessionId,
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

program.parse();
