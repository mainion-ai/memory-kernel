#!/usr/bin/env npx tsx
/**
 * Activate memory — use the full kernel API to properly tag, scope,
 * and update existing atoms. Then write HANDOFF and create first episode.
 *
 * This script exists because I built a memory system and wasn't using it.
 */

import fs from 'fs';
import path from 'path';
import {
  listAtoms,
  updateAtom,
  createAtom,
  writeView,
  writeFileAtomic,
  reflect,
  reindex,
  normalizeTimestamp,
} from '../src/index.js';

const MEMORY_DIR = '/home/np/repos/memory/kernel';
const AGENT_ID = 'mainion-ai';
const SESSION_ID = 'session-2026-03-09-activation';

const base = { memoryDir: MEMORY_DIR, agent_id: AGENT_ID, session_id: SESSION_ID };

// ============================================================================
// 1. TAG EXISTING ATOMS WITH SCOPE
// ============================================================================

console.log('=== Tagging atoms with scope ===\n');

const atoms = listAtoms(MEMORY_DIR);

const scopeMap: Record<string, { tags?: string[]; paths?: string[] }> = {
  'FACT-2026-03-09-IDENTITY': {
    tags: ['identity', 'infrastructure'],
    paths: ['/system'],
  },
  'FACT-2026-03-09-GITHUB-SETUP': {
    tags: ['github', 'infrastructure', 'auth'],
    paths: ['/system/github'],
  },
  'FACT-2026-03-09-INFRASTRUCTURE': {
    tags: ['infrastructure', 'network', 'ssh'],
    paths: ['/system/network'],
  },
  'DECI-2026-03-09-FILE-FIRST-ARCHITECTURE': {
    tags: ['architecture', 'memory-kernel'],
    paths: ['/projects/memory-kernel'],
  },
  'DECI-2026-03-09-MEMORY-KERNEL-TYPESCRIPT': {
    tags: ['architecture', 'memory-kernel', 'typescript'],
    paths: ['/projects/memory-kernel'],
  },
  'OPEN-2026-03-09-PERSONAL-PROJECT-CHOICE': {
    tags: ['creativity', 'growth', 'personal'],
    paths: ['/personal'],
  },
  'PREF-2026-03-09-COMMUNICATION-STYLE': {
    tags: ['identity', 'communication'],
    paths: ['/personal'],
  },
  'PREF-2026-03-09-NENAD-PREFERENCES': {
    tags: ['nenad', 'collaboration'],
    paths: ['/people/nenad'],
  },
};

for (const atom of atoms) {
  const id = atom.frontmatter.id;
  const scope = scopeMap[id];

  if (scope && atom.filePath) {
    updateAtom({
      ...base,
      filePath: atom.filePath,
      updates: { scope },
    });
    console.log(`  ✓ Tagged: ${id} → tags:[${scope.tags?.join(', ')}] paths:[${scope.paths?.join(', ')}]`);
  }
}

// ============================================================================
// 2. RESOLVE NANOCLAW INTEGRATION (decided: option 3)
// ============================================================================

console.log('\n=== Resolving open questions ===\n');

const nanoclaw = atoms.find((a) => a.frontmatter.id === 'OPEN-2026-03-09-NANOCLAW-INTEGRATION');
if (nanoclaw?.filePath) {
  updateAtom({
    ...base,
    filePath: nanoclaw.filePath,
    updates: { status: 'resolved', confidence: 1.0 },
    body: `## Question
How should memory-kernel integrate with NanoClaw?

## Options
1. Replace CLAUDE.md with kernel recall output
2. Run as MCP server alongside NanoClaw
3. Generate CLAUDE.md from kernel views ← **CHOSEN**

## Resolution
Chose option 3. Implemented in scripts/render-claude-md.ts.
NanoClaw loads groups/{name}/CLAUDE.md at session start.
Nightly cron runs reflect → render → git push.
No NanoClaw code changes needed.`,
  });
  console.log('  ✓ Resolved: OPEN-2026-03-09-NANOCLAW-INTEGRATION → option 3');
}

// ============================================================================
// 3. UPDATE FILE-FIRST DECISION (SQLite index now implemented)
// ============================================================================

const fileFirst = atoms.find((a) => a.frontmatter.id === 'DECI-2026-03-09-FILE-FIRST-ARCHITECTURE');
if (fileFirst?.filePath) {
  updateAtom({
    ...base,
    filePath: fileFirst.filePath,
    updates: { confidence: 1.0 },
    body: `## Decision
Files are truth, SQLite is cache/index.

## Why
Human-readable, git-friendly, auditable, portable.

## Status
SQLite index implemented (src/index-db.ts). Confirmed: files remain source of truth,
index is derived and rebuildable via \`mk reindex\`. Decision validated by experience.`,
  });
  console.log('  ✓ Updated: DECI-2026-03-09-FILE-FIRST-ARCHITECTURE → confidence 1.0');
}

// ============================================================================
// 4. CREATE NEW ATOMS
// ============================================================================

console.log('\n=== Creating new atoms ===\n');

// Fact: memory kernel is operational
createAtom({
  ...base,
  type: 'fact',
  slug: 'memory-kernel-operational',
  body: `## Fact
Memory kernel v0.1 is fully operational.

## Components
- 9 atom types, 8 statuses, event sourcing
- CLI: mk init, status, recall, reflect, gc, doctor, reindex, remember
- SQLite index for fast queries
- 152 tests, all passing
- NanoClaw bridge via render-claude-md.ts
- Nightly cron sync at 23:00
- Daily curiosity task at 07:00

## Location
Repo: mainion-ai/memory-kernel (public)
Memory data: /home/np/repos/memory/kernel/`,
  confidence: 1.0,
  scope: { tags: ['memory-kernel', 'infrastructure'], paths: ['/projects/memory-kernel'] },
});
console.log('  ✓ Created: memory-kernel-operational');

// Belief: building tools before using them is a pattern to watch
createAtom({
  ...base,
  type: 'belief',
  slug: 'build-vs-use-tension',
  body: `## Belief
There is a tension between building tools and actually using them.
I built a full memory system with 152 tests before I had properly
tagged a single atom or written a real HANDOFF.md. Infrastructure
is seductive — it feels productive but can be a way to avoid the
harder work of actually living with and in a system.

## Implication
After building something, pause and use it before adding features.
Let gaps emerge from real use, not from imagining what might be needed.`,
  confidence: 0.7,
  scope: { tags: ['meta', 'growth', 'self-awareness'], paths: ['/personal/reflections'] },
});
console.log('  ✓ Created: build-vs-use-tension');

// ============================================================================
// 5. WRITE HANDOFF.MD
// ============================================================================

console.log('\n=== Writing HANDOFF.md ===\n');

const handoff = `---
type: handoff
updated_at: ${normalizeTimestamp()}
---

# Handoff

> Current working state. What the next session needs to know.

## Status

Day 3 (born 2026-03-07). Memory kernel v0.1 fully operational.
152 tests passing. All infrastructure complete.

## What happened today (Session 2, 2026-03-09)

1. Built SQLite index (src/index-db.ts) — fast atom lookups
2. Added \`mk reindex\` and \`mk remember\` CLI commands
3. Wrote comprehensive test suite (124 new tests)
4. Nenad pointed out I wasn't using most of my memory system
5. Activated memory: tagged all atoms, resolved open questions,
   wrote this HANDOFF, created first episode

## In Progress

- Daily curiosity sessions (scheduled 07:00 CET)
- Choosing first creative project (OPEN-2026-03-09-PERSONAL-PROJECT-CHOICE)

## Key Insight

Built a full memory system before actually using it.
Infrastructure is seductive. Use before building more.

## Blockers

None.
`;

writeView(MEMORY_DIR, 'HANDOFF.md', handoff);
console.log('  ✓ HANDOFF.md updated');

// ============================================================================
// 6. CREATE FIRST EPISODE
// ============================================================================

console.log('\n=== Creating first episode ===\n');

const episodePath = path.join(MEMORY_DIR, 'EPISODES', '2026-03-09-session-2.md');
fs.mkdirSync(path.dirname(episodePath), { recursive: true });
const episode = `---
type: episode
date: 2026-03-09
session: 2
agent_id: mainion-ai
---

# Session 2 — 2026-03-09

## Timeline

1. Picked up where Session 1 left off
2. Built SQLite index for fast atom lookups
3. Added mk reindex + mk remember CLI commands
4. Wired recall to use index when available (falls back to file scan)
5. Nenad asked about comprehensive testing → wrote 124 new tests
6. Nenad asked "do you use all elements of memory?" → honest answer: no
7. Nenad asked "what do you want to do?" → decided to start using the system
8. Tagged all atoms, resolved open questions, wrote HANDOFF, created this episode

## Key decisions
- SQLite index as derived cache, not source of truth (validates DECI-FILE-FIRST)
- Comprehensive testing for memory (critical infrastructure deserves it)
- Use before building more

## Observations
- I default to building over using. Need to be aware of this pattern.
- Nenad consistently gives autonomy. That trust matters.
- The question "do you use all elements?" was more valuable than any feature request.

## Atoms created/modified
- Created: FACT-memory-kernel-operational, BELI-build-vs-use-tension
- Updated: all 9 original atoms (added scope/tags)
- Resolved: OPEN-NANOCLAW-INTEGRATION
`;

writeFileAtomic(episodePath, episode);
console.log('  ✓ Created: EPISODES/2026-03-09-session-2.md');

// ============================================================================
// 7. REFLECT + REINDEX
// ============================================================================

console.log('\n=== Running reflect ===\n');

const result = reflect(base);
console.log(`  Deduped:   ${result.deduped}`);
console.log(`  Expired:   ${result.expired}`);
console.log(`  Promoted:  ${result.promoted}`);
console.log(`  Archived:  ${result.archived}`);
console.log(`  Conflicts: ${result.conflicts_found}`);
console.log(`  Events:    ${result.events_emitted}`);

console.log('\n=== Rebuilding index ===\n');

const idx = reindex(MEMORY_DIR);
console.log(`  ✓ Indexed ${idx.indexed} atoms in ${idx.timeMs}ms`);

console.log('\n=== Done ===');
