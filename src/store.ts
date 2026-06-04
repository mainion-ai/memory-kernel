/**
 * Filesystem store — atomic reads/writes for memory atoms and views.
 * Files are truth. Everything else is derived.
 */

import fs from 'fs';
import path from 'path';
import { parseAtom, serializeAtom } from './format.js';
import { isEncrypted, encryptAtomWithCredential, decryptAtomWithCredential, EncryptionKeyMissingError } from './crypto.js';
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

  // Create view files from templates (only if they don't exist).
  // 0o600 is the project-wide store-file mode (see #138) — view files may
  // concatenate body content from any classification and stay owner-only
  // as defense-in-depth.
  for (const file of VIEW_FILES) {
    const filePath = path.join(memoryDir, file);
    if (!fs.existsSync(filePath)) {
      const template = getTemplate(file);
      writeFileAtomic(filePath, template, 0o600);
    }
  }

  // Create events log. 0o600 because the event envelope (atom_refs,
  // agent_id, session_id) leaks SECRET atom *existence* even though
  // SECRET *bodies* are encrypted via snapshotAtom. See #138.
  const eventsPath = path.join(memoryDir, 'events.ndjson');
  if (!fs.existsSync(eventsPath)) {
    writeFileAtomic(eventsPath, '', 0o600);
  }
}

/**
 * Atomic file write: write to temp, fsync, rename.
 * Prevents corruption on crash.
 *
 * @param mode — optional file mode (e.g. 0o600 for SECRET files). When omitted,
 *               the platform default (mode & ~umask) applies.
 *
 * @internal Not part of the documented public API. Re-exported only because
 * legacy consumers may import it; new code should rely on the higher-level
 * atom/event helpers instead.
 */
export function writeFileAtomic(filePath: string, content: string, mode?: number): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = filePath + `.tmp.${process.pid}.${++tmpCounter}.${Math.random().toString(36).slice(2, 6)}`;
  const fd = mode !== undefined
    ? fs.openSync(tmpPath, 'w', mode)
    : fs.openSync(tmpPath, 'w');
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
 * Decrypts SECRET atoms if MEMORY_ENCRYPTION_KEY is set in the environment.
 */
export function readAtom(filePath: string): Atom {
  let content = fs.readFileSync(filePath, 'utf-8');
  if (isEncrypted(content)) {
    const cred = process.env.MEMORY_ENCRYPTION_KEY;
    if (!cred) {
      throw new EncryptionKeyMissingError(filePath);
    }
    content = decryptAtomWithCredential(content, cred);
  }
  return parseAtom(content, filePath);
}

/**
 * Write an atom to its file path (atomic).
 * Encrypts SECRET-classified atoms if MEMORY_ENCRYPTION_KEY is set in the environment.
 */
export function writeAtom(atom: Atom, filePath: string): void {
  let content = serializeAtom(atom);
  const isSecret = atom.frontmatter.classification === 'SECRET';
  if (isSecret) {
    const cred = process.env.MEMORY_ENCRYPTION_KEY;
    if (cred) {
      content = encryptAtomWithCredential(content, cred);
    }
  }
  writeFileAtomic(filePath, content, isSecret ? 0o600 : undefined);
  if (isSecret) {
    // Defense in depth against an exotic umask that strips owner-read from openSync mode.
    // Best-effort: Windows treats chmod as a no-op; on POSIX failure indicates
    // an unusual ACL state we can't recover from here. Matches the wrapping
    // pattern in src/index-db.ts openIndexRaw.
    try { fs.chmodSync(filePath, 0o600); } catch { /* best-effort */ }
  }
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
    } catch (err) {
      // Warn about encrypted atoms with no key so the user knows what to do
      if (err instanceof EncryptionKeyMissingError) {
        process.stderr.write(
          `Warning: encrypted atom skipped (set MEMORY_ENCRYPTION_KEY to access): ${f}\n`,
        );
      } else {
        // Surface every other parse failure (#100) — malformed YAML, missing
        // required frontmatter fields, truncated file, etc. Without this the
        // atom silently drops out of recall/views/index with no signal.
        const rel = path.relative(memoryDir, f) || f;
        const errName = err instanceof Error ? err.constructor.name : 'Error';
        const errMsg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `mk: warning: failed to parse ${rel}: ${errName}: ${errMsg} — skipping\n`,
        );
      }
      // Skip corrupted/malformed/encrypted-without-key atom files
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
/**
 * Walk up the path tree until finding an existing ancestor, resolve symlinks
 * on it (handles /var → /private/var on macOS), then reconstruct the full path.
 */
function realpathWalk(p: string): string {
  const parts: string[] = [];
  let current = path.resolve(p);
  while (true) {
    try {
      const real = fs.realpathSync(current);
      return parts.reduceRight((acc, part) => path.join(acc, part), real);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p); // reached filesystem root
      parts.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Throw if `target` resolves outside `root` (path-traversal guard).
 * Used in every code path that accepts a file path from external input.
 *
 * @internal Not part of the documented public API. This guard belongs at the
 * boundary of file-handling code paths inside the kernel; external callers
 * should rely on the higher-level operations (createAtom, archiveAtom, etc.)
 * that already enforce it internally.
 */
export function assertWithinDir(root: string, target: string): void {
  // Use realpathWalk to follow symlinks — path.resolve() alone doesn't catch
  // symlinks inside the directory that point outside it (e.g. ENTITIES/link → /tmp/evil).
  // realpathWalk also handles /var → /private/var on macOS for non-existent targets.
  const resolvedRoot = realpathWalk(root);
  const resolvedTarget = realpathWalk(target);

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
 * Write a view file (atomic). Mode 0o600 — views may synthesize body
 * content from any classification; owner-only is defense-in-depth (#138).
 */
export function writeView(memoryDir: string, viewName: string, content: string): void {
  const filePath = path.join(memoryDir, viewName);
  assertWithinDir(memoryDir, filePath);
  writeFileAtomic(filePath, content, 0o600);
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

// --- Prompt safety ---------------------------------------------------------

/**
 * Escape XML boundary characters in untrusted text before inserting into an
 * LLM prompt template that uses `<tag>...</tag>` framing. Prevents a hostile
 * user input from closing the boundary tag early and injecting model-level
 * instructions.
 *
 * Only `<` and `>` are escaped — they are the only characters that can
 * participate in a tag close/open pattern. We do not escape `&`, `'`, or `"`
 * because the consuming surface (LLM prompt, not HTML) does not interpret
 * them as structural.
 */
export function escapeXmlBoundary(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

