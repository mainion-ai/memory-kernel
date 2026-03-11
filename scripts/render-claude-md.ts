#!/usr/bin/env npx tsx

/**
 * Render memory kernel state into a CLAUDE.md file.
 * Bridge between memory-kernel and NanoClaw's group memory system.
 *
 * Usage:
 *   npx tsx scripts/render-claude-md.ts <memory-dir> <output-path>
 *
 * Example:
 *   npx tsx scripts/render-claude-md.ts /home/np/repos/memory/kernel /home/np/Documents/nanoclaw/groups/telegram_main/CLAUDE.md
 */

import { recall, listAtoms, countEvents, readView } from '../src/index.js';

const memoryDir = process.argv[2];
const outputPath = process.argv[3];

if (!memoryDir || !outputPath) {
  console.error('Usage: render-claude-md.ts <memory-dir> <output-path>');
  process.exit(1);
}

import fs from 'fs';

// Recall everything relevant
const bundle = recall(memoryDir);
const atoms = listAtoms(memoryDir);
const active = atoms.filter(
  (a) => a.frontmatter.status !== 'archived' && a.frontmatter.status !== 'expired',
);

// Group by type
const facts = active.filter((a) => a.frontmatter.type === 'fact');
const decisions = active.filter((a) => a.frontmatter.type === 'decision');
const constraints = active.filter((a) => a.frontmatter.type === 'constraint');
const openQuestions = active.filter((a) => a.frontmatter.type === 'open_question');
const preferences = active.filter((a) => a.frontmatter.type === 'preference');
const beliefs = active.filter((a) => a.frontmatter.type === 'belief');
const conflicts = active.filter((a) => a.frontmatter.type === 'conflict');

// Build CLAUDE.md
const lines: string[] = [];

lines.push('# Memory');
lines.push('');
lines.push(`> Auto-generated from memory-kernel. ${active.length} atoms, ${countEvents(memoryDir)} events.`);
lines.push(`> Last rendered: ${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}`);
lines.push(`> Source: ${memoryDir}`);
lines.push('');

// Conflicts first (most urgent)
if (conflicts.length > 0) {
  lines.push('## ⚠ Active Conflicts');
  lines.push('');
  for (const c of conflicts) {
    lines.push(`### ${c.frontmatter.id}`);
    lines.push(c.body.trim());
    lines.push('');
  }
}

// Key facts
if (facts.length > 0) {
  lines.push('## Key Facts');
  lines.push('');
  for (const f of facts) {
    lines.push(`### ${f.frontmatter.id}`);
    lines.push(f.body.trim());
    lines.push('');
  }
}

// Decisions
if (decisions.length > 0) {
  lines.push('## Decisions');
  lines.push('');
  for (const d of decisions) {
    const dConfSuffix = d.frontmatter.confidence !== undefined ? ` (confidence: ${d.frontmatter.confidence})` : '';
    lines.push(`### ${d.frontmatter.id}${dConfSuffix}`);
    lines.push(d.body.trim());
    lines.push('');
  }
}

// Constraints
if (constraints.length > 0) {
  lines.push('## Constraints');
  lines.push('');
  for (const c of constraints) {
    lines.push(`### ${c.frontmatter.id}`);
    lines.push(c.body.trim());
    lines.push('');
  }
}

// Open questions
if (openQuestions.length > 0) {
  lines.push('## Open Questions');
  lines.push('');
  for (const q of openQuestions) {
    lines.push(`### ${q.frontmatter.id}`);
    lines.push(q.body.trim());
    lines.push('');
  }
}

// Preferences
if (preferences.length > 0) {
  lines.push('## Preferences');
  lines.push('');
  for (const p of preferences) {
    lines.push(`### ${p.frontmatter.id}`);
    lines.push(p.body.trim());
    lines.push('');
  }
}

// Beliefs (lower priority)
if (beliefs.length > 0) {
  lines.push('## Beliefs (unverified)');
  lines.push('');
  for (const b of beliefs) {
    const bConfSuffix = b.frontmatter.confidence !== undefined ? ` (confidence: ${b.frontmatter.confidence})` : '';
    lines.push(`### ${b.frontmatter.id}${bConfSuffix}`);
    lines.push(b.body.trim());
    lines.push('');
  }
}

const content = lines.join('\n') + '\n';

// Write output
import path from 'path';
fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
fs.writeFileSync(outputPath, content);

const lineCount = content.split('\n').length;
console.log(`✓ Rendered ${active.length} atoms → ${outputPath} (${lineCount} lines)`);
