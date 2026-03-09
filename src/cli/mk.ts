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
import {
  initMemoryDir,
  listAtoms,
  countEvents,
  readEvents,
  validateAtomFrontmatter,
} from '../index.js';
import { recall } from '../recall.js';
import { reflect } from '../reflect.js';

const program = new Command();

program
  .name('mk')
  .description('Memory Kernel CLI — manage AI agent memory')
  .version('0.1.0');

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

// --- mk reflect ---
program
  .command('reflect')
  .description('Consolidate memory: dedup, TTL, promote, detect conflicts')
  .option('-d, --dir <dir>', 'Memory directory', './memory')
  .option('--agent-id <id>', 'Agent ID', 'cli')
  .option('--session-id <id>', 'Session ID', 'cli-session')
  .action((opts: { dir: string; agentId: string; sessionId: string }) => {
    const memoryDir = path.resolve(opts.dir);
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
    // GC is just reflect with focus on expiry
    const result = reflect({
      memoryDir,
      agent_id: opts.agentId,
      session_id: opts.sessionId,
    });

    console.log('✓ GC completed:');
    console.log(`  Expired:  ${result.expired}`);
    console.log(`  Archived: ${result.archived}`);
  });

// --- mk doctor ---
program
  .command('doctor')
  .description('Validate memory: schema, links, conflicts')
  .option('-d, --dir <dir>', 'Memory directory', './memory')
  .action((opts: { dir: string }) => {
    const memoryDir = path.resolve(opts.dir);
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

program.parse();
