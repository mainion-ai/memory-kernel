import fs from 'fs'
import path from 'path'
import { Type, type Static } from '@sinclair/typebox'
import {
  createAtom, recall, recallWithEmbeddings, reflect, checkpoint,
  writeEpisode, listAtoms, indexStats, reindex,
  ATOM_TYPES,
} from 'memory-kernel'
import type { AtomType, Classification, ContextBundle, RecallQuery } from 'memory-kernel'
// OpenClaw SDK types — resolved at runtime via peer dependency
// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface OpenClawPluginApi {
  pluginConfig: unknown
  registerTool(def: any, opts: { name: string }): void
  registerHook(
    events: string | string[],
    handler: (event: any) => Promise<void>,
    opts?: { name?: string; description?: string },
  ): void
}

// ── Config schema ─────────────────────────────────────────────────────────────

type PluginConfig = {
  memoryDir: string
  encryptionKey?: string
  agentId?: string
  embeddingProvider?: string
  embeddingApiKey?: string
  embeddingModel?: string
}

const pluginConfigSchema = {
  parse(value: unknown): PluginConfig {
    const cfg = (value ?? {}) as Record<string, unknown>

    const memoryDir = typeof cfg['memoryDir'] === 'string' ? cfg['memoryDir'] : undefined
    if (!memoryDir && !process.env.MEMORY_DIR) {
      throw new Error(
        'memory-kernel: memoryDir is required. ' +
          'Set it in openclaw.json plugin config or export MEMORY_DIR.',
      )
    }

    return {
      memoryDir: path.resolve(memoryDir ?? process.env.MEMORY_DIR!),
      encryptionKey: typeof cfg['encryptionKey'] === 'string' ? cfg['encryptionKey'] : undefined,
      agentId: typeof cfg['agentId'] === 'string' ? cfg['agentId'] : undefined,
      embeddingProvider:
        typeof cfg['embeddingProvider'] === 'string' ? cfg['embeddingProvider'] : undefined,
      embeddingApiKey:
        typeof cfg['embeddingApiKey'] === 'string' ? cfg['embeddingApiKey'] : undefined,
      embeddingModel:
        typeof cfg['embeddingModel'] === 'string' ? cfg['embeddingModel'] : undefined,
    }
  },
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      memoryDir: { type: 'string', description: 'Absolute path to the memory-kernel directory' },
      encryptionKey: { type: 'string', description: 'AES-256-GCM key for SECRET atom encryption' },
      agentId: { type: 'string', description: 'Agent label written to the audit trail' },
      embeddingProvider: {
        type: 'string',
        description: 'Embedding provider (e.g. "openai"). Enables semantic recall.',
      },
      embeddingApiKey: {
        type: 'string',
        description:
          'API key for embedding provider. Falls back to OPENAI_API_KEY env when provider is openai.',
      },
      embeddingModel: {
        type: 'string',
        description: 'Embedding model ID (e.g. "text-embedding-3-small"). Provider default if omitted.',
      },
    },
    required: [],
  },
  uiHints: {
    memoryDir: {
      label: 'Memory directory',
      placeholder: '~/.openclaw/mk-memory',
      help: 'Path to the memory-kernel storage directory (created with: mk init <path>)',
    },
    encryptionKey: {
      label: 'Encryption key',
      sensitive: true,
      placeholder: '${MEMORY_ENCRYPTION_KEY}',
      help: '64-char hex key or passphrase for encrypting SECRET atoms. Optional.',
    },
    agentId: {
      label: 'Agent ID',
      placeholder: 'openclaw',
      help: 'Label recorded in the audit event log. Defaults to "openclaw".',
    },
    embeddingProvider: {
      label: 'Embedding provider',
      placeholder: 'openai',
      help: 'Enables semantic recall. Set to "openai" (or another supported provider).',
    },
    embeddingApiKey: {
      label: 'Embedding API key',
      sensitive: true,
      placeholder: '${OPENAI_API_KEY}',
      help: 'API key for embeddings. Falls back to OPENAI_API_KEY env if provider is openai.',
    },
    embeddingModel: {
      label: 'Embedding model',
      placeholder: 'text-embedding-3-small',
      help: 'Optional. Provider-specific default if omitted.',
    },
  },
}

function ok(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text }], ...(details ? { details } : {}) }
}

// Use embedding-backed recall when both provider and key are available,
// otherwise fall back to structured FTS5 recall.
async function smartRecall(memoryDir: string, query: RecallQuery): Promise<ContextBundle> {
  if (process.env.EMBEDDING_PROVIDER && process.env.EMBEDDING_API_KEY) {
    return await recallWithEmbeddings(memoryDir, query)
  }
  return recall(memoryDir, query)
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const RememberParams = Type.Object({
  type: Type.Union(ATOM_TYPES.map((t) => Type.Literal(t)), {
    description: 'Atom type: fact | decision | constraint | belief | open_question',
  }),
  slug: Type.String({
    description: 'Short kebab-case identifier, 1–80 chars (e.g. "use-typescript-for-new-modules")',
  }),
  body: Type.String({
    description: 'Markdown body. For decisions include the rationale.',
  }),
  confidence: Type.Optional(
    Type.Number({ minimum: 0, maximum: 1, description: 'Confidence 0–1. Default: 0.75' }),
  ),
  classification: Type.Optional(
    Type.Union(
      [
        Type.Literal('PUBLIC'),
        Type.Literal('TEAM'),
        Type.Literal('PERSONAL'),
        Type.Literal('SECRET'),
      ],
      { description: 'Visibility. Default: TEAM' },
    ),
  ),
  ttl_days: Type.Optional(Type.Number({ description: 'Days until auto-expiry. Omit for permanent.' })),
  scope_tags: Type.Optional(
    Type.Array(Type.String(), { description: 'Tags for scoped recall (e.g. ["project:alpha"])' }),
  ),
})

const RecallParams = Type.Object({
  task: Type.Optional(
    Type.String({ description: 'What you are doing — enables FTS5 re-ranking' }),
  ),
  types: Type.Optional(
    Type.Array(Type.Union(ATOM_TYPES.map((t) => Type.Literal(t))), {
      description: 'Filter by atom type (e.g. ["decision","constraint"])',
    }),
  ),
  tags: Type.Optional(Type.Array(Type.String(), { description: 'Filter by scope tags' })),
  include_episodes: Type.Optional(Type.Boolean({ description: 'Include session episode summaries' })),
  max_tokens: Type.Optional(Type.Number({ description: 'Token budget. Default: 4000' })),
})

const ReflectParams = Type.Object({})

const ContextBundleParams = Type.Object({
  task: Type.Optional(Type.String({ description: 'Task description — scopes the recall' })),
  max_tokens: Type.Optional(Type.Number({ description: 'Token budget. Default: 4000' })),
  skipReflect: Type.Optional(Type.Boolean({ description: 'Skip reflect if just ran. Default: false' })),
})

// ── Plugin ────────────────────────────────────────────────────────────────────

const memoryKernelPlugin = {
  id: 'memory-kernel',
  name: 'Memory (memory-kernel)',
  description:
    'Structured typed memory with event-log replay, confidence scoring, and conflict detection. ' +
    'Use for facts, decisions, constraints, beliefs, and open questions.',
  kind: 'tool',
  configSchema: pluginConfigSchema,

  register(api: OpenClawPluginApi) {
    const cfg = pluginConfigSchema.parse(api.pluginConfig)
    const { memoryDir } = cfg
    const agentId = cfg.agentId ?? 'openclaw'

    // Track the current session id for audit-trail propagation into tool calls.
    // Updated by lifecycle hooks (agent:bootstrap, command:*, session:compact:before).
    // Tools read this instead of hardcoding 'unknown', restoring a meaningful audit trail.
    let currentSessionId = 'unknown'
    const setSession = (s: unknown) => {
      if (typeof s === 'string' && s.length > 0) currentSessionId = s
    }

    // memory-kernel reads MEMORY_ENCRYPTION_KEY from process.env at call time.
    // Setting it here at plugin registration is intentional; a per-call override API
    // is not yet exposed. Note: this makes the key visible to all code in this process.
    if (cfg.encryptionKey) process.env.MEMORY_ENCRYPTION_KEY = cfg.encryptionKey

    // Embedding config: propagate to env for memory-kernel SDK calls.
    // If embeddingProvider is "openai" and no explicit embeddingApiKey is given,
    // fall back to OPENAI_API_KEY so users can reuse their existing OpenAI key
    // without duplicating it.
    if (cfg.embeddingProvider) process.env.EMBEDDING_PROVIDER = cfg.embeddingProvider
    if (cfg.embeddingApiKey) {
      process.env.EMBEDDING_API_KEY = cfg.embeddingApiKey
    } else if (cfg.embeddingProvider === 'openai' && process.env.OPENAI_API_KEY) {
      process.env.EMBEDDING_API_KEY = process.env.OPENAI_API_KEY
    }
    if (cfg.embeddingModel) process.env.EMBEDDING_MODEL = cfg.embeddingModel

    // Ensure index is fresh on plugin load — prevents silent recall failures
    if (fs.existsSync(memoryDir)) {
      const stats = indexStats(memoryDir)
      if (!stats) {
        try {
          reindex(memoryDir)
        } catch (err) {
          console.warn(
            'memory-kernel: reindex on init failed:',
            err instanceof Error ? err.message : String(err),
          )
        }
      }
    }

    // ── mk_remember ──────────────────────────────────────────────────────────
    api.registerTool(
      {
        name: 'mk_remember',
        label: 'Remember (structured)',
        description:
          'PRIMARY store for durable structured memory. Use for: facts, decisions, ' +
          'constraints, beliefs, open_questions, procedures, preferences, entity_summary. ' +
          'DO NOT use for: daily logs, raw pasted material, imported docs, ad-hoc transcript ' +
          'dumps — those go to memory/*.md files. Always pick the most specific type. ' +
          'Decisions must include rationale; beliefs should carry a confidence below 1.',
        parameters: RememberParams,
        async execute(_id: any, params: any) {
          try {
            const p = params as Static<typeof RememberParams>
            const atom = createAtom({
              memoryDir,
              agent_id: agentId,
              session_id: currentSessionId,
              type: p.type as AtomType,
              slug: p.slug,
              body: p.body,
              confidence: p.confidence,
              classification: p.classification as Classification | undefined,
              ttl_days: p.ttl_days,
              scope: p.scope_tags ? { tags: p.scope_tags } : undefined,
            })
            return ok(`Stored ${atom.frontmatter.type} atom: ${atom.frontmatter.id}`, {
              atomId: atom.frontmatter.id,
              type: atom.frontmatter.type,
            })
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return ok(`Error: ${msg}`)
          }
        },
      },
      { name: 'mk_remember' },
    )

    // ── mk_recall ────────────────────────────────────────────────────────────
    api.registerTool(
      {
        name: 'mk_recall',
        label: 'Recall (structured)',
        description:
          'PRIMARY recall during work. Targeted retrieval of structured memory atoms — pass ' +
          'a task string for FTS5/semantic re-ranking, or filter by type/tag. Use this before ' +
          'memory_search when looking up prior decisions, facts, constraints, or procedures. ' +
          'Use memory_search only for: exact prior-conversation wording, raw transcript ' +
          'lookups, or unstructured legacy notes. For session start / handoff prefer ' +
          'mk_context_bundle (one call = reflect + recall + assembled markdown).',
        parameters: RecallParams,
        async execute(_id: any, params: any) {
          try {
            const p = params as Static<typeof RecallParams>
            const result = await smartRecall(memoryDir, {
              task: p.task,
              types: p.types as AtomType[] | undefined,
              tags: p.tags,
              include_episodes: p.include_episodes,
              max_tokens: p.max_tokens,
            })
            const sections: string[] = []
            if (result.index) sections.push(result.index)
            if (result.constraints) sections.push(result.constraints)
            if (result.atoms?.length) {
              sections.push(
                `## Atoms (${result.atoms.length})\n` +
                  result.atoms
                    .map(
                      (a) =>
                        `- [${a.frontmatter.type}] **${a.frontmatter.id}** (conf: ${a.frontmatter.confidence})\n  ${a.body}`,
                    )
                    .join('\n'),
              )
            }
            if (result.episodes?.length) {
              sections.push(`## Episodes\n` + result.episodes.join('\n---\n'))
            }
            const text = sections.join('\n\n---\n\n') || '(no atoms found)'
            return ok(text, { atomCount: result.atoms?.length ?? 0, tokenEstimate: result.token_estimate })
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return ok(`Error: ${msg}`)
          }
        },
      },
      { name: 'mk_recall' },
    )

    // ── mk_reflect ───────────────────────────────────────────────────────────
    api.registerTool(
      {
        name: 'mk_reflect',
        label: 'Reflect (memory maintenance)',
        description:
          "Memory maintenance: expire TTL'd atoms, deduplicate, auto-promote high-confidence " +
          'beliefs to facts, surface conflicts, regenerate INDEX/HANDOFF/CONSTRAINTS/' +
          'DECISIONS/OPEN_QUESTIONS views. Typically runs automatically at session end — ' +
          'call manually after a large import or merge.',
        parameters: ReflectParams,
        async execute(_id: any, _params: any) {
          try {
            const result = reflect({ memoryDir, agent_id: agentId, session_id: currentSessionId })
            return ok(
              `reflect complete — expired: ${result.expired}, archived: ${result.archived}, ` +
                `deduped: ${result.deduped}, promoted: ${result.promoted}, conflicts: ${result.conflicts_found}`,
              { ...result },
            )
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return ok(`Error: ${msg}`)
          }
        },
      },
      { name: 'mk_reflect' },
    )

    // ── mk_context_bundle ────────────────────────────────────────────────────
    api.registerTool(
      {
        name: 'mk_context_bundle',
        label: 'Context Bundle',
        description:
          'PRIMARY startup / handoff call. Single-shot recall: reflect + recall + assembled ' +
          'markdown (INDEX + active CONSTRAINTS + HANDOFF + ranked atoms) in one call. Prefer ' +
          'this over mk_recall at session start, and over reading memory/*.md directly for ' +
          'durable context. Pass `task` to scope the recall.',
        parameters: ContextBundleParams,
        async execute(_id: any, params: any) {
          try {
            const p = params as Static<typeof ContextBundleParams>
            const result = checkpoint({
              memoryDir,
              agent_id: agentId,
              session_id: currentSessionId,
              task: p.task,
              max_tokens: p.max_tokens,
              skipReflect: p.skipReflect,
            })
            return ok(result.markdown, {
              atomCount: result.bundle.atoms?.length ?? 0,
              tokenEstimate: result.bundle.token_estimate,
            })
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return ok(`Error: ${msg}`)
          }
        },
      },
      { name: 'mk_context_bundle' },
    )

    // ── mk_status ──────────────────────────────────────────────────────────
    api.registerTool(
      {
        name: 'mk_status',
        label: 'Memory Status',
        description:
          'Memory-kernel health check: atom counts by type, index health, embedding count. ' +
          'Use to decide whether the kernel is trustworthy as the primary recall layer for ' +
          'the current session.',
        parameters: Type.Object({}),
        async execute(_id: any, _params: any) {
          try {
            const atoms = listAtoms(memoryDir)
            const stats = indexStats(memoryDir)
            const typeCounts: Record<string, number> = {}
            for (const a of atoms) {
              const t = a.frontmatter?.type ?? 'unknown'
              typeCounts[t] = (typeCounts[t] || 0) + 1
            }
            return ok(
              `**Memory Kernel** (${memoryDir})\n` +
                `Atoms: ${atoms.length}\n` +
                `Types: ${JSON.stringify(typeCounts)}\n` +
                `Index: ${stats ? `${stats.atoms} indexed, ${stats.embeddings} embeddings` : 'no index (run mk_reflect to rebuild)'}`,
            )
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return ok(`Error: ${msg}`)
          }
        },
      },
      { name: 'mk_status' },
    )

    // ── Lifecycle hooks ─────────────────────────────────────────────────────

    // Bootstrap: inject recall context into agent startup
    api.registerHook(
      ['agent:bootstrap'],
      async (event: any) => {
        setSession(event.sessionKey)
        if (!fs.existsSync(memoryDir)) {
          event.messages?.push('mk: no memory dir — file-first fallback')
          return
        }
        try {
          const bundle = await smartRecall(memoryDir, {
            agent_id: agentId,
            session_id: event.sessionKey || 'bootstrap',
            max_tokens: 4000,
          })
          const count = bundle.atoms?.length ?? 0
          if (!count) {
            event.messages?.push('mk: bootstrap — no atoms yet')
            return
          }
          const context = formatBundle(bundle)
          if (event.context?.bootstrapFiles) {
            event.context.bootstrapFiles.push({
              path: 'memory-kernel-context.md',
              content: context,
            })
          }
          event.messages?.push(`mk: bootstrap injected ${count} atoms`)
        } catch (err) {
          // Don't block bootstrap on failure, but surface a signal so the host
          // doctrine can fall back to memory_search / file layer instead of
          // silently believing the kernel had no content.
          const msg = err instanceof Error ? err.message : String(err)
          event.messages?.push(`mk: bootstrap failed — ${msg}`)
        }
      },
      {
        name: 'mk_bootstrap_recall',
        description: 'Inject recalled memory atoms into agent bootstrap context',
      },
    )

    // Pre-compaction: checkpoint before context loss
    api.registerHook(
      ['session:compact:before'],
      async (event: any) => {
        setSession(event.sessionKey)
        try {
          const result = checkpoint({
            memoryDir,
            agent_id: agentId,
            session_id: event.sessionKey || 'unknown',
            task: 'pre-compaction save',
          })
          const atoms = result.bundle?.atoms?.length ?? 0
          const tokens = result.bundle?.token_estimate ?? 0
          // Signals the host compaction prompt that durable structured content
          // is already captured — it can route scratch/transient content to
          // memory/*.md without re-dumping things the kernel already holds.
          event.messages?.push(
            `mk: pre-compact checkpoint saved (${atoms} atoms, ~${tokens} tokens)`,
          )
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          event.messages?.push(`mk: pre-compact checkpoint failed — ${msg}`)
        }
      },
      {
        name: 'mk_precompact_checkpoint',
        description: 'Save a memory checkpoint before session compaction',
      },
    )

    // Session end: reflect + write episode
    api.registerHook(
      ['command:new', 'command:reset'],
      async (event: any) => {
        setSession(event.sessionKey)
        try {
          reflect({
            memoryDir,
            agent_id: agentId,
            session_id: event.sessionKey || 'unknown',
          })

          const sessionId = event.context?.sessionEntry?.id
          if (sessionId) {
            writeEpisode(memoryDir, sessionId, `Session ended via /${event.action} command`, {
              agent_id: agentId,
            })
          }

          event.messages?.push('mk: reflect complete')
        } catch {
          // fail silent
        }
      },
      {
        name: 'mk_session_end',
        description: 'Run reflect and write session episode on /new or /reset',
      },
    )
  },
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatBundle(bundle: ContextBundle): string {
  const parts: string[] = ['# Memory Kernel Context']
  if (bundle.constraints) parts.push(`## Active Constraints\n${bundle.constraints}`)
  if (bundle.handoff) parts.push(`## Recent Context\n${bundle.handoff}`)
  if (bundle.atoms?.length) {
    parts.push(`## Relevant Memories (${bundle.atoms.length})`)
    for (const a of bundle.atoms) {
      parts.push(`### ${a.frontmatter.id} (${a.frontmatter.type}, confidence: ${a.frontmatter.confidence})\n${a.body}`)
    }
  }
  return parts.join('\n\n')
}

export default memoryKernelPlugin
