/**
 * MCP tool registrations for Memory Kernel.
 * 8 tools: remember, recall, reflect, merge, gc, list_conflicts, resolve_conflict, get_context_bundle.
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
} from '../index.js';
import { ATOM_TYPES, ATOM_STATUSES, CLASSIFICATIONS } from '../types.js';
import { embedAtom } from '../embed-sync.js';
import { resolveAgentId, resolveSessionId, type McpContext } from './context.js';

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
  agent_id: z.string().optional().describe('Override agent ID for this operation'),
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
    const atom = createAtom({
      memoryDir: ctx.memoryDir,
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
    const embedded = await embedAtom(ctx.memoryDir, atom);

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
        event_id: getLastEventId(ctx.memoryDir),
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
  agent_id: z.string().optional(),
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
  agent_id?: string;
  session_id?: string;
};

export async function handleRecall(ctx: McpContext, input: RecallInput): Promise<ToolResult> {
  try {
    const agentId = resolveAgentId(ctx, input.agent_id);
    const sessionId = resolveSessionId(ctx, input.session_id);
    const bundle = await recallWithEmbeddings(ctx.memoryDir, {
      task: input.task,
      paths: input.paths,
      types: input.types,
      statuses: input.statuses,
      tags: input.tags,
      include_episodes: input.include_episodes,
      max_tokens: input.max_tokens,
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
  agent_id: z.string().optional(),
  session_id: z.string().optional(),
};

export type ReflectInput = { agent_id?: string; session_id?: string };

export async function handleReflect(ctx: McpContext, input: ReflectInput): Promise<ToolResult> {
  try {
    const agentId = resolveAgentId(ctx, input.agent_id);
    const sessionId = resolveSessionId(ctx, input.session_id);
    const reflectResult = reflect({ memoryDir: ctx.memoryDir, agent_id: agentId, session_id: sessionId });
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
  agent_id: z.string().optional(),
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
    const mergeResult = mergeEventLogs({
      localDir: ctx.memoryDir,
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
  agent_id: z.string().optional(),
  session_id: z.string().optional(),
};

export type GcInput = { agent_id?: string; session_id?: string };

export async function handleGc(ctx: McpContext, input: GcInput): Promise<ToolResult> {
  try {
    const agentId = resolveAgentId(ctx, input.agent_id);
    const sessionId = resolveSessionId(ctx, input.session_id);
    const reflectResult = reflect({ memoryDir: ctx.memoryDir, agent_id: agentId, session_id: sessionId });
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
  agent_id: z.string().optional(),
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

    let conflicts;
    if (indexExists(ctx.memoryDir)) {
      const rows = queryIndex(ctx.memoryDir, { types: ['conflict'], statuses: ['active'] });
      if (rows !== null) {
        const atoms = listAtoms(ctx.memoryDir);
        const conflictIds = new Set(rows.map((r) => r.atom_id));
        conflicts = atoms.filter((a) => conflictIds.has(a.frontmatter.id));
      } else {
        conflicts = listAtoms(ctx.memoryDir).filter(
          (a) => a.frontmatter.type === 'conflict' && a.frontmatter.status === 'active',
        );
      }
    } else {
      conflicts = listAtoms(ctx.memoryDir).filter(
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
  agent_id: z.string().optional(),
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
    const filePath = atomFilePath(ctx.memoryDir, input.conflict_atom_id, 'conflict');
    if (!fs.existsSync(filePath)) {
      return err(`Conflict atom not found: ${input.conflict_atom_id}`);
    }
    const { atom, event_id } = resolveConflict({
      memoryDir: ctx.memoryDir,
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
  agent_id: z.string().optional(),
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
    const checkpointResult = checkpoint({
      memoryDir: ctx.memoryDir,
      agent_id: agentId,
      session_id: sessionId,
      task: input.task,
      max_tokens: input.max_tokens,
      skipReflect: input.skip_reflect,
    });
    appendEvent(ctx.memoryDir, 'atom_read', {
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
}
