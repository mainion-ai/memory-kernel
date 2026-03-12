import path from 'path'
import { Type, type Static } from '@sinclair/typebox'
import { createAtom, recall, reflect, checkpoint, ATOM_TYPES } from 'memory-kernel'
import type { AtomType, Classification } from 'memory-kernel'
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core'

// ── Config schema ─────────────────────────────────────────────────────────────

type PluginConfig = {
  memoryDir: string
  encryptionKey?: string
  agentId?: string
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
    }
  },
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      memoryDir: { type: 'string', description: 'Absolute path to the memory-kernel directory' },
      encryptionKey: { type: 'string', description: 'AES-256-GCM key for SECRET atom encryption' },
      agentId: { type: 'string', description: 'Agent label written to the audit trail' },
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
  },
}

function ok(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text }], ...(details ? { details } : {}) }
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const AtomTypeEnum = Type.Union(ATOM_TYPES.map((t) => Type.Literal(t)))

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
    Type.Array(AtomTypeEnum, { description: 'Filter by atom type (e.g. ["decision","constraint"])' }),
  ),
  tags: Type.Optional(Type.Array(Type.String(), { description: 'Filter by scope tags' })),
  include_episodes: Type.Optional(Type.Boolean({ description: 'Include session episode summaries' })),
  max_tokens: Type.Optional(Type.Number({ description: 'Token budget. Default: 4000' })),
})

const ReflectParams = Type.Object({})

const ContextBundleParams = Type.Object({
  task: Type.Optional(Type.String({ description: 'Task description — scopes the recall' })),
  max_tokens: Type.Optional(Type.Number({ description: 'Token budget. Default: 4000' })),
  skip_reflect: Type.Optional(Type.Boolean({ description: 'Skip reflect if just ran. Default: false' })),
})

// ── Plugin ────────────────────────────────────────────────────────────────────

const memoryKernelPlugin = {
  id: 'memory-kernel',
  name: 'Memory (memory-kernel)',
  description:
    'Structured typed memory with event-log replay, confidence scoring, and conflict detection. ' +
    'Use for facts, decisions, constraints, beliefs, and open questions.',
  kind: 'memory',
  configSchema: pluginConfigSchema,

  register(api: OpenClawPluginApi) {
    const cfg = pluginConfigSchema.parse(api.pluginConfig)
    const { memoryDir } = cfg

    // Expose encryption key to memory-kernel (reads from process.env at call time)
    if (cfg.encryptionKey) process.env.MEMORY_ENCRYPTION_KEY = cfg.encryptionKey

    // ── mk_remember ──────────────────────────────────────────────────────────
    api.registerTool(
      {
        name: 'mk_remember',
        label: 'Remember (structured)',
        description:
          'Store a typed memory atom. Use instead of free-form notes when information has a ' +
          'clear type: fact (observed info), decision (choice + rationale), constraint ' +
          '(rule that must not be violated), belief (uncertain — confidence < 1), ' +
          'open_question (unresolved). Always pick the most specific type.',
        parameters: RememberParams,
        async execute(_id, params) {
          const p = params as Static<typeof RememberParams>
          const atom = await createAtom({
            memoryDir,
            type: p.type as AtomType,
            slug: p.slug,
            body: p.body,
            confidence: p.confidence,
            classification: p.classification as Classification | undefined,
            ttl_days: p.ttl_days,
            scope_tags: p.scope_tags,
          })
          return ok(`Stored ${atom.type} atom: ${atom.id}`, { atomId: atom.id, type: atom.type })
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
          'Retrieve structured memory atoms. Prefer over memory_search when you need typed ' +
          'filtering (e.g. active constraints and decisions), FTS5 keyword precision, or ' +
          'confidence-ranked results for a specific task. Use memory_search for fuzzy ' +
          'semantic recall over unstructured notes.',
        parameters: RecallParams,
        async execute(_id, params) {
          const p = params as Static<typeof RecallParams>
          const result = await recall(memoryDir, {
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
                  .map((a) => `- [${a.type}] **${a.id}** (conf: ${a.confidence})\n  ${a.body}`)
                  .join('\n'),
            )
          }
          if (result.episodes?.length) {
            sections.push(`## Episodes\n` + result.episodes.map((e) => e.body ?? e.id).join('\n---\n'))
          }
          const text = sections.join('\n\n---\n\n') || '(no atoms found)'
          return ok(text, { atomCount: result.atoms?.length ?? 0, tokenEstimate: result.token_estimate })
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
          "Run memory maintenance: expire TTL'd atoms, deduplicate, auto-promote " +
          'high-confidence beliefs to facts, surface conflicts, regenerate all views. ' +
          'Call at end of session or after a merge.',
        parameters: ReflectParams,
        async execute(_id, _params) {
          const result = await reflect({ memoryDir })
          return ok(
            `reflect complete — expired: ${result.expired}, archived: ${result.archived}, ` +
              `deduped: ${result.deduped}, promoted: ${result.promoted}, conflicts: ${result.conflicts_found}`,
            result as unknown as Record<string, unknown>,
          )
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
          'Pre-assembled Markdown context (reflect + recall in one call). ' +
          'Best for session start or handoff — one call instead of separate reflect + recall.',
        parameters: ContextBundleParams,
        async execute(_id, params) {
          const p = params as Static<typeof ContextBundleParams>
          const result = await checkpoint({
            memoryDir,
            task: p.task,
            max_tokens: p.max_tokens,
            skip_reflect: p.skip_reflect,
          })
          return ok(result.markdown, {
            atomCount: result.atom_count,
            tokenEstimate: result.token_estimate,
          })
        },
      },
      { name: 'mk_context_bundle' },
    )
  },
}

export default memoryKernelPlugin
