/**
 * Zod schemas for validating Memory Atoms and Events.
 * These are the guardrails that prevent compaction loss.
 */

import { z } from 'zod';
import {
  ATOM_STATUSES,
  ATOM_TYPES,
  CLASSIFICATIONS,
  EVENT_ACTIONS,
} from './types.js';

// --- Atom frontmatter schema ---

export const AtomFrontmatterSchema = z.object({
  id: z.string().min(1),
  type: z.enum(ATOM_TYPES),
  status: z.enum(ATOM_STATUSES),
  confidence: z.number().min(0).max(1),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  ttl_days: z.number().int().positive().nullable(),
  scope: z
    .object({
      paths: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      domains: z.array(z.string()).optional(),
    })
    .optional(),
  classification: z.enum(CLASSIFICATIONS).optional(),
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

let counter = 0;

/**
 * Generate a sortable unique ID.
 * Format: TYPE-YYYY-MM-DD-SLUG
 */
export function generateAtomId(type: string, slug: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const clean = slug
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '') // Strip leading/trailing dashes
    .slice(0, 40);
  counter = counter + 1;
  const suffix = clean ? `-${clean}` : '';
  return `${type.toUpperCase().slice(0, 4)}-${date}${suffix}-${counter.toString(36)}`;
}

/**
 * Generate a unique event ID (timestamp-based, sortable).
 * Includes process.pid to prevent collisions across processes.
 */
export function generateEventId(): string {
  const now = Date.now();
  counter = counter + 1;
  const hex = now.toString(36) + '-' + process.pid.toString(36) + '-' + counter.toString(36);
  return `evt-${hex}`;
}

// --- Default TTLs by atom type ---

export const DEFAULT_TTLS: Record<string, number | null> = {
  decision: null, // Decisions persist
  constraint: null, // Constraints persist (but need periodic review)
  open_question: 90, // 90 days
  belief: 30, // 30 days unless promoted
  fact: null, // Facts persist
  procedure: null, // Procedures persist
  entity_summary: 180, // 6 months
  preference: 180, // 6 months
  conflict: 30, // 30 days to resolve
};
