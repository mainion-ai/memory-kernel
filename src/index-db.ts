/**
 * SQLite index for fast atom lookups.
 *
 * Files remain the source of truth — this is a derived cache.
 * If the index is stale or missing, fall back to file scan (listAtoms).
 * Rebuild with `mk reindex`.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type { Atom, AtomType, AtomStatus, Classification, RecallQuery } from './types.js';
import { listAtoms } from './store.js';

const DB_FILENAME = '.memory-index.db';

// --- Schema ---

const CREATE_ATOMS_TABLE = `
CREATE TABLE IF NOT EXISTS atoms (
  atom_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence REAL NOT NULL,
  classification TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ttl_days INTEGER,
  file_path TEXT NOT NULL,
  body_hash TEXT NOT NULL
)`;

const CREATE_TAGS_TABLE = `
CREATE TABLE IF NOT EXISTS atom_tags (
  atom_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (atom_id, tag),
  FOREIGN KEY (atom_id) REFERENCES atoms(atom_id) ON DELETE CASCADE
)`;

const CREATE_PATHS_TABLE = `
CREATE TABLE IF NOT EXISTS atom_paths (
  atom_id TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (atom_id, path),
  FOREIGN KEY (atom_id) REFERENCES atoms(atom_id) ON DELETE CASCADE
)`;

const CREATE_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_atoms_type ON atoms(type)',
  'CREATE INDEX IF NOT EXISTS idx_atoms_status ON atoms(status)',
  'CREATE INDEX IF NOT EXISTS idx_atoms_confidence ON atoms(confidence)',
  'CREATE INDEX IF NOT EXISTS idx_atoms_updated ON atoms(updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_tags_tag ON atom_tags(tag)',
  'CREATE INDEX IF NOT EXISTS idx_paths_path ON atom_paths(path)',
];

// --- DB lifecycle ---

/**
 * Open (or create) the index database for a memory directory.
 */
export function openIndex(memoryDir: string): Database.Database {
  const dbPath = path.join(memoryDir, DB_FILENAME);
  const db = new Database(dbPath);

  // WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000'); // Wait up to 5s for locks

  // Create schema
  db.exec(CREATE_ATOMS_TABLE);
  db.exec(CREATE_TAGS_TABLE);
  db.exec(CREATE_PATHS_TABLE);
  for (const idx of CREATE_INDEXES) {
    db.exec(idx);
  }

  return db;
}

/**
 * Check if an index exists for a memory directory.
 */
export function indexExists(memoryDir: string): boolean {
  return fs.existsSync(path.join(memoryDir, DB_FILENAME));
}

/**
 * Simple hash for change detection (not cryptographic).
 */
function bodyHash(body: string): string {
  let hash = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body.charCodeAt(i);
    hash = ((hash << 5) - hash + ch) | 0;
  }
  return hash.toString(36);
}

// --- Index operations ---

/**
 * Rebuild the entire index from files. Drops existing data.
 */
export function reindex(memoryDir: string): { indexed: number; timeMs: number } {
  const start = Date.now();
  const db = openIndex(memoryDir);

  try {
    const atoms = listAtoms(memoryDir);

    const tx = db.transaction(() => {
      // Clear existing data
      db.exec('DELETE FROM atom_paths');
      db.exec('DELETE FROM atom_tags');
      db.exec('DELETE FROM atoms');

      const insertAtom = db.prepare(`
        INSERT OR REPLACE INTO atoms (atom_id, type, status, confidence, classification, created_at, updated_at, ttl_days, file_path, body_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertTag = db.prepare(`
        INSERT OR IGNORE INTO atom_tags (atom_id, tag) VALUES (?, ?)
      `);

      const insertPath = db.prepare(`
        INSERT OR IGNORE INTO atom_paths (atom_id, path) VALUES (?, ?)
      `);

      for (const atom of atoms) {
        const fm = atom.frontmatter;

        insertAtom.run(
          fm.id,
          fm.type,
          fm.status,
          fm.confidence,
          fm.classification ?? null,
          fm.created_at,
          fm.updated_at,
          fm.ttl_days,
          atom.filePath ?? '',
          bodyHash(atom.body),
        );

        // Index tags
        if (fm.scope?.tags) {
          for (const tag of fm.scope.tags) {
            insertTag.run(fm.id, tag);
          }
        }

        // Index paths
        if (fm.scope?.paths) {
          for (const p of fm.scope.paths) {
            insertPath.run(fm.id, p);
          }
        }
      }
    });

    tx();

    const timeMs = Date.now() - start;
    return { indexed: atoms.length, timeMs };
  } finally {
    db.close();
  }
}

/**
 * Upsert a single atom into the index.
 * Call after createAtom/updateAtom.
 */
export function indexAtom(memoryDir: string, atom: Atom): void {
  const db = openIndex(memoryDir);
  try {
    const fm = atom.frontmatter;

    const tx = db.transaction(() => {
      // Remove old data for this atom
      db.prepare('DELETE FROM atom_tags WHERE atom_id = ?').run(fm.id);
      db.prepare('DELETE FROM atom_paths WHERE atom_id = ?').run(fm.id);

      db.prepare(`
        INSERT OR REPLACE INTO atoms (atom_id, type, status, confidence, classification, created_at, updated_at, ttl_days, file_path, body_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        fm.id,
        fm.type,
        fm.status,
        fm.confidence,
        fm.classification ?? null,
        fm.created_at,
        fm.updated_at,
        fm.ttl_days,
        atom.filePath ?? '',
        bodyHash(atom.body),
      );

      if (fm.scope?.tags) {
        const insertTag = db.prepare('INSERT OR IGNORE INTO atom_tags (atom_id, tag) VALUES (?, ?)');
        for (const tag of fm.scope.tags) {
          insertTag.run(fm.id, tag);
        }
      }

      if (fm.scope?.paths) {
        const insertPath = db.prepare('INSERT OR IGNORE INTO atom_paths (atom_id, path) VALUES (?, ?)');
        for (const p of fm.scope.paths) {
          insertPath.run(fm.id, p);
        }
      }
    });

    tx();
  } finally {
    db.close();
  }
}

/**
 * Remove an atom from the index (after archive/delete).
 */
export function removeFromIndex(memoryDir: string, atomId: string): void {
  const db = openIndex(memoryDir);
  try {
    db.prepare('DELETE FROM atoms WHERE atom_id = ?').run(atomId);
    // Tags and paths cascade-deleted via FK
  } finally {
    db.close();
  }
}

// --- Query interface ---

export interface IndexQueryResult {
  atom_id: string;
  type: AtomType;
  status: AtomStatus;
  confidence: number;
  classification: Classification | null;
  created_at: string;
  updated_at: string;
  ttl_days: number | null;
  file_path: string;
}

/**
 * Query atoms from the index using RecallQuery filters.
 * Returns matching atom IDs and metadata — caller loads full atoms from files.
 *
 * Falls back to null if index doesn't exist (caller should use listAtoms).
 */
export function queryIndex(memoryDir: string, query: RecallQuery = {}): IndexQueryResult[] | null {
  if (!indexExists(memoryDir)) return null;

  const db = openIndex(memoryDir);
  try {
    const conditions: string[] = [];
    const params: unknown[] = [];

    // Exclude archived/expired by default
    conditions.push("a.status NOT IN ('archived', 'expired')");

    // Exclude SECRET and PERSONAL by default
    conditions.push("(a.classification IS NULL OR a.classification NOT IN ('SECRET', 'PERSONAL'))");

    // Filter by type
    if (query.types && query.types.length > 0) {
      const placeholders = query.types.map(() => '?').join(', ');
      conditions.push(`a.type IN (${placeholders})`);
      params.push(...query.types);
    }

    // Filter by status
    if (query.statuses && query.statuses.length > 0) {
      const placeholders = query.statuses.map(() => '?').join(', ');
      conditions.push(`a.status IN (${placeholders})`);
      params.push(...query.statuses);
    }

    // Filter by tags (any match)
    if (query.tags && query.tags.length > 0) {
      const placeholders = query.tags.map(() => '?').join(', ');
      conditions.push(`a.atom_id IN (SELECT atom_id FROM atom_tags WHERE tag IN (${placeholders}))`);
      params.push(...query.tags);
    }

    // Filter by paths (prefix overlap)
    if (query.paths && query.paths.length > 0) {
      const pathConditions = query.paths.map(() =>
        `a.atom_id IN (SELECT atom_id FROM atom_paths WHERE path LIKE ? || '%' ESCAPE '\\' OR ? LIKE path || '%' ESCAPE '\\')`,
      );
      // Unscoped atoms (no paths) always match
      conditions.push(
        `(a.atom_id NOT IN (SELECT atom_id FROM atom_paths) OR ${pathConditions.join(' OR ')})`,
      );
      for (const p of query.paths) {
        // Escape LIKE wildcards in path values
        const escaped = p.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
        params.push(escaped, escaped);
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const sql = `
      SELECT a.atom_id, a.type, a.status, a.confidence, a.classification,
             a.created_at, a.updated_at, a.ttl_days, a.file_path
      FROM atoms a
      ${where}
      ORDER BY
        CASE a.status
          WHEN 'active' THEN 0
          WHEN 'draft' THEN 1
          WHEN 'accepted' THEN 2
          WHEN 'resolved' THEN 3
          WHEN 'rejected' THEN 4
          WHEN 'superseded' THEN 5
          WHEN 'archived' THEN 6
          WHEN 'expired' THEN 7
          ELSE 99
        END,
        a.updated_at DESC
    `;

    return db.prepare(sql).all(...params) as IndexQueryResult[];
  } finally {
    db.close();
  }
}

/**
 * Get index stats.
 */
export function indexStats(memoryDir: string): { atoms: number; tags: number; paths: number } | null {
  if (!indexExists(memoryDir)) return null;

  const db = openIndex(memoryDir);
  try {
    const atoms = (db.prepare('SELECT COUNT(*) as c FROM atoms').get() as { c: number }).c;
    const tags = (db.prepare('SELECT COUNT(*) as c FROM atom_tags').get() as { c: number }).c;
    const paths = (db.prepare('SELECT COUNT(*) as c FROM atom_paths').get() as { c: number }).c;
    return { atoms, tags, paths };
  } finally {
    db.close();
  }
}
