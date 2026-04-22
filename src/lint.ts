/**
 * Semantic health checker for the memory store.
 *
 * Unlike `mk doctor` (structural integrity — schema validation, broken links),
 * `mk lint` checks semantic health: contradictions, stale atoms, orphans,
 * near-duplicates, confidence drift, and TTL warnings.
 */

import { listAtoms } from './store.js';
import { readEvents } from './event-log.js';
import { getAllRelations, indexExists, searchFts } from './index-db.js';
import type { Atom } from './types.js';

// --- Public types ---

export interface LintFinding {
  category: 'contradiction' | 'stale' | 'orphan' | 'duplicate' | 'confidence_drift' | 'ttl_warning';
  severity: 'warning' | 'info';
  atom_ids: string[];
  message: string;
}

export interface LintOptions {
  staleDays?: number; // default 90
}

export interface LintResult {
  findings: LintFinding[];
  summary: { total: number; warnings: number; info: number };
}

// --- Internal helpers ---

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysSince(isoDate: string): number {
  const then = new Date(isoDate).getTime();
  const now = Date.now();
  return Math.floor((now - then) / MS_PER_DAY);
}

function daysUntilExpiry(createdAt: string, ttlDays: number): number {
  const created = new Date(createdAt).getTime();
  const expiry = created + ttlDays * MS_PER_DAY;
  return Math.floor((expiry - Date.now()) / MS_PER_DAY);
}

function tagJaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// --- Check functions ---

function findContradictions(atoms: Atom[], memoryDir: string): LintFinding[] {
  const findings: LintFinding[] = [];
  if (!indexExists(memoryDir)) return findings;

  const activeIds = new Set(
    atoms.filter((a) => a.frontmatter.status === 'active').map((a) => a.frontmatter.id),
  );

  const relations = getAllRelations(memoryDir);
  for (const rel of relations) {
    if (rel.relation_type === 'contradicts' && activeIds.has(rel.source_id) && activeIds.has(rel.target_id)) {
      // Avoid duplicate findings (A contradicts B and B contradicts A)
      const key = [rel.source_id, rel.target_id].sort().join('|');
      if (!findings.some((f) => [...f.atom_ids].sort().join('|') === key)) {
        findings.push({
          category: 'contradiction',
          severity: 'warning',
          atom_ids: [rel.source_id, rel.target_id],
          message: `${rel.source_id} contradicts ${rel.target_id} — both active`,
        });
      }
    }
  }

  return findings;
}

function findStaleAtoms(atoms: Atom[], memoryDir: string, staleDays: number): LintFinding[] {
  const findings: LintFinding[] = [];
  const staleTypes = new Set(['fact', 'decision']);

  // Build a map of atom_id → latest event timestamp
  const events = readEvents(memoryDir);
  const latestEvent = new Map<string, string>();
  for (const evt of events) {
    if (evt.atom_refs) {
      for (const ref of evt.atom_refs) {
        const existing = latestEvent.get(ref);
        if (!existing || evt.timestamp > existing) {
          latestEvent.set(ref, evt.timestamp);
        }
      }
    }
  }

  for (const atom of atoms) {
    if (atom.frontmatter.status !== 'active') continue;
    if (!staleTypes.has(atom.frontmatter.type)) continue;

    // Use latest event timestamp, falling back to updated_at
    const lastActivity = latestEvent.get(atom.frontmatter.id) ?? atom.frontmatter.updated_at;
    const days = daysSince(lastActivity);
    if (days > staleDays) {
      findings.push({
        category: 'stale',
        severity: 'warning',
        atom_ids: [atom.frontmatter.id],
        message: `${atom.frontmatter.id} — no events in ${days} days`,
      });
    }
  }

  return findings;
}

function findOrphanedAtoms(atoms: Atom[], memoryDir: string): LintFinding[] {
  const findings: LintFinding[] = [];
  const excludeTypes = new Set(['entity_summary', 'procedure']);

  // Gather all atom IDs that appear in any relation
  const connected = new Set<string>();
  if (indexExists(memoryDir)) {
    const relations = getAllRelations(memoryDir);
    for (const rel of relations) {
      connected.add(rel.source_id);
      connected.add(rel.target_id);
    }
  }

  for (const atom of atoms) {
    if (atom.frontmatter.status !== 'active') continue;
    if (excludeTypes.has(atom.frontmatter.type)) continue;
    if (connected.has(atom.frontmatter.id)) continue;

    findings.push({
      category: 'orphan',
      severity: 'info',
      atom_ids: [atom.frontmatter.id],
      message: `${atom.frontmatter.id} — zero relations`,
    });
  }

  return findings;
}

function findNearDuplicates(atoms: Atom[], memoryDir: string): LintFinding[] {
  const findings: LintFinding[] = [];
  if (!indexExists(memoryDir)) return findings;

  const activeAtoms = atoms.filter((a) => a.frontmatter.status === 'active');
  const activeById = new Map(activeAtoms.map((a) => [a.frontmatter.id, a]));
  const seen = new Set<string>();

  for (const atom of activeAtoms) {
    // Use the atom body's first line (title) as search query
    const title = atom.body.split('\n').find((l) => l.trim().length > 0)?.replace(/^#+\s*/, '').trim();
    if (!title || title.length < 5) continue;

    const results = searchFts(memoryDir, title, 5);
    if (!results) continue;

    const atomTags = atom.frontmatter.scope?.tags ?? [];

    for (const res of results) {
      if (res.atom_id === atom.frontmatter.id) continue;

      // Avoid duplicate findings (A ↔ B and B ↔ A)
      const key = [atom.frontmatter.id, res.atom_id].sort().join('|');
      if (seen.has(key)) continue;

      // Find the other atom to check tags
      const other = activeById.get(res.atom_id);
      if (!other) continue;

      const otherTags = other.frontmatter.scope?.tags ?? [];
      const overlap = tagJaccard(atomTags, otherTags);

      // Conservative: only flag if high FTS rank AND >50% tag overlap
      if (overlap > 0.5) {
        seen.add(key);
        findings.push({
          category: 'duplicate',
          severity: 'warning',
          atom_ids: [atom.frontmatter.id, res.atom_id],
          message: `${atom.frontmatter.id} ↔ ${res.atom_id} — high similarity (tags overlap ${(overlap * 100).toFixed(0)}%)`,
        });
      }
    }
  }

  return findings;
}

function findConfidenceDrift(atoms: Atom[]): LintFinding[] {
  const findings: LintFinding[] = [];

  for (const atom of atoms) {
    if (atom.frontmatter.type !== 'belief') continue;
    if (atom.frontmatter.status !== 'active') continue;
    if (atom.frontmatter.confidence >= 0.5) continue;

    const days = daysSince(atom.frontmatter.updated_at);
    if (days > 30) {
      findings.push({
        category: 'confidence_drift',
        severity: 'info',
        atom_ids: [atom.frontmatter.id],
        message: `${atom.frontmatter.id} — confidence ${atom.frontmatter.confidence}, no events in ${days} days`,
      });
    }
  }

  return findings;
}

function findTtlWarnings(atoms: Atom[]): LintFinding[] {
  const findings: LintFinding[] = [];

  for (const atom of atoms) {
    if (atom.frontmatter.ttl_days == null) continue;
    if (atom.frontmatter.status !== 'active' && atom.frontmatter.status !== 'draft') continue;

    const remaining = daysUntilExpiry(atom.frontmatter.created_at, atom.frontmatter.ttl_days);
    if (remaining <= 7 && remaining >= 0) {
      findings.push({
        category: 'ttl_warning',
        severity: 'warning',
        atom_ids: [atom.frontmatter.id],
        message: `${atom.frontmatter.id} — expires in ${remaining} day${remaining === 1 ? '' : 's'}`,
      });
    }
  }

  return findings;
}

// --- Main entry point ---

export function lintMemoryStore(memoryDir: string, options?: LintOptions): LintResult {
  const staleDays = options?.staleDays ?? 90;
  const atoms = listAtoms(memoryDir);

  const findings: LintFinding[] = [
    ...findContradictions(atoms, memoryDir),
    ...findStaleAtoms(atoms, memoryDir, staleDays),
    ...findOrphanedAtoms(atoms, memoryDir),
    ...findNearDuplicates(atoms, memoryDir),
    ...findConfidenceDrift(atoms),
    ...findTtlWarnings(atoms),
  ];

  const warnings = findings.filter((f) => f.severity === 'warning').length;
  const info = findings.filter((f) => f.severity === 'info').length;

  return {
    findings,
    summary: { total: findings.length, warnings, info },
  };
}
