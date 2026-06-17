/**
 * Typed graph-edge (relation) reads/writes against the atom index (#368, Phase 3).
 * All handles come from the shared connection cache in `./connection.js`.
 */

import { openIndex, indexExists } from './connection.js';

export interface AtomRelation {
  source_id: string;
  target_id: string;
  relation_type: string;
  created_at: string;
}

/**
 * Get all inbound and outbound relations for an atom.
 */
export function getRelationsForAtom(
  memoryDir: string,
  atomId: string,
): { outbound: AtomRelation[]; inbound: AtomRelation[] } {
  if (!indexExists(memoryDir)) return { outbound: [], inbound: [] };
  try {
    const db = openIndex(memoryDir);
    const outbound = db.prepare(
      'SELECT * FROM atom_relations WHERE source_id = ? ORDER BY relation_type',
    ).all(atomId) as AtomRelation[];
    const inbound = db.prepare(
      'SELECT * FROM atom_relations WHERE target_id = ? ORDER BY relation_type',
    ).all(atomId) as AtomRelation[];
    return { outbound, inbound };
  } catch {
    return { outbound: [], inbound: [] };
  }
}

/**
 * Insert a relation edge into the index.
 * Idempotent — duplicate (source, target, type) triples are silently ignored.
 */
export function addRelation(
  memoryDir: string,
  sourceId: string,
  targetId: string,
  relationType: string,
): void {
  const db = openIndex(memoryDir);
  db.prepare(`
    INSERT OR IGNORE INTO atom_relations (source_id, target_id, relation_type)
    VALUES (?, ?, ?)
  `).run(sourceId, targetId, relationType);
}

/**
 * Get all relation edges from the index (used for graph-walk boost in recall).
 * Returns empty array if index doesn't exist or table is absent.
 */
export function getAllRelations(memoryDir: string): AtomRelation[] {
  if (!indexExists(memoryDir)) return [];
  try {
    const db = openIndex(memoryDir);
    return db.prepare('SELECT * FROM atom_relations').all() as AtomRelation[];
  } catch {
    return [];
  }
}
