#!/usr/bin/env npx tsx
/**
 * ttl-backfill.ts — Retroactively set ttl_days on existing atoms that lack it.
 *
 * Policy:
 *   - beliefs: null (never expire — developmental, constitute identity)
 *   - facts: 120 days (operational facts go stale; conflict detection handles updates)
 *   - decisions: 180 days (architectural decisions stay relevant longer)
 *   - preferences: null (preferences persist until explicitly changed)
 *   - open_questions: 90 days (if not resolved in 90 days, likely stale)
 *   - process: 60 days (process notes are highly temporal)
 *
 * Candidates for immediate archival (--archive flag):
 *   - Facts about completed migrations (hw-migration, beelink-migration) older than 30 days
 *   - Process atoms older than 60 days
 *   - Open questions older than 90 days with no updates
 *
 * Usage:
 *   npx tsx scripts/ttl-backfill.ts --dir ~/mk-memory/kernel [--dry-run] [--archive]
 */

import fs from 'fs';
import path from 'path';
import { parseArgs } from 'node:util';
import { assertWithinDir } from '../src/store.js';

const { values } = parseArgs({
  options: {
    dir: { type: 'string', short: 'd' },
    'dry-run': { type: 'boolean', default: false },
    archive: { type: 'boolean', default: false },
  },
});

const memoryDir = values.dir || process.env.MEMORY_DIR || path.join(process.env.HOME!, 'mk-memory/kernel');
const dryRun = values['dry-run'] ?? false;
const doArchive = values.archive ?? false;

const TTL_POLICY: Record<string, number | null> = {
  belief: null,
  fact: 120,
  decision: 180,
  preference: null,
  open_question: 90,
  process: 60,
};

// Patterns that indicate stale/completed content (archive candidates)
const ARCHIVE_PATTERNS = [
  /hw-migration/i,
  /beelink-migration.*status/i,
  /nanoclaw.*1-2-12/i,  // old version-specific process
];

const entitiesDir = path.join(memoryDir, 'ENTITIES');
if (!fs.existsSync(entitiesDir)) {
  console.error(`ENTITIES dir not found: ${entitiesDir}`);
  process.exit(1);
}

const files = fs.readdirSync(entitiesDir).filter(f => f.endsWith('.md'));
const now = new Date();

let ttlSet = 0;
let archiveCandidates: string[] = [];
let alreadyHasTtl = 0;

for (const file of files) {
  const fp = path.join(entitiesDir, file);
  assertWithinDir(memoryDir, fp);
  const content = fs.readFileSync(fp, 'utf-8');

  // Parse frontmatter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) continue;

  const fm = fmMatch[1];
  const typeMatch = fm.match(/^type:\s*"?(\w+)"?/m);
  const ttlMatch = fm.match(/^ttl_days:\s*(.+)/m);
  const createdMatch = fm.match(/^created_at:\s*"?([^"\n]+)"?/m);
  const updatedMatch = fm.match(/^updated_at:\s*"?([^"\n]+)"?/m);

  if (!typeMatch) continue;
  const type = typeMatch[1];
  const currentTtl = ttlMatch?.[1]?.trim();
  const createdAt = createdMatch ? new Date(createdMatch[1]) : null;
  const updatedAt = updatedMatch ? new Date(updatedMatch[1]) : null;

  // Skip if ttl_days is already set to a non-null value
  if (currentTtl && currentTtl !== 'null' && currentTtl !== '~') {
    alreadyHasTtl++;
    continue;
  }

  const policyTtl = TTL_POLICY[type] ?? null;

  // Check archive candidates
  if (doArchive && createdAt) {
    const ageDays = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
    const lastTouch = updatedAt || createdAt;
    const staleDays = (now.getTime() - lastTouch.getTime()) / (1000 * 60 * 60 * 24);

    const isArchiveCandidate =
      (type === 'process' && ageDays > 60) ||
      (type === 'open_question' && staleDays > 90) ||
      ARCHIVE_PATTERNS.some(p => p.test(file) && ageDays > 30);

    if (isArchiveCandidate) {
      archiveCandidates.push(`${file} (${type}, ${Math.round(ageDays)}d old, last touched ${Math.round(staleDays)}d ago)`);
    }
  }

  // Set ttl_days if policy says so and it's currently null/unset
  if (policyTtl !== null && (!currentTtl || currentTtl === 'null' || currentTtl === '~')) {
    if (dryRun) {
      console.log(`[dry-run] Would set ttl_days: ${policyTtl} on ${file}`);
    } else {
      // Replace ttl_days line in frontmatter
      let newContent: string;
      if (ttlMatch) {
        newContent = content.replace(/^ttl_days:\s*.+/m, `ttl_days: ${policyTtl}`);
      } else {
        // Add ttl_days after created_at or updated_at
        newContent = content.replace(
          /^(updated_at:\s*.+)/m,
          `$1\nttl_days: ${policyTtl}`,
        );
      }
      fs.writeFileSync(fp, newContent);
    }
    ttlSet++;
  }
}

console.log(`\n--- TTL Backfill Summary ---`);
console.log(`Total atoms: ${files.length}`);
console.log(`Already have TTL: ${alreadyHasTtl}`);
console.log(`TTL ${dryRun ? 'would be' : ''} set: ${ttlSet}`);
console.log(`Policy: beliefs=null, facts=120d, decisions=180d, prefs=null, open_q=90d, process=60d`);

if (archiveCandidates.length > 0) {
  console.log(`\n--- Archive Candidates (${archiveCandidates.length}) ---`);
  for (const c of archiveCandidates) {
    console.log(`  ${c}`);
  }
  console.log(`\nRun with --archive to flag these. Manual review recommended before archiving.`);
}

if (dryRun) {
  console.log(`\n[DRY RUN — no files modified. Remove --dry-run to apply.]`);
}
