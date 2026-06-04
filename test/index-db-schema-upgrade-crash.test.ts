import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import {
  initMemoryDir,
  openIndex,
  closeAllIndexes,
  storeEmbedding,
} from '../src/index.js';
import {
  indexAtom,
  removeFromIndex,
  indexEpisode,
} from '../src/index-db.js';
import { createAtom } from '../src/index.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-txnwrap-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  vi.restoreAllMocks();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('index-db transaction wrappers (#85)', () => {
  describe('removeFromIndex', () => {
    it('rolls back prior DELETEs when a later DELETE throws', () => {
      const atom = createAtom({
        memoryDir: testDir,
        agent_id: 'test',
        session_id: 'test',
        type: 'fact',
        slug: 'remove-atomicity',
        body: 'sky is blue.',
      });
      indexAtom(testDir, atom);
      storeEmbedding(
        testDir,
        atom.frontmatter.id,
        Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer),
        'test-model',
        3,
        'test-hash',
      );

      const db = openIndex(testDir);
      const atomsBefore = db.prepare('SELECT COUNT(*) as n FROM atoms WHERE atom_id = ?').get(atom.frontmatter.id) as { n: number };
      const ftsBefore = db.prepare('SELECT COUNT(*) as n FROM atom_fts WHERE atom_id = ?').get(atom.frontmatter.id) as { n: number };
      const embBefore = db.prepare('SELECT COUNT(*) as n FROM atom_embeddings WHERE atom_id = ?').get(atom.frontmatter.id) as { n: number };
      expect(atomsBefore.n).toBe(1);
      expect(ftsBefore.n).toBe(1);
      expect(embBefore.n).toBe(1);

      let runCallCount = 0;
      const originalPrepare = Database.prototype.prepare;
      vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, source: string) {
        const stmt = originalPrepare.call(this, source);
        const originalStmtRun = stmt.run.bind(stmt);
        stmt.run = ((...args: unknown[]) => {
          runCallCount++;
          if (runCallCount === 2) throw new Error('SIMULATED_FAULT_REMOVE');
          return originalStmtRun(...args);
        }) as typeof stmt.run;
        return stmt;
      });

      expect(() => removeFromIndex(testDir, atom.frontmatter.id)).toThrow('SIMULATED_FAULT_REMOVE');

      vi.restoreAllMocks();

      const db2 = openIndex(testDir);
      const atomsAfter = db2.prepare('SELECT COUNT(*) as n FROM atoms WHERE atom_id = ?').get(atom.frontmatter.id) as { n: number };
      const ftsAfter = db2.prepare('SELECT COUNT(*) as n FROM atom_fts WHERE atom_id = ?').get(atom.frontmatter.id) as { n: number };
      const embAfter = db2.prepare('SELECT COUNT(*) as n FROM atom_embeddings WHERE atom_id = ?').get(atom.frontmatter.id) as { n: number };
      expect(atomsAfter.n).toBe(1);
      expect(ftsAfter.n).toBe(1);
      expect(embAfter.n).toBe(1);
    });

    it('successful removeFromIndex still clears all three tables (regression guard)', () => {
      const atom = createAtom({
        memoryDir: testDir,
        agent_id: 'test',
        session_id: 'test',
        type: 'fact',
        slug: 'remove-happy',
        body: 'grass is green.',
      });
      indexAtom(testDir, atom);
      storeEmbedding(
        testDir,
        atom.frontmatter.id,
        Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer),
        'test-model',
        3,
        'test-hash',
      );

      removeFromIndex(testDir, atom.frontmatter.id);

      const db = openIndex(testDir);
      const atomsAfter = db.prepare('SELECT COUNT(*) as n FROM atoms WHERE atom_id = ?').get(atom.frontmatter.id) as { n: number };
      const ftsAfter = db.prepare('SELECT COUNT(*) as n FROM atom_fts WHERE atom_id = ?').get(atom.frontmatter.id) as { n: number };
      const embAfter = db.prepare('SELECT COUNT(*) as n FROM atom_embeddings WHERE atom_id = ?').get(atom.frontmatter.id) as { n: number };
      expect(atomsAfter.n).toBe(0);
      expect(ftsAfter.n).toBe(0);
      expect(embAfter.n).toBe(0);
    });
  });

  describe('indexEpisode', () => {
    it('preserves the prior episode FTS row when the INSERT throws', () => {
      indexEpisode(testDir, 'ep-orig', 'original summary text');

      const db = openIndex(testDir);
      const rowBefore = db.prepare('SELECT body FROM episode_fts WHERE episode_id = ?').get('ep-orig') as { body: string } | undefined;
      expect(rowBefore?.body).toBe('original summary text');

      let runCallCount = 0;
      const originalPrepare = Database.prototype.prepare;
      vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, source: string) {
        const stmt = originalPrepare.call(this, source);
        const originalStmtRun = stmt.run.bind(stmt);
        stmt.run = ((...args: unknown[]) => {
          runCallCount++;
          if (runCallCount === 2) throw new Error('SIMULATED_FAULT_INSERT');
          return originalStmtRun(...args);
        }) as typeof stmt.run;
        return stmt;
      });

      expect(() => indexEpisode(testDir, 'ep-orig', 'new replacement text')).not.toThrow();

      vi.restoreAllMocks();

      const db2 = openIndex(testDir);
      const rowAfter = db2.prepare('SELECT body FROM episode_fts WHERE episode_id = ?').get('ep-orig') as { body: string } | undefined;
      expect(rowAfter).toBeDefined();
      expect(rowAfter?.body).toBe('original summary text');
    });

    it('successful indexEpisode upsert replaces the prior row (regression guard)', () => {
      indexEpisode(testDir, 'ep-up', 'first version');
      indexEpisode(testDir, 'ep-up', 'second version');

      const db = openIndex(testDir);
      const rows = db.prepare('SELECT body FROM episode_fts WHERE episode_id = ?').all('ep-up') as { body: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].body).toBe('second version');
    });
  });

  describe('schema upgrade', () => {
    it('rolls back the entire DROP/CREATE/user_version block when a CREATE throws', () => {
      // Setup: open index, insert a marker row directly into atoms (no FK
      // dependency to satisfy), then force user_version backwards so the
      // next open re-enters the upgrade path.
      const db = openIndex(testDir);
      db.prepare(
        'INSERT INTO atoms (atom_id, type, status, confidence, classification, created_at, updated_at, ttl_days, file_path, body_hash) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        'A-2024-01-01-marker-aaa',
        'fact',
        'active',
        0.9,
        null,
        '2024-01-01T00:00:00Z',
        '2024-01-01T00:00:00Z',
        null,
        '',
        'marker-hash',
      );
      db.pragma('user_version = 1');
      closeAllIndexes();

      let execCallCount = 0;
      const originalExec = Database.prototype.exec;
      vi.spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database.Database, source: string) {
        execCallCount++;
        if (execCallCount === 10) throw new Error('SIMULATED_FAULT_UPGRADE');
        return originalExec.call(this, source);
      });

      expect(() => openIndex(testDir)).toThrow('SIMULATED_FAULT_UPGRADE');

      vi.restoreAllMocks();
      closeAllIndexes();

      // Inspect via a raw better-sqlite3 connection so we observe the
      // on-disk state without re-triggering the upgrade through openIndex.
      const raw = new Database(path.join(testDir, '.memory-index.db'));
      const version = raw.pragma('user_version', { simple: true }) as number;
      const markerCount = raw
        .prepare('SELECT COUNT(*) as n FROM atoms WHERE atom_id = ?')
        .get('A-2024-01-01-marker-aaa') as { n: number };
      raw.close();

      // ROLLBACK preserved both the stale user_version and the marker row.
      expect(version).toBe(1);
      expect(markerCount.n).toBe(1);
    });

    it('successful upgrade reaches user_version = SCHEMA_VERSION with all tables present (regression guard)', () => {
      const db = openIndex(testDir);
      const versionInitial = db.pragma('user_version', { simple: true }) as number;
      expect(versionInitial).toBeGreaterThan(0);

      db.pragma('user_version = 1');
      closeAllIndexes();

      const db2 = openIndex(testDir);
      const versionAfter = db2.pragma('user_version', { simple: true }) as number;
      expect(versionAfter).toBe(versionInitial);

      const tables = db2
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as { name: string }[];
      const names = tables.map((t) => t.name);
      expect(names).toContain('atoms');
      expect(names).toContain('atom_fts');
      expect(names).toContain('atom_embeddings');
      expect(names).toContain('atom_relations');
      expect(names).toContain('entity_triples');
      expect(names).toContain('atom_citations');
      expect(names).toContain('episode_fts');
    });
  });
});
