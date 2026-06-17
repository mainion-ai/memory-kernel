/**
 * SQLite connection lifecycle + schema for the atom index (#368).
 *
 * This module owns the single process-global connection cache. Every other
 * `src/index/*` module obtains its handle via `openIndex()` here — there must be
 * exactly ONE cache, or writes through one handle wouldn't be visible to reads
 * through another. DDL (schema create + version-gated rebuild) runs once on first
 * open per directory; subsequent opens return the cached connection.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_FILENAME = '.memory-index.db';
const SCHEMA_VERSION = 8; // Bump when schema changes to trigger auto-rebuild

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

// FTS5 virtual table for full-text search over atom title + body.
// Stores its own content (no content= param) so standard DELETE works.
// porter tokenizer enables stemming (run/runs/running all match).
const CREATE_FTS_TABLE = `
CREATE VIRTUAL TABLE IF NOT EXISTS atom_fts USING fts5(
  atom_id UNINDEXED,
  title,
  body,
  tokenize='porter unicode61'
)`;

// FTS5 virtual table for full-text search over episode summaries.
// Same tokenizer as atom_fts (porter stemming + unicode61).
const CREATE_EPISODE_FTS_TABLE = `
CREATE VIRTUAL TABLE IF NOT EXISTS episode_fts USING fts5(
  episode_id UNINDEXED,
  body,
  tokenize='porter unicode61'
)`;

// Embeddings table for semantic search (KNN via cosine similarity).
// Vectors stored as BLOBs (Float32Array). Provider/model tracked for cache invalidation.
const CREATE_EMBEDDINGS_TABLE = `
CREATE TABLE IF NOT EXISTS atom_embeddings (
  atom_id TEXT PRIMARY KEY,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  body_hash TEXT NOT NULL,
  FOREIGN KEY (atom_id) REFERENCES atoms(atom_id) ON DELETE CASCADE
)`;

// Relations table for typed graph edges between atoms (Phase 3).
// Both FKs use ON DELETE CASCADE:
//   source deleted → its outbound edges are removed (atom no longer exists as a source)
//   target deleted → inbound edges pointing to it are removed (broken refs cleaned up)
const CREATE_RELATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS atom_relations (
  source_id     TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source_id, target_id, relation_type),
  FOREIGN KEY (source_id) REFERENCES atoms(atom_id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES atoms(atom_id) ON DELETE CASCADE
)`;

const CREATE_RELATIONS_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_relations_target ON atom_relations(target_id)',
  'CREATE INDEX IF NOT EXISTS idx_relations_type ON atom_relations(relation_type)',
];

// Entity-triple table for Tier-1 semantic conflict detection (#75).
// Each row is a (subject, predicate, object) triple extracted from an atom body
// at ingestion time. Conflict detection queries: same (subject, predicate),
// different object → candidate conflict (then Tier 2 LLM confirms).
// Strings are stored lower-cased for case-insensitive matching.
const CREATE_TRIPLES_TABLE = `
CREATE TABLE IF NOT EXISTS entity_triples (
  triple_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  atom_id     TEXT NOT NULL,
  subject     TEXT NOT NULL,
  predicate   TEXT NOT NULL,
  object      TEXT NOT NULL,
  confidence  REAL NOT NULL DEFAULT 1.0,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (atom_id) REFERENCES atoms(atom_id) ON DELETE CASCADE
)`;

const CREATE_TRIPLES_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_triples_atom ON entity_triples(atom_id)',
  'CREATE INDEX IF NOT EXISTS idx_triples_sp ON entity_triples(subject, predicate)',
];

// Citations table for concept-name and atom-ID citation counts (ACT-R frequency).
// Populated by `mk citations` or `indexCitations()`. Used by wander for base_activation.
const CREATE_CITATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS atom_citations (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  type TEXT NOT NULL DEFAULT 'concept_name',
  PRIMARY KEY (source_id, target_id, type),
  FOREIGN KEY (source_id) REFERENCES atoms(atom_id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES atoms(atom_id) ON DELETE CASCADE
)`;

const CREATE_CITATIONS_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_citations_target ON atom_citations(target_id)',
];

// --- Connection cache ---

const connectionCache = new Map<string, Database.Database>();

/**
 * Get or create a cached database connection for a memory directory.
 * DDL only runs on first open — subsequent calls return the cached connection.
 */
function getCachedDb(memoryDir: string): Database.Database {
  const resolvedDir = path.resolve(memoryDir);
  const existing = connectionCache.get(resolvedDir);
  if (existing) {
    try {
      // Verify connection is still valid
      existing.pragma('journal_mode');
      return existing;
    } catch {
      // Connection invalid — remove from cache and re-open
      connectionCache.delete(resolvedDir);
    }
  }

  const db = openIndexRaw(resolvedDir);
  connectionCache.set(resolvedDir, db);
  return db;
}

/**
 * Close a cached connection (useful for tests and cleanup).
 *
 * @internal Not part of the documented public API. Prefer `closeAllIndexes()`
 * in test teardown; this is exposed only for finer-grained internal usage.
 */
export function closeIndex(memoryDir: string): void {
  const resolvedDir = path.resolve(memoryDir);
  const db = connectionCache.get(resolvedDir);
  if (db) {
    try { db.close(); } catch { /* best-effort */ }
    connectionCache.delete(resolvedDir);
  }
}

/**
 * Close all cached connections (for process cleanup).
 */
export function closeAllIndexes(): void {
  for (const [key, db] of connectionCache) {
    try { db.close(); } catch { /* best-effort */ }
    connectionCache.delete(key);
  }
}

// --- DB lifecycle ---

/**
 * Open the index database directly (no caching). Used internally.
 * Checks schema version and rebuilds if stale.
 */
function openIndexRaw(resolvedDir: string): Database.Database {
  const dbPath = path.join(resolvedDir, DB_FILENAME);
  const db = new Database(dbPath);

  // SECRET-aware permissions: the index denormalizes tags and IDs that may
  // reference SECRET atoms. Restrict to owner-only (0o600).
  try {
    fs.chmodSync(dbPath, 0o600);
  } catch {
    // Best-effort: on Windows the chmod may be a no-op; on Linux the file
    // exists after Database() so this should succeed.
  }
  // WAL and SHM sidecars are created lazily. Chmod them opportunistically
  // if they already exist on this open call.
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = dbPath + suffix;
    if (fs.existsSync(sidecar)) {
      try { fs.chmodSync(sidecar, 0o600); } catch { /* best-effort */ }
    }
  }

  // WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000'); // Wait up to 5s for locks

  // Check schema version — auto-rebuild if stale
  const currentVersion = (db.pragma('user_version', { simple: true }) as number) ?? 0;

  // Wrap DROP + CREATE + user_version assignment in a single transaction so a
  // fault anywhere in the block rolls back to the prior schema state. Without
  // this, a crash between `DROP TABLE` and the final `user_version` pragma
  // leaves a partial schema with the old user_version, and the next open
  // re-enters the upgrade path and DROPs the half-built tables again — wiping
  // any rows the application inserted in the partial-success window.
  // user_version is a value pragma stored in the file header, safe inside a
  // transaction (unlike journal_mode / foreign_keys / busy_timeout above,
  // which are configuration pragmas and run outside any transaction).
  const upgradeTx = db.transaction(() => {
    if (currentVersion !== SCHEMA_VERSION) {
      // Drop and recreate all tables for clean schema upgrade.
      // Drop order: dependent tables first (FK CASCADE), then atoms last.
      db.exec('DROP TABLE IF EXISTS entity_triples');
      db.exec('DROP TABLE IF EXISTS atom_citations');
      db.exec('DROP TABLE IF EXISTS atom_relations');
      db.exec('DROP TABLE IF EXISTS atom_embeddings');
      db.exec('DROP TABLE IF EXISTS episode_fts');
      db.exec('DROP TABLE IF EXISTS atom_fts');
      db.exec('DROP TABLE IF EXISTS atom_paths');
      db.exec('DROP TABLE IF EXISTS atom_tags');
      db.exec('DROP TABLE IF EXISTS atoms');
    }

    // Create schema (idempotent — IF NOT EXISTS)
    db.exec(CREATE_ATOMS_TABLE);
    db.exec(CREATE_TAGS_TABLE);
    db.exec(CREATE_PATHS_TABLE);
    for (const idx of CREATE_INDEXES) {
      db.exec(idx);
    }
    db.exec(CREATE_FTS_TABLE);
    db.exec(CREATE_EPISODE_FTS_TABLE);
    db.exec(CREATE_EMBEDDINGS_TABLE);
    db.exec(CREATE_RELATIONS_TABLE);
    for (const idx of CREATE_RELATIONS_INDEXES) {
      db.exec(idx);
    }
    db.exec(CREATE_CITATIONS_TABLE);
    for (const idx of CREATE_CITATIONS_INDEXES) {
      db.exec(idx);
    }
    db.exec(CREATE_TRIPLES_TABLE);
    for (const idx of CREATE_TRIPLES_INDEXES) {
      db.exec(idx);
    }

    // Set schema version atomically with the schema mutations above.
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  });
  upgradeTx();

  // Lazy column extension: add atom_embeddings.normalized for KNN
  // pre-normalization (PR-11 / #95). SQLite ALTER TABLE ADD COLUMN has
  // no IF NOT EXISTS, so we introspect first. Idempotent on subsequent
  // opens — additive only, no schema-version bump required.
  //
  // Race guard: another process may add the column between our PRAGMA
  // check and our ALTER. SQLite serializes the writes; the loser sees
  // "duplicate column name" which is a benign no-op for our purposes.
  const embedCols = db.prepare('PRAGMA table_info(atom_embeddings)').all() as { name: string }[];
  if (!embedCols.find(c => c.name === 'normalized')) {
    try {
      db.prepare('ALTER TABLE atom_embeddings ADD COLUMN normalized INTEGER NOT NULL DEFAULT 0').run();
    } catch (e) {
      if (!/duplicate column name/i.test((e as Error).message)) throw e;
    }
  }

  return db;
}

/**
 * Open (or create) the index database for a memory directory.
 * Uses connection cache — DDL only runs on first open.
 *
 * @internal Not part of the documented public API. Higher-level kernel
 * operations open the index transparently; external callers normally don't
 * need to handle the SQLite handle directly.
 */
export function openIndex(memoryDir: string): Database.Database {
  return getCachedDb(memoryDir);
}

/**
 * Check if an index exists for a memory directory.
 */
export function indexExists(memoryDir: string): boolean {
  return fs.existsSync(path.join(memoryDir, DB_FILENAME));
}
