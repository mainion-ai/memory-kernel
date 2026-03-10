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
} from '../index.js';
import { recall } from '../recall.js';
import { reflect } from '../reflect.js';
import { checkpoint } from '../checkpoint.js';
import { bootstrapEvents } from '../bootstrap.js';
import { replayFromFile } from '../replay.js';
import { compactLog } from '../event-log.js';

const program = new Command();

program
  .name('mk')
  .description('Memory Kernel CLI — manage AI agent memory')
  .version(pkg.version);

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
  .action((opts: { dir: string }) => {
    const memoryDir = path.resolve(opts.dir);
    if (!fs.existsSync(memoryDir)) {
      console.error(`✗ Memory directory not found: ${memoryDir}`);
      console.error('  Run "mk init" first.');
      process.exit(1);
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
  .option('-t, --task <task>', 'Task description')
  .option('--paths <paths...>', 'Scope paths to match')
  .option('--types <types...>', 'Filter by atom type')
  .option('--max-tokens <n>', 'Token budget', parseInt)
  .action((opts: { dir: string; task?: string; paths?: string[]; types?: string[]; maxTokens?: number }) => {
    const memoryDir = path.resolve(opts.dir);
    if (!fs.existsSync(memoryDir)) {
      console.error(`✗ Memory directory not found: ${memoryDir}`);
      console.error('  Run "mk init" first.');
      process.exit(1);
    }
    const bundle = recall(memoryDir, {
      task: opts.task,
      paths: opts.paths,
      types: opts.types as any,
      max_tokens: opts.maxTokens,
    });

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
  .action((opts: {
    dir: string; task?: string; maxTokens?: number;
    agentId: string; sessionId: string; reflect: boolean;
  }) => {
    const memoryDir = path.resolve(opts.dir);
    if (!fs.existsSync(memoryDir)) {
      console.error(`✗ Memory directory not found: ${memoryDir}`);
      process.exit(1);
    }

    const result = checkpoint({
      memoryDir,
      agent_id: opts.agentId,
      session_id: opts.sessionId,
      task: opts.task,
      max_tokens: opts.maxTokens,
      skipReflect: !opts.reflect,
    });

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
  .action((opts: { dir: string; agentId: string; sessionId: string }) => {
    const memoryDir = path.resolve(opts.dir);
    if (!fs.existsSync(memoryDir)) {
      console.error(`✗ Memory directory not found: ${memoryDir}`);
      console.error('  Run "mk init" first.');
      process.exit(1);
    }
    const result = reflect({
      memoryDir,
      agent_id: opts.agentId,
      session_id: opts.sessionId,
    });

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
  .action((opts: { dir: string; agentId: string; sessionId: string }) => {
    const memoryDir = path.resolve(opts.dir);
    if (!fs.existsSync(memoryDir)) {
      console.error(`✗ Memory directory not found: ${memoryDir}`);
      console.error('  Run "mk init" first.');
      process.exit(1);
    }
    // GC is just reflect with focus on expiry
    const result = reflect({
      memoryDir,
      agent_id: opts.agentId,
      session_id: opts.sessionId,
    });

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
  .action((opts: { dir: string }) => {
    const memoryDir = path.resolve(opts.dir);
    if (!fs.existsSync(memoryDir)) {
      console.error(`✗ Memory directory not found: ${memoryDir}`);
      console.error('  Run "mk init" first.');
      process.exit(1);
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
  .action((opts: { dir: string }) => {
    const memoryDir = path.resolve(opts.dir);
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
  .action((body: string, opts: {
    dir: string; type: string; confidence?: number;
    slug?: string; tags?: string[];
    agentId: string; sessionId: string;
  }) => {
    const memoryDir = path.resolve(opts.dir);
    if (!fs.existsSync(memoryDir)) {
      console.error(`✗ Memory directory not found: ${memoryDir}`);
      process.exit(1);
    }

    // Generate slug from body if not provided
    const slug = opts.slug ?? body
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);

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

    console.log(`✓ Created: ${atom.frontmatter.id}`);
    console.log(`  Type: ${atom.frontmatter.type}, Status: ${atom.frontmatter.status}`);
    console.log(`  Confidence: ${atom.frontmatter.confidence}`);
    if (opts.tags) console.log(`  Tags: ${opts.tags.join(', ')}`);
  });

// --- mk bootstrap-events ---
program
  .command('bootstrap-events')
  .description('Migrate existing atoms into V2 event log (prepends atom_imported events)')
  .option('-d, --dir <dir>', 'Memory directory', './memory')
  .option('--agent-id <id>', 'Agent ID', 'cli')
  .option('--session-id <id>', 'Session ID', 'cli-bootstrap')
  .action((opts: { dir: string; agentId: string; sessionId: string }) => {
    const memoryDir = path.resolve(opts.dir);
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
  .action((opts: { dir: string }) => {
    const memoryDir = path.resolve(opts.dir);
    if (!fs.existsSync(memoryDir)) {
      console.error(`✗ Memory directory not found: ${memoryDir}`);
      console.error('  Run "mk init" first.');
      process.exit(1);
    }

    try {
      const result = compactLog(memoryDir);

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
      console.error(`✗ Compact failed: ${String(err)}`);
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

program.parse();
