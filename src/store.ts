/**
 * Filesystem store — atomic reads/writes for memory atoms and views.
 * Files are truth. Everything else is derived.
 */

import fs from 'fs';
import path from 'path';
import { parseAtom, serializeAtom } from './format.js';
import type { Atom } from './types.js';

/** Monotonic counter for unique tmp file names across concurrent writes. */
let tmpCounter = 0;

// --- Canonical directory layout ---

const DIRS = [
  'ENTITIES',
  'EPISODES',
  'EVIDENCE',
  'CONFLICTS',
  'ARCHIVE',
];

const VIEW_FILES = [
  'INDEX.md',
  'HANDOFF.md',
  'DECISIONS.md',
  'CONSTRAINTS.md',
  'OPEN_QUESTIONS.md',
];

/**
 * Initialize a memory directory with canonical layout.
 */
export function initMemoryDir(memoryDir: string): void {
  // Create root
  fs.mkdirSync(memoryDir, { recursive: true });

  // Create subdirectories
  for (const dir of DIRS) {
    fs.mkdirSync(path.join(memoryDir, dir), { recursive: true });
  }

  // Create view files from templates (only if they don't exist)
  for (const file of VIEW_FILES) {
    const filePath = path.join(memoryDir, file);
    if (!fs.existsSync(filePath)) {
      const template = getTemplate(file);
      writeFileAtomic(filePath, template);
    }
  }

  // Create events log
  const eventsPath = path.join(memoryDir, 'events.ndjson');
  if (!fs.existsSync(eventsPath)) {
    writeFileAtomic(eventsPath, '');
  }
}

/**
 * Atomic file write: write to temp, fsync, rename.
 * Prevents corruption on crash.
 */
export function writeFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = filePath + `.tmp.${process.pid}.${++tmpCounter}.${Math.random().toString(36).slice(2, 6)}`;
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

/**
 * Read and parse an atom from a markdown file.
 */
export function readAtom(filePath: string): Atom {
  const content = fs.readFileSync(filePath, 'utf-8');
  return parseAtom(content, filePath);
}

/**
 * Write an atom to its file path (atomic).
 */
export function writeAtom(atom: Atom, filePath: string): void {
  const content = serializeAtom(atom);
  writeFileAtomic(filePath, content);
}

/**
 * List all atom files in a directory.
 * Note: Only reads top-level .md files in ENTITIES/ and CONFLICTS/.
 * Subdirectories are not scanned (flat layout by design).
 */
export function listAtomFiles(memoryDir: string): string[] {
  const results: string[] = [];

  // Scan entity/conflict directories
  for (const dir of ['ENTITIES', 'CONFLICTS']) {
    const dirPath = path.join(memoryDir, dir);
    if (fs.existsSync(dirPath)) {
      const files = fs.readdirSync(dirPath);
      for (const f of files) {
        if (f.endsWith('.md')) {
          results.push(path.join(dirPath, f));
        }
      }
    }
  }

  return results;
}

/**
 * List all atoms in memory (parsed). Skips files that fail to parse.
 */
export function listAtoms(memoryDir: string): Atom[] {
  const files = listAtomFiles(memoryDir);
  const atoms: Atom[] = [];
  for (const f of files) {
    try {
      atoms.push(readAtom(f));
    } catch {
      // Skip corrupted/malformed atom files — don't let one bad file break everything
    }
  }
  return atoms;
}

/**
 * Resolve where an atom should be stored based on type.
 */
export function atomFilePath(memoryDir: string, id: string, type: string): string {
  if (type === 'conflict') {
    return path.join(memoryDir, 'CONFLICTS', `${id}.md`);
  }
  return path.join(memoryDir, 'ENTITIES', `${id}.md`);
}

/**
 * Validate that a resolved path is within the given root directory.
 * Prevents path traversal attacks.
 */
export function assertWithinDir(root: string, target: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!resolvedTarget.startsWith(resolvedRoot + path.sep) && resolvedTarget !== resolvedRoot) {
    throw new Error(`Path traversal denied: ${target} is outside ${root}`);
  }
}

/**
 * Read a view file (INDEX, HANDOFF, etc.).
 */
export function readView(memoryDir: string, viewName: string): string {
  const filePath = path.join(memoryDir, viewName);
  assertWithinDir(memoryDir, filePath);
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf-8');
}

/**
 * Write a view file (atomic).
 */
export function writeView(memoryDir: string, viewName: string, content: string): void {
  const filePath = path.join(memoryDir, viewName);
  assertWithinDir(memoryDir, filePath);
  writeFileAtomic(filePath, content);
}

// --- Templates ---

function getTemplate(fileName: string): string {
  switch (fileName) {
    case 'INDEX.md':
      return `---
type: index
updated_at: ${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}
---

# Memory Index

> Routing map for this memory store. Kept under 200 lines.
> Heavy content lives in ENTITIES/, EPISODES/, and topic files.

## Active Context

_No active context yet._

## Key Decisions

_None recorded._

## Open Questions

_None._

## Constraints

_None._

## Entities

_None tracked._
`;

    case 'HANDOFF.md':
      return `---
type: handoff
updated_at: ${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}
---

# Handoff

> Current working state. What the next session needs to know.

## Status

_Fresh memory — no prior sessions._

## In Progress

_Nothing._

## Recent Decisions

_None._

## Blockers

_None._
`;

    case 'DECISIONS.md':
      return `---
type: view
updated_at: ${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}
---

# Decisions

> All accepted and draft decisions. Each links to its atom for full detail.

_No decisions recorded._
`;

    case 'CONSTRAINTS.md':
      return `---
type: view
updated_at: ${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}
---

# Constraints

> Active constraints and rules. Referenced during recall.

_No constraints recorded._
`;

    case 'OPEN_QUESTIONS.md':
      return `---
type: view
updated_at: ${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}
---

# Open Questions

> Unresolved questions that must remain visible until resolved.

_No open questions._
`;

    default:
      return '';
  }
}
