/**
 * MCP tool registrations for Memory Kernel.
 * 10 tools: remember, recall, reflect, merge, gc, list_conflicts, resolve_conflict, get_context_bundle, share_atom, unshare_atom.
 * All tool outputs include a provenance block for traceability.
 */

import { z } from 'zod';
import fs from 'fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  createAtom,
  recallWithEmbeddings,
  reflect,
  mergeEventLogs,
  listAtoms,
  resolveConflict,
  checkpoint,
  atomFilePath,
  normalizeTimestamp,
  appendEvent,
  getLastEventId,
  queryIndex,
  indexExists,
  shareAtom,
  unshareAtom,
  listSharedAtoms,
} from '../index.js';
import { isIsolated, assertValidAgentId } from '../isolation.js';
import { ATOM_TYPES, ATOM_STATUSES, CLASSIFICATIONS } from '../types.js';
import { embedAtom } from '../embed-sync.js';
import { resolveAgentId, resolveSessionId, resolveMemoryDir, type McpContext } from './context.js';

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

interface ProvenanceBlock {
  memoryDir: string;
  agent_id: string;
  session_id: string;
  executed_at: string;
  event_id?: string;
  atom_refs?: string[];
}

/**
 * Build a provenance block for tool responses.
 *
 * `event_id` is included for single-event mutation tools (remember, resolve_conflict,
 * get_context_bundle). Multi-event tools (reflect, merge, gc) omit it because there
 * is no single event to reference. Read-only tools (list_conflicts) don't emit events.
 */
function buildProvenance(
  ctx: McpContext,
  agentId: string,
  sessionId: string,
  extra?: { event_id?: string; atom_refs?: string[] },
): ProvenanceBlock {
  return {
    memoryDir: ctx.memoryDir,
    agent_id: agentId,
    session_id: sessionId,
    executed_at: normalizeTimestamp(),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Shared tool result helper
// ---------------------------------------------------------------------------

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function err(message: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

/** Reusable Zod schema for agent IDs — alphanumeric, dash, underscore only. */
const agentIdSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/, 'agent_id must be alphanumeric, dash, or underscore');

// ---------------------------------------------------------------------------
// Tool handlers (exported for contract tests — no transport needed)
// ---------------------------------------------------------------------------

// --- remember ---

const rememberSchema = {
  type: z.enum(ATOM_TYPES).describe('Atom type'),
  slug: z.string().min(1).max(80).describe('Short kebab-case identifier for the atom ID'),
  body: z.string().min(1).describe('Markdown content of the atom'),
  confidence: z.number().min(0).max(1).optional().describe('Confidence 0–1'),
  classification: z.enum(CLASSIFICATIONS).optional().describe('Visibility classification, default TEAM'),
  scope_paths: z.array(z.string()).optional().describe('Filesystem paths this atom is scoped to'),
  scope_tags: z.array(z.string()).optional().describe('Tags for filtering'),
  agent_id: agentIdSchema.optional().describe('Override agent ID for this operation'),
  session_id: z.string().optional().describe('Override session ID for this operation'),
};

export type RememberInput = {
  type: (typeof ATOM_TYPES)[number];
  slug: string;
  body: string;
  confidence?: number;
  classification?: (typeof CLASSIFICATIONS)[number];
  scope_paths?: string[];
  scope_tags?: string[];
  agent_id?: string;
  session_id?: string;
};

export async function handleRemember(ctx: McpContext, input: RememberInput): Promise<ToolResult> {
  try {
    const agentId = resolveAgentId(ctx, input.agent_id);
    const sessionId = resolveSessionId(ctx, input.session_id);
    const memDir = resolveMemoryDir(ctx, agentId);
    const atom = createAtom({
      memoryDir: memDir,
      agent_id: agentId,
      session_id: sessionId,
      type: input.type,
      slug: input.slug,
      body: input.body,
      confidence: input.confidence,
      classification: input.classification,
      scope: (input.scope_paths ?? input.scope_tags)
        ? { paths: input.scope_paths, tags: input.scope_tags }
        : undefined,
    });
    // Auto-embed the new atom (no-op if embeddings not configured)
    const embedded = await embedAtom(memDir, atom);

    const result = {
      atom: {
        id: atom.frontmatter.id,
        type: atom.frontmatter.type,
        status: atom.frontmatter.status,
        confidence: atom.frontmatter.confidence,
        created_at: atom.frontmatter.created_at,
        filePath: atom.filePath,
        embedded,
      },
      provenance: buildProvenance(ctx, agentId, sessionId, {
        event_id: getLastEventId(memDir),
        atom_refs: [atom.frontmatter.id],
      }),
    };
    return ok(result);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

// --- recall ---

const recallSchema = {
  task: z.string().optional().describe('Natural language task for FTS re-ranking'),
  paths: z.array(z.string()).optional().describe('Scope paths to match'),
  types: z.array(z.enum(ATOM_TYPES)).optional().describe('Filter by atom type'),
  statuses: z.array(z.enum(ATOM_STATUSES)).optional().describe('Filter by status'),
  tags: z.array(z.string()).optional().describe('Filter by scope tags'),
  include_episodes: z.boolean().optional().describe('Include episode summaries'),
  max_tokens: z.number().int().min(0).optional().describe('Token budget'),
  decay_half_life: z.number().positive().optional().describe('Half-life for temporal decay in days (default: 30)'),
  decay_weight: z.number().min(0).max(1).optional().describe('Weight of recency vs relevance, 0-1 (default: 0.2)'),
  type_weights: z.record(z.string(), z.number()).optional().describe('Per-type score multipliers, e.g. {"constraint": 2.0}'),
  type_reservations: z.record(z.string(), z.number()).optional().describe('Minimum token slots reserved per type, e.g. {"decision": 800}'),
  graph_boost: z.boolean().optional().describe('Enable graph-walk neighbour boost (default: true)'),
  agent_id: agentIdSchema.optional(),
  session_id: z.string().optional(),
};

export type RecallInput = {
  task?: string;
  paths?: string[];
  types?: Array<(typeof ATOM_TYPES)[number]>;
  statuses?: Array<(typeof ATOM_STATUSES)[number]>;
  tags?: string[];
  include_episodes?: boolean;
  max_tokens?: number;
  decay_half_life?: number;
  decay_weight?: number;
  type_weights?: Record<string, number>;
  type_reservations?: Record<string, number>;
  graph_boost?: boolean;
  agent_id?: string;
  session_id?: string;
};

export async function handleRecall(ctx: McpContext, input: RecallInput): Promise<ToolResult> {
  try {
    const agentId = resolveAgentId(ctx, input.agent_id);
    const sessionId = resolveSessionId(ctx, input.session_id);
    const memDir = resolveMemoryDir(ctx, agentId);
    const bundle = await recallWithEmbeddings(memDir, {
      task: input.task,
      paths: input.paths,
      types: input.types,
      statuses: input.statuses,
      tags: input.tags,
      include_episodes: input.include_episodes,
      max_tokens: input.max_tokens,
      decay_half_life: input.decay_half_life,
      decay_weight: input.decay_weight,
      type_weights: input.type_weights as Record<import('../types.js').AtomType, number> | undefined,
      type_reservations: input.type_reservations as Partial<Record<import('../types.js').AtomType, number>> | undefined,
      graph_boost: input.graph_boost,
      agent_id: agentId,
      session_id: sessionId,
    });
    const result = {
      index: bundle.index,
      handoff: bundle.handoff,
      constraints: bundle.constraints,
      atoms: bundle.atoms.map((a) => ({
        id: a.frontmatter.id,
        type: a.frontmatter.type,
        status: a.frontmatter.status,
        confidence: a.frontmatter.confidence,
        body: a.body,
        provenance: a.frontmatter.provenance,
      })),
      episodes: bundle.episodes,
      token_estimate: bundle.token_estimate,
      provenance: buildProvenance(ctx, agentId, sessionId),
    };
    return ok(result);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

// --- reflect ---

const reflectSchema = {
  agent_id: agentIdSchema.optional(),
  session_id: z.string().optional(),
};

export type ReflectInput = { agent_id?: string; session_id?: string };

export async function handleReflect(ctx: McpContext, input: ReflectInput): Promise<ToolResult> {
  try {
    const agentId = resolveAgentId(ctx, input.agent_id);
    const sessionId = resolveSessionId(ctx, input.session_id);
    const memDir = resolveMemoryDir(ctx, agentId);
    const reflectResult = reflect({ memoryDir: memDir, agent_id: agentId, session_id: sessionId });
    const result = {
      ...reflectResult,
      provenance: buildProvenance(ctx, agentId, sessionId),
    };
    return ok(result);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

// --- merge ---

const mergeSchema = {
  remote_dir: z.string().min(1).describe('Absolute path to remote memory directory'),
  dry_run: z.boolean().optional().describe('Preview without writing, default false'),
  agent_id: agentIdSchema.optional(),
  session_id: z.string().optional(),
};

export type MergeInput = { remote_dir: string; dry_run?: boolean; agent_id?: string; session_id?: string };

export async function handleMerge(ctx: McpContext, input: MergeInput): Promise<ToolResult> {
  try {
    if (!fs.existsSync(input.remote_dir)) {
      return err(`remote_dir does not exist: ${input.remote_dir}`);
    }
    const agentId = resolveAgentId(ctx, input.agent_id);
    const sessionId = resolveSessionId(ctx, input.session_id);
    const memDir = resolveMemoryDir(ctx, agentId);
    const mergeResult = mergeEventLogs({
      localDir: memDir,
      remoteDir: input.remote_dir,
      agent_id: agentId,
      session_id: sessionId,
      dryRun: input.dry_run ?? false,
    });
    const result = {
      ...mergeResult,
      dry_run: input.dry_run ?? false,
      provenance: buildProvenance(ctx, agentId, sessionId),
    };
    return ok(result);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

// --- gc ---

const gcSchema = {
  agent_id: agentIdSchema.optional(),
  session_id: z.string().optional(),
};

export type GcInput = { agent_id?: string; session_id?: string };

export async function handleGc(ctx: McpContext, input: GcInput): Promise<ToolResult> {
  try {
    const agentId = resolveAgentId(ctx, input.agent_id);
    const sessionId = resolveSessionId(ctx, input.session_id);
    const memDir = resolveMemoryDir(ctx, agentId);
    const reflectResult = reflect({ memoryDir: memDir, agent_id: agentId, session_id: sessionId });
    const result = {
      expired: reflectResult.expired,
      archived: reflectResult.archived,
      deduped: reflectResult.deduped,
      promoted: reflectResult.promoted,
      conflicts_found: reflectResult.conflicts_found,
      provenance: buildProvenance(ctx, agentId, sessionId),
    };
    return ok(result);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

// --- list_conflicts ---

const listConflictsSchema = {
  agent_id: agentIdSchema.optional(),
  session_id: z.string().optional(),
};

export type ListConflictsInput = { agent_id?: string; session_id?: string };

export async function handleListConflicts(
  ctx: McpContext,
  input: ListConflictsInput,
): Promise<ToolResult> {
  try {
    const agentId = resolveAgentId(ctx, input.agent_id);
    const sessionId = resolveSessionId(ctx, input.session_id);
    const memDir = resolveMemoryDir(ctx, agentId);

    let conflicts;
    if (indexExists(memDir)) {
      const rows = queryIndex(memDir, { types: ['conflict'], statuses: ['active'] });
      if (rows !== null) {
        const atoms = listAtoms(memDir);
        const conflictIds = new Set(rows.map((r) => r.atom_id));
        conflicts = atoms.filter((a) => conflictIds.has(a.frontmatter.id));
      } else {
        conflicts = listAtoms(memDir).filter(
          (a) => a.frontmatter.type === 'conflict' && a.frontmatter.status === 'active',
        );
      }
    } else {
      conflicts = listAtoms(memDir).filter(
        (a) => a.frontmatter.type === 'conflict' && a.frontmatter.status === 'active',
      );
    }

    const result = {
      conflicts: conflicts.map((a) => ({
        id: a.frontmatter.id,
        status: a.frontmatter.status,
        confidence: a.frontmatter.confidence,
        created_at: a.frontmatter.created_at,
        updated_at: a.frontmatter.updated_at,
        body: a.body,
        links: a.frontmatter.links,
        filePath: a.filePath,
      })),
      count: conflicts.length,
      provenance: buildProvenance(ctx, agentId, sessionId),
    };
    return ok(result);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

// --- resolve_conflict ---

const resolveConflictSchema = {
  conflict_atom_id: z.string().min(1).describe('ID of the conflict atom to resolve'),
  resolution_note: z.string().optional().describe('Optional note about how the conflict was resolved'),
  agent_id: agentIdSchema.optional(),
  session_id: z.string().optional(),
};

export type ResolveConflictInput = {
  conflict_atom_id: string;
  resolution_note?: string;
  agent_id?: string;
  session_id?: string;
};

export async function handleResolveConflict(
  ctx: McpContext,
  input: ResolveConflictInput,
): Promise<ToolResult> {
  try {
    const agentId = resolveAgentId(ctx, input.agent_id);
    const sessionId = resolveSessionId(ctx, input.session_id);
    const memDir = resolveMemoryDir(ctx, agentId);
    const filePath = atomFilePath(memDir, input.conflict_atom_id, 'conflict');
    if (!fs.existsSync(filePath)) {
      return err(`Conflict atom not found: ${input.conflict_atom_id}`);
    }
    const { atom, event_id } = resolveConflict({
      memoryDir: memDir,
      agent_id: agentId,
      session_id: sessionId,
      filePath,
      resolutionNote: input.resolution_note,
    });
    const result = {
      conflict_id: atom.frontmatter.id,
      status: atom.frontmatter.status,
      resolution_note: input.resolution_note,
      provenance: buildProvenance(ctx, agentId, sessionId, { event_id: event_id || undefined }),
    };
    return ok(result);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

// --- get_context_bundle ---

const getContextBundleSchema = {
  task: z.string().optional().describe('Task description for scoping and FTS re-ranking'),
  max_tokens: z.number().int().min(0).optional().describe('Token budget, default 4000'),
  skip_reflect: z.boolean().optional().describe('Skip reflect step, default false'),
  agent_id: agentIdSchema.optional(),
  session_id: z.string().optional(),
};

export type GetContextBundleInput = {
  task?: string;
  max_tokens?: number;
  skip_reflect?: boolean;
  agent_id?: string;
  session_id?: string;
};

export async function handleGetContextBundle(
  ctx: McpContext,
  input: GetContextBundleInput,
): Promise<ToolResult> {
  try {
    const agentId = resolveAgentId(ctx, input.agent_id);
    const sessionId = resolveSessionId(ctx, input.session_id);
    const memDir = resolveMemoryDir(ctx, agentId);
    const checkpointResult = checkpoint({
      memoryDir: memDir,
      agent_id: agentId,
      session_id: sessionId,
      task: input.task,
      max_tokens: input.max_tokens,
      skipReflect: input.skip_reflect,
      baseDir: ctx.isolated ? ctx.memoryDir : undefined,
      isolated: ctx.isolated,
    });
    appendEvent(memDir, 'atom_read', {
      agent_id: agentId,
      session_id: sessionId,
      atom_refs: checkpointResult.bundle.atoms.map((a) => a.frontmatter.id),
      meta: {
        operation: 'get_context_bundle',
        query_task: input.task,
        atoms_returned: checkpointResult.bundle.atoms.length,
        token_estimate: checkpointResult.bundle.token_estimate,
      },
    });
    const result = {
      markdown: checkpointResult.markdown,
      token_estimate: checkpointResult.bundle.token_estimate,
      atom_count: checkpointResult.bundle.atoms.length,
      event_id: checkpointResult.event_id,
      error: checkpointResult.error,
      provenance: buildProvenance(ctx, agentId, sessionId, { event_id: checkpointResult.event_id }),
    };
    return ok(result);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

// --- share_atom ---

const shareAtomSchema = {
  atom_id: z.string().min(1).describe('ID of the atom to share'),
  from_agent: agentIdSchema.describe('Agent ID that owns the atom'),
  agent_id: agentIdSchema.optional(),
  session_id: z.string().optional(),
};

export type ShareAtomInput = {
  atom_id: string;
  from_agent: string;
  agent_id?: string;
  session_id?: string;
};

export async function handleShareAtom(
  ctx: McpContext,
  input: ShareAtomInput,
): Promise<ToolResult> {
  try {
    if (!ctx.isolated) {
      return err('share_atom is only available in isolated (per-agent) mode');
    }
    const agentId = resolveAgentId(ctx, input.agent_id);
    const sessionId = resolveSessionId(ctx, input.session_id);
    const shared = shareAtom(ctx.memoryDir, input.atom_id, input.from_agent, {
      agent_id: agentId,
      session_id: sessionId,
    });
    const result = {
      atom_id: shared.atom_id,
      shared_path: shared.shared_path,
      source_agent: shared.source_agent,
      provenance: buildProvenance(ctx, agentId, sessionId),
    };
    return ok(result);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

// --- unshare_atom ---

const unshareAtomSchema = {
  atom_id: z.string().min(1).describe('ID of the atom to remove from shared namespace'),
  agent_id: agentIdSchema.optional(),
  session_id: z.string().optional(),
};

export type UnshareAtomInput = {
  atom_id: string;
  agent_id?: string;
  session_id?: string;
};

export async function handleUnshareAtom(
  ctx: McpContext,
  input: UnshareAtomInput,
): Promise<ToolResult> {
  try {
    if (!ctx.isolated) {
      return err('unshare_atom is only available in isolated (per-agent) mode');
    }
    const agentId = resolveAgentId(ctx, input.agent_id);
    const sessionId = resolveSessionId(ctx, input.session_id);
    unshareAtom(ctx.memoryDir, input.atom_id, {
      agent_id: agentId,
      session_id: sessionId,
    });
    const result = {
      atom_id: input.atom_id,
      removed: true,
      provenance: buildProvenance(ctx, agentId, sessionId),
    };
    return ok(result);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------
// Register all tools on the server
// ---------------------------------------------------------------------------

export function registerTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    'mk_remember',
    {
      title: 'Remember',
      description: 'Create a new memory atom (fact, decision, constraint, belief, etc.).',
      inputSchema: rememberSchema,
    },
    (args) => handleRemember(ctx, args as RememberInput),
  );

  server.registerTool(
    'mk_recall',
    {
      title: 'Recall',
      description: 'Load relevant context atoms from memory, optionally scoped by task, paths, or type.',
      inputSchema: recallSchema,
    },
    (args) => handleRecall(ctx, args as RecallInput),
  );

  server.registerTool(
    'mk_reflect',
    {
      title: 'Reflect',
      description: 'Consolidate memory: dedup, TTL expiry, auto-promote beliefs, detect conflicts, regenerate views.',
      inputSchema: reflectSchema,
    },
    (args) => handleReflect(ctx, args as ReflectInput),
  );

  server.registerTool(
    'mk_merge',
    {
      title: 'Merge',
      description: 'Merge a remote agent\'s event log into local memory (event-log union, conflict detection).',
      inputSchema: mergeSchema,
    },
    (args) => handleMerge(ctx, args as MergeInput),
  );

  server.registerTool(
    'mk_gc',
    {
      title: 'Garbage Collect',
      description: 'Archive TTL-expired and duplicate atoms, regenerate views.',
      inputSchema: gcSchema,
    },
    (args) => handleGc(ctx, args as GcInput),
  );

  server.registerTool(
    'mk_list_conflicts',
    {
      title: 'List Conflicts',
      description: 'List all active conflict atoms currently in the memory store.',
      inputSchema: listConflictsSchema,
    },
    (args) => handleListConflicts(ctx, args as ListConflictsInput),
  );

  server.registerTool(
    'mk_resolve_conflict',
    {
      title: 'Resolve Conflict',
      description: 'Resolve (archive) a conflict atom and record a resolution note.',
      inputSchema: resolveConflictSchema,
    },
    (args) => handleResolveConflict(ctx, args as ResolveConflictInput),
  );

  server.registerTool(
    'mk_get_context_bundle',
    {
      title: 'Get Context Bundle',
      description: 'Generate a full handoff checkpoint: run reflect, load context, return assembled markdown bundle.',
      inputSchema: getContextBundleSchema,
    },
    (args) => handleGetContextBundle(ctx, args as GetContextBundleInput),
  );

  server.registerTool(
    'mk_share_atom',
    {
      title: 'Share Atom',
      description: 'Copy an atom from an agent\'s private store to the shared namespace (isolated mode only).',
      inputSchema: shareAtomSchema,
    },
    (args) => handleShareAtom(ctx, args as ShareAtomInput),
  );

  server.registerTool(
    'mk_unshare_atom',
    {
      title: 'Unshare Atom',
      description: 'Remove an atom from the shared namespace (isolated mode only).',
      inputSchema: unshareAtomSchema,
    },
    (args) => handleUnshareAtom(ctx, args as UnshareAtomInput),
  );
}
