/**
 * Zod schemas for validating Memory Atoms and Events.
 * These are the guardrails that prevent compaction loss.
 */

import { z } from 'zod';
import type { AtomType } from './types.js';
import {
  ATOM_STATUSES,
  ATOM_TYPES,
  CLASSIFICATIONS,
  EVENT_ACTIONS,
  RELATION_TYPES,
} from './types.js';

// --- Atom frontmatter schema ---

export const AtomFrontmatterSchema = z.object({
  id: z.string().min(1),
  type: z.enum(ATOM_TYPES),
  status: z.enum(ATOM_STATUSES),
  confidence: z.number().min(0).max(1),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  // #108: ttl_days >= 1 (zero meant "expire on next reflect" — meaningless;
  //        use null for no-expiry, or a positive integer day count).
  ttl_days: z.number().int().min(1).nullable(),
  scope: z
    .object({
      paths: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      domains: z.array(z.string()).optional(),
    })
    .optional(),
  classification: z.enum(CLASSIFICATIONS).default('TEAM'),
  provenance: z
    .object({
      episodes: z.array(z.string()).optional(),
      evidence: z.array(z.string()).optional(),
    })
    .optional(),
  links: z
    .object({
      related: z.array(z.string()).optional(),
      supersedes: z.array(z.string()).optional(),
      blocked_by: z.array(z.string()).optional(),
    })
    .optional(),
  relations: z
    .array(
      z.object({
        target: z.string().min(1),
        type: z.enum(RELATION_TYPES),
      }),
    )
    .optional(),
});

// --- Event schema ---

export const MemoryEventSchema = z.object({
  event_id: z.string().min(1),
  timestamp: z.string().datetime(),
  agent_id: z.string().min(1),
  session_id: z.string().min(1),
  action: z.enum(EVENT_ACTIONS),
  atom_refs: z.array(z.string()).optional(),
  touched_paths: z.array(z.string()).optional(),
  evidence: z.array(z.string()).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
  // V2 fields
  schema_version: z.literal(2).optional(),
  atom_snapshot: z.string().optional(),
  atom_snapshot_hash: z.string().optional(),
});

// --- Mutation actions (events that carry atom state) ---

export const MUTATION_ACTIONS = [
  'atom_created',
  'atom_updated',
  'atom_archived',
  'atom_promoted',
  'atom_expired',
  'atom_imported',
  // #109: conflict_resolved is a terminal mutation — it archives the
  //       conflict atom and carries a full atom_snapshot of the final
  //       (status=resolved) state. Replay treats it like atom_archived
  //       (removes from atom map); compactLog now sees it as a mutation
  //       and keeps the latest per atom_ref (it's always terminal, so
  //       this just means the resolved event survives compaction).
  'conflict_resolved',
] as const;

export function isMutationAction(action: string): boolean {
  return (MUTATION_ACTIONS as readonly string[]).includes(action);
}

// --- Validation helpers ---

export function validateAtomFrontmatter(data: unknown) {
  return AtomFrontmatterSchema.safeParse(data);
}

export function validateEvent(data: unknown) {
  return MemoryEventSchema.safeParse(data);
}

// --- ID generators ---
// Separate counters prevent interleaving between atom and event IDs.
// Random nonce provides extra collision resistance across module reloads.

let atomCounter = 0;
let eventCounter = 0;

/** Random 4-char nonce for ID uniqueness across module reloads. */
function nonce(): string {
  return Math.random().toString(36).slice(2, 6).padEnd(4, '0');
}

/**
 * Generate a sortable unique ID.
 * Format: TYPE-YYYY-MM-DD-SLUG-COUNTER
 */
export function generateAtomId(type: string, slug: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const clean = slug
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '') // Strip leading/trailing dashes
    .slice(0, 40);
  atomCounter = atomCounter + 1;
  const suffix = clean ? `-${clean}` : '';
  return `${type.toUpperCase().slice(0, 4)}-${date}${suffix}-${atomCounter.toString(36)}${nonce()}`;
}

/**
 * Generate a unique event ID (timestamp-based, sortable).
 * Includes process.pid and random nonce to prevent collisions across processes.
 */
export function generateEventId(): string {
  const now = Date.now();
  eventCounter = eventCounter + 1;
  const hex = now.toString(36) + '-' + process.pid.toString(36) + '-' + eventCounter.toString(36) + nonce();
  return `evt-${hex}`;
}

// --- Default TTLs by atom type ---

export const DEFAULT_TTLS: Record<AtomType, number | null> = {
  decision: null, // Decisions persist until explicitly reversed
  constraint: null, // Constraints persist (need periodic review)
  open_question: 90, // 90 days — should resolve or be re-asked
  belief: null, // Beliefs persist until superseded; confidence scores handle evolution
  fact: null, // Facts persist as reference data
  procedure: null, // Procedures persist
  entity_summary: 180, // 6 months — stale summaries should refresh
  preference: null, // Preferences persist until explicitly changed
  conflict: 30, // 30 days — conflicts should resolve
};

// --- Default scoring parameters (Phase 1 + 2) ---

/** Score multipliers per atom type. Higher = surfaces more in recall. */
export const DEFAULT_TYPE_WEIGHTS: Record<AtomType, number> = {
  constraint:     1.5, // Always relevant, structural anchors
  decision:       1.3, // Architectural decisions
  procedure:      1.2, // Operational knowledge
  fact:           1.1, // Grounding knowledge — up-weighted so it isn't buried (#283)
  preference:     1.1, // Grounding knowledge — up-weighted so it isn't buried (#283)
  conflict:       1.1, // Active conflicts need attention
  open_question:  0.9, // Less urgent
  belief:         0.6, // High volume, exploratory — STRONG discount (was 0.8: too weak,
                       // a semantically-broad belief still buried grounding facts, see #283)
  entity_summary: 0.6, // Reference material — same strong discount
};

/** Minimum confidence floor for the conf_factor multiplier (0.7 = 70% floor). */
export const DEFAULT_CONFIDENCE_FLOOR = 0.7;

/** Minimum token reservations per type — guarantee these atoms appear in context. */
export const DEFAULT_TYPE_RESERVATIONS: Partial<Record<AtomType, number>> = {
  decision:   800, // ~2–3 decisions always present
  constraint: 400, // Constraints always visible
  conflict:   400, // Active conflicts always surfaced
};

/**
 * Default token reservations for fill-mode CLAUDE.md render.
 *
 * Unlike DEFAULT_TYPE_RESERVATIONS (tuned for task-driven recall), fill mode
 * has no relevance signal — every atom type that exists in the store needs
 * a guaranteed slice or beliefs monopolise the budget (issue #154).
 *
 * Raw totals here sum well above MAX_RESERVATION_RATIO * budget; the
 * selector scales them down so they fit. The ratios between types are what
 * matter, not the absolute values.
 */
export const DEFAULT_FILL_TYPE_RESERVATIONS: Partial<Record<AtomType, number>> = {
  decision:   800,
  fact:       1200,
  procedure:  600,
  constraint: 400,
  conflict:   400,
  preference: 400,
  belief:     4000,
  open_question: 200,
  // entity_summary intentionally omitted — usually large, low signal in fills.
};
