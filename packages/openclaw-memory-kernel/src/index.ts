import fs from 'fs'
import os from 'os'
import path from 'path'
import { Type, type Static } from '@sinclair/typebox'
import {
  createAtom, recall, recallWithEmbeddings, reflect, checkpoint,
  writeEpisode, listAtoms, indexStats, reindex,
  ATOM_TYPES,
  // Per-agent isolation
  resolveAgentDir, isIsolated, loadConfig, initAgentStore,
  assertValidAgentId,
  recallIsolatedWithEmbeddings,
} from 'memory-kernel'
import type { AtomType, Classification, ContextBundle, IsolationConfig, RecallQuery } from 'memory-kernel'
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

// SecretRef input shape. Only `file` source is supported — `env` is redundant
// (use a plain string), `exec` would add process-spawn surface we don't need.
//
// The `id` field is a slash-delimited path through nested plain-object JSON keys.
// Supported: `/key`, `/a/b/c`. Not supported: array indices, RFC 6901 escape
// sequences (`~0`, `~1`), or the whole-document pointer (`""`). This is a
// deliberate subset of RFC 6901 chosen for simplicity.
//
// This plugin-local SecretRef mechanism is a short-term workaround: OpenClaw's
// central `secrets configure` flow does not cover third-party plugin config
// fields (see https://docs.openclaw.ai/reference/secretref-credential-surface).
// The long-term fix is an OpenClaw upstream change that adds memory-kernel
// fields to that hardcoded list; at that point this resolver can be removed.
type FileSecretRef = {
  source: 'file'
  provider: string
  id: string
}
type SecretValue = string | FileSecretRef
type SecretProviderEntry = { source: 'file'; path: string }

type PluginIsolationMode = 'auto' | 'shared-only' | 'per-agent-required'

// Resolved config — what register() consumes. `secretProviders` is input-only
// and is never exposed here; all refs are materialized into strings.
type PluginConfig = {
  memoryDir: string
  encryptionKey?: string
  agentId?: string
  embeddingProvider?: string
  embeddingApiKey?: string
  embeddingModel?: string
  // Per-agent isolation
  isolationMode?: PluginIsolationMode
  autoInitAgentStore?: boolean
  sharedRecall?: boolean
  /** @deprecated Throwing is now the default. Use `allowSharedFallback: true` to opt-in to the old silent fallback. */
  failIfMissingAgentStore?: boolean
  /** Opt-in to silent shared-mode fallback when agent store is missing. Default: false (errors instead). */
  allowSharedFallback?: boolean
}

/**
 * Resolved memory context for a single session.
 *
 * Resolved once in the agent:bootstrap hook via resolveEffectiveMemoryContext()
 * and cached in `sessionContexts` (keyed by sessionKey). All tool execute() calls
 * and subsequent hooks for that session read from the cache via getContext().
 * On cache miss (tool called before bootstrap, or after session-end cleanup),
 * getContext() resolves a fresh context using static config only (no runtime agentId).
 */
interface EffectiveMemoryContext {
  /** Base memory directory (the configured memoryDir). */
  baseDir: string
  /** Working directory: baseDir in shared mode, agents/{id}/ in isolated. */
  effectiveDir: string
  /** Resolved agent identity. */
  agentId: string
  /** Whether per-agent isolation is active. */
  isolated: boolean
  /** Whether recall should include shared namespace atoms. */
  sharedRecall: boolean
}

function isFileSecretRef(value: unknown): value is FileSecretRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as any).source === 'file' &&
    typeof (value as any).provider === 'string' &&
    typeof (value as any).id === 'string'
  )
}

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : path.resolve(p)
}

function resolveFileRef(
  fieldName: string,
  ref: FileSecretRef,
  providers: Record<string, SecretProviderEntry>,
): string {
  const provider = providers[ref.provider]
  if (!provider || provider.source !== 'file' || typeof provider.path !== 'string') {
    throw new Error(
      `memory-kernel: ${fieldName} references provider "${ref.provider}" but ` +
        `secretProviders has no matching { source: "file", path: "..." } entry`,
    )
  }

  // assertWithinDir() is intentionally NOT applied here: secrets files
  // legitimately live anywhere on the filesystem (e.g. ~/.openclaw/secrets.json),
  // not just inside memoryDir. The path comes from the local openclaw.json config
  // file which already has the same trust level as filesystem access.
  const absPath = expandHome(provider.path)

  // TOCTOU note: stat() and readFileSync() are not atomic. The permission
  // check is advisory (warn-not-fail) — do not treat it as a security gate.
  let stat: fs.Stats
  try {
    stat = fs.statSync(absPath)
  } catch {
    throw new Error(`memory-kernel: ${fieldName} — secrets file not found at ${absPath}`)
  }

  // Warn (not fail) on group/world-readable mode. Fine for containerized or
  // automation setups that manage perms differently; alert interactive users.
  const mode = stat.mode & 0o777
  if ((mode & 0o077) !== 0) {
    console.warn(
      `memory-kernel: ${absPath} has mode ${mode.toString(8)} (group/world readable). ` +
        `Consider 'chmod 600' for secrets files.`,
    )
  }

  if (!ref.id.startsWith('/') || ref.id.length < 2) {
    throw new Error(
      `memory-kernel: ${fieldName} pointer "${ref.id}" must be a non-empty path starting with "/"`,
    )
  }
  if (ref.id.includes('~')) {
    throw new Error(
      `memory-kernel: ${fieldName} pointer "${ref.id}" uses RFC 6901 escapes — ` +
        `not supported by this plugin; use plain object keys`,
    )
  }

  let raw: string
  try {
    raw = fs.readFileSync(absPath, 'utf8')
  } catch (err) {
    throw new Error(
      `memory-kernel: ${fieldName} — failed to read ${absPath}: ${(err as Error).message}`,
    )
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error(`memory-kernel: ${fieldName} — ${absPath} is not valid JSON`)
  }

  const segments = ref.id.slice(1).split('/')
  let cursor: unknown = json
  for (const seg of segments) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) {
      throw new Error(
        `memory-kernel: ${fieldName} pointer "${ref.id}" — cannot navigate into ` +
          `non-object at segment "${seg}" (arrays not supported)`,
      )
    }
    const obj = cursor as Record<string, unknown>
    if (!(seg in obj)) {
      throw new Error(
        `memory-kernel: ${fieldName} pointer "${ref.id}" — segment "${seg}" not found`,
      )
    }
    cursor = obj[seg]
  }
  if (typeof cursor !== 'string') {
    throw new Error(
      `memory-kernel: ${fieldName} pointer "${ref.id}" — resolved value is not a string`,
    )
  }
  return cursor
}

// Validates all provider entries eagerly at init, even if no SecretRef field
// references them. This is intentional: catch config typos at plugin registration
// time rather than silently ignoring malformed entries until first use.
function parseSecretProviders(raw: unknown): Record<string, SecretProviderEntry> {
  if (raw == null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('memory-kernel: secretProviders must be an object')
  }
  const out: Record<string, SecretProviderEntry> = {}
  for (const [alias, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      (entry as any).source !== 'file' ||
      typeof (entry as any).path !== 'string'
    ) {
      throw new Error(
        `memory-kernel: secretProviders["${alias}"] must be { source: "file", path: string }`,
      )
    }
    out[alias] = { source: 'file', path: (entry as any).path }
  }
  return out
}

const pluginConfigSchema = {
  parse(value: unknown): PluginConfig {
    const cfg = (value ?? {}) as Record<string, unknown>
    const providers = parseSecretProviders(cfg['secretProviders'])

    const resolveIfRef = (fieldName: string, input: unknown): string | undefined => {
      if (input == null) return undefined
      if (typeof input === 'string') return input
      if (isFileSecretRef(input)) return resolveFileRef(fieldName, input, providers)
      throw new Error(
        `memory-kernel: ${fieldName} must be a string or a { source, provider, id } SecretRef`,
      )
    }

    const memoryDir = typeof cfg['memoryDir'] === 'string' ? cfg['memoryDir'] : undefined
    if (!memoryDir && !process.env.MEMORY_DIR) {
      throw new Error(
        'memory-kernel: memoryDir is required. ' +
          'Set it in openclaw.json plugin config or export MEMORY_DIR.',
      )
    }

    const rawIsolationMode = cfg['isolationMode']
    const isolationMode: PluginIsolationMode | undefined =
      rawIsolationMode === 'auto' || rawIsolationMode === 'shared-only' || rawIsolationMode === 'per-agent-required'
        ? rawIsolationMode
        : undefined

    return {
      memoryDir: path.resolve(memoryDir ?? process.env.MEMORY_DIR!),
      encryptionKey: resolveIfRef('encryptionKey', cfg['encryptionKey']),
      agentId: typeof cfg['agentId'] === 'string' ? cfg['agentId'] : undefined,
      embeddingProvider:
        typeof cfg['embeddingProvider'] === 'string' ? cfg['embeddingProvider'] : undefined,
      embeddingApiKey: resolveIfRef('embeddingApiKey', cfg['embeddingApiKey']),
      embeddingModel:
        typeof cfg['embeddingModel'] === 'string' ? cfg['embeddingModel'] : undefined,
      // Per-agent isolation
      isolationMode,
      autoInitAgentStore: cfg['autoInitAgentStore'] === true,
      sharedRecall: cfg['sharedRecall'] !== false, // default: true
      failIfMissingAgentStore: cfg['failIfMissingAgentStore'] === true,
      // Backward compat: explicit failIfMissingAgentStore: false implies allowSharedFallback
      // (someone who explicitly opted out of throwing keeps the old fallback behavior).
      allowSharedFallback:
        cfg['allowSharedFallback'] === true ||
        (cfg['failIfMissingAgentStore'] === false && cfg['allowSharedFallback'] === undefined),
    }
  },
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      memoryDir: { type: 'string', description: 'Absolute path to the memory-kernel directory' },
      encryptionKey: {
        oneOf: [
          { type: 'string', description: 'AES-256-GCM key for SECRET atom encryption (literal)' },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              source: { type: 'string', enum: ['file'] },
              provider: { type: 'string', minLength: 1 },
              id: {
                type: 'string',
                pattern: '^/.+',
                description:
                  'JSON pointer (slash-delimited object keys; arrays and RFC 6901 escapes not supported)',
              },
            },
            required: ['source', 'provider', 'id'],
          },
        ],
        description:
          'AES-256-GCM key for SECRET atom encryption. Accepts a string or a file SecretRef.',
      },
      agentId: { type: 'string', description: 'Agent label written to the audit trail' },
      embeddingProvider: {
        type: 'string',
        description: 'Embedding provider (e.g. "openai"). Enables semantic recall.',
      },
      embeddingApiKey: {
        oneOf: [
          { type: 'string', description: 'API key for embedding provider (literal)' },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              source: { type: 'string', enum: ['file'] },
              provider: { type: 'string', minLength: 1 },
              id: {
                type: 'string',
                pattern: '^/.+',
                description:
                  'JSON pointer (slash-delimited object keys; arrays and RFC 6901 escapes not supported)',
              },
            },
            required: ['source', 'provider', 'id'],
          },
        ],
        description:
          'API key for embedding provider. Accepts a string or a file SecretRef. Falls back to OPENAI_API_KEY env when provider is openai and this is unset.',
      },
      embeddingModel: {
        type: 'string',
        description: 'Embedding model ID (e.g. "text-embedding-3-small"). Provider default if omitted.',
      },
      secretProviders: {
        type: 'object',
        description:
          'Map of alias → file provider used to resolve SecretRefs for encryptionKey/embeddingApiKey. Plugin-local; does not interact with OpenClaw core SecretRef resolution.',
        additionalProperties: {
          type: 'object',
          additionalProperties: false,
          properties: {
            source: { type: 'string', enum: ['file'] },
            path: { type: 'string', minLength: 1, description: 'Absolute path (or ~-prefixed) to a JSON file' },
          },
          required: ['source', 'path'],
        },
      },
      isolationMode: {
        type: 'string',
        enum: ['auto', 'shared-only', 'per-agent-required'],
        description:
          'Per-agent isolation mode. "auto" reads config.yaml (default), ' +
          '"shared-only" forces flat mode, "per-agent-required" fails if not isolated.',
      },
      autoInitAgentStore: {
        type: 'boolean',
        description: 'Auto-create agent store on first use if missing. Default: false.',
      },
      sharedRecall: {
        type: 'boolean',
        description: 'Include shared namespace atoms in isolated recall. Default: true.',
      },
      failIfMissingAgentStore: {
        type: 'boolean',
        description:
          'Deprecated — throwing is now the default behavior when agent store is missing. ' +
          'Retained for backward compatibility. Setting to false maps to allowSharedFallback: true.',
      },
      allowSharedFallback: {
        type: 'boolean',
        description:
          'Allow silent fallback to shared mode when agent store is missing in isolated mode. ' +
          'Default: false (errors instead). Use only during migration or development.',
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
      help:
        '64-char hex key or passphrase for encrypting SECRET atoms. Optional. ' +
        'May also be a file SecretRef like { source: "file", provider: "vault", id: "/memory-kernel-encryption-key" } — see INSTALL.md.',
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
      help:
        'API key for embeddings. Falls back to OPENAI_API_KEY env if provider is openai. ' +
        'May also be a file SecretRef like { source: "file", provider: "vault", id: "/openai-api-key" } — see INSTALL.md.',
    },
    embeddingModel: {
      label: 'Embedding model',
      placeholder: 'text-embedding-3-small',
      help: 'Optional. Provider-specific default if omitted.',
    },
    isolationMode: {
      label: 'Isolation mode',
      placeholder: 'auto',
      help:
        'Per-agent isolation: "auto" reads config.yaml (default), "shared-only" forces flat mode, ' +
        '"per-agent-required" fails if not isolated.',
    },
    autoInitAgentStore: {
      label: 'Auto-init agent store',
      help: 'Automatically create agent store if missing. Default: false (errors instead).',
    },
    sharedRecall: {
      label: 'Include shared recall',
      help: 'Include shared namespace atoms in isolated recall. Default: true.',
    },
    failIfMissingAgentStore: {
      label: 'Fail if agent store missing',
      help: 'Deprecated — throwing is now the default. Setting to false maps to allowSharedFallback.',
    },
    allowSharedFallback: {
      label: 'Allow shared fallback',
      help: 'Allow silent fallback to shared mode when agent store is missing. Default: false (errors instead). Use only during migration.',
    },
  },
}

function ok(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text }], ...(details ? { details } : {}) }
}

/**
 * Resolve the effective memory context for a given agent identity.
 *
 * Called from every tool execute() and lifecycle hook, NOT once at register().
 * May trigger side effects: calls initAgentStore() when autoInitAgentStore is
 * true and the agent directory doesn't exist yet.
 *
 * @param cfg           - Parsed plugin config (immutable after register())
 * @param runtimeAgentId - Agent ID resolved at point-of-use (may differ per call)
 */
function resolveEffectiveMemoryContext(
  cfg: PluginConfig,
  runtimeAgentId?: string,
): EffectiveMemoryContext {
  const baseDir = cfg.memoryDir
  const isolationMode = cfg.isolationMode ?? 'auto'
  const sharedRecall = cfg.sharedRecall ?? true

  // Step 1: Resolve agent identity — runtime overrides static config.
  const agentId = runtimeAgentId ?? cfg.agentId ?? 'openclaw'

  // Validate before any filesystem operations — prevents path-traversal attacks
  // even if the bootstrap hook's validation was bypassed or a tool passes an
  // agent_id directly.
  assertValidAgentId(agentId)

  // Step 2: Determine effective isolation mode
  let isolated: boolean
  if (isolationMode === 'shared-only') {
    isolated = false
  } else if (isolationMode === 'per-agent-required') {
    if (!fs.existsSync(baseDir)) {
      throw new Error(
        `memory-kernel: isolationMode is "per-agent-required" but memoryDir ` +
          `does not exist at ${baseDir}. Run: mk init ${baseDir}`,
      )
    }
    const diskConfig = loadConfig(baseDir)
    if (diskConfig.isolation !== 'per-agent') {
      throw new Error(
        `memory-kernel: isolationMode is "per-agent-required" but ${baseDir}/config.yaml ` +
          `has isolation="${diskConfig.isolation}". Run: mk init -a ${agentId} ${baseDir}`,
      )
    }
    isolated = true
  } else {
    // 'auto': respect whatever config.yaml / MK_ISOLATION says
    isolated = fs.existsSync(baseDir) ? isIsolated(baseDir) : false
  }

  // Step 3: Resolve effective directory
  let effectiveDir: string
  if (!isolated) {
    effectiveDir = baseDir
  } else {
    effectiveDir = resolveAgentDir(baseDir, agentId, { isolation: 'per-agent' })

    // Step 4: Handle missing agent store
    if (!fs.existsSync(effectiveDir)) {
      if (cfg.autoInitAgentStore) {
        initAgentStore(baseDir, agentId)
      } else if (cfg.allowSharedFallback) {
        // Explicitly opted in to dangerous fallback — warn but continue.
        // Use only during migration or development; in production this risks
        // contaminating shared memory with agent-specific writes.
        console.warn(
          `memory-kernel: agent store for "${agentId}" not found at ${effectiveDir}. ` +
            `Falling back to shared mode (allowSharedFallback: true). ` +
            `Run: mk init -a ${agentId} ${baseDir}`,
        )
        effectiveDir = baseDir
        isolated = false
      } else {
        // Default: fail with actionable error to prevent silent memory contamination
        throw new Error(
          `memory-kernel: agent store for "${agentId}" does not exist at ${effectiveDir}. ` +
            `Run: mk init -a ${agentId} ${baseDir}` +
            ' (or set autoInitAgentStore: true in plugin config)',
        )
      }
    }
  }

  return { baseDir, effectiveDir, agentId, isolated, sharedRecall }
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

    // Track the current session id for audit-trail propagation into tool calls.
    // Updated by lifecycle hooks (agent:bootstrap, command:*, session:compact:before).
    // Tools read this instead of hardcoding 'unknown', restoring a meaningful audit trail.
    let currentSessionId = 'unknown'
    const setSession = (s: unknown) => {
      if (typeof s === 'string' && s.length > 0) currentSessionId = s
    }

    // Per-session resolved memory context, cached at bootstrap time.
    // Keyed by sessionKey. Eliminates per-call filesystem I/O and ensures
    // concurrent sessions never clobber each other's routing.
    const sessionContexts = new Map<string, EffectiveMemoryContext>()

    // The session key for the most recently bootstrapped session.
    // Used as fallback for tool execute() calls which don't receive sessionKey.
    // Under concurrent sessions this is a last-writer-wins race, but tool calls
    // are always serialized within a session — the race only matters if sessions
    // interleave tool calls, which OpenClaw does not currently do.
    let activeSessionKey = '__default__'

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

    // Resolve memory context for a session. Bootstrap caches the result;
    // subsequent calls within the same session return the cached value.
    // When sessionKey is omitted (tool execute() calls), uses activeSessionKey.
    function getContext(sessionKey?: string): EffectiveMemoryContext {
      const key = sessionKey ?? activeSessionKey
      const cached = sessionContexts.get(key)
      if (cached) return cached
      // First call for this session (or pre-bootstrap tools) — resolve and cache.
      const ctx = resolveEffectiveMemoryContext(cfg)
      sessionContexts.set(key, ctx)
      return ctx
    }

    // Ensure index is fresh on plugin load — prevents silent recall failures.
    // Use static config identity for the one-time init check.
    const initCtx = resolveEffectiveMemoryContext(cfg)
    if (fs.existsSync(initCtx.effectiveDir)) {
      const stats = indexStats(initCtx.effectiveDir)
      if (!stats) {
        try {
          reindex(initCtx.effectiveDir)
        } catch (err) {
          console.warn(
            'memory-kernel: reindex on init failed:',
            err instanceof Error ? err.message : String(err),
          )
        }
      }
    }
    // In isolated mode with sharedRecall, also ensure shared index is fresh.
    if (initCtx.isolated && initCtx.sharedRecall) {
      const sharedDir = path.join(initCtx.baseDir, 'shared')
      if (fs.existsSync(sharedDir)) {
        const stats = indexStats(sharedDir)
        if (!stats) {
          try {
            reindex(sharedDir)
          } catch (err) {
            console.warn(
              'memory-kernel: reindex shared on init failed:',
              err instanceof Error ? err.message : String(err),
            )
          }
        }
      }
    }

    // Use embedding-backed recall when both provider and key are available,
    // otherwise fall back to structured FTS5 recall. Isolation-aware.
    async function smartRecall(mctx: EffectiveMemoryContext, query: RecallQuery): Promise<ContextBundle> {
      const useEmbeddings = !!(process.env.EMBEDDING_PROVIDER && process.env.EMBEDDING_API_KEY)

      if (mctx.isolated && mctx.sharedRecall) {
        return recallIsolatedWithEmbeddings(mctx.effectiveDir, mctx.baseDir, query, {
          useEmbeddings,
        })
      }

      // Shared mode or isolated-without-shared: direct recall on effectiveDir
      if (useEmbeddings) {
        return recallWithEmbeddings(mctx.effectiveDir, query)
      }
      return recall(mctx.effectiveDir, query)
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
            const mctx = getContext()
            const atom = createAtom({
              memoryDir: mctx.effectiveDir,
              agent_id: mctx.agentId,
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
            const mctx = getContext()
            const result = await smartRecall(mctx, {
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
            const mctx = getContext()
            const result = reflect({ memoryDir: mctx.effectiveDir, agent_id: mctx.agentId, session_id: currentSessionId })
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
            const mctx = getContext()
            const result = checkpoint({
              memoryDir: mctx.effectiveDir,
              agent_id: mctx.agentId,
              session_id: currentSessionId,
              task: p.task,
              max_tokens: p.max_tokens,
              skipReflect: p.skipReflect,
              // Isolation-aware recall: merge agent + shared atoms
              baseDir: mctx.baseDir,
              isolated: mctx.isolated,
              sharedRecall: mctx.sharedRecall,
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
            const mctx = getContext()
            const atoms = listAtoms(mctx.effectiveDir)
            const stats = indexStats(mctx.effectiveDir)
            const typeCounts: Record<string, number> = {}
            for (const a of atoms) {
              const t = a.frontmatter?.type ?? 'unknown'
              typeCounts[t] = (typeCounts[t] || 0) + 1
            }

            const lines = [
              `**Memory Kernel** (${mctx.effectiveDir})`,
              mctx.isolated
                ? `Isolation: per-agent (agent: ${mctx.agentId})`
                : 'Isolation: shared',
            ]

            if (mctx.isolated) {
              lines.push(`Base dir: ${mctx.baseDir}`)
              const sharedDir = path.join(mctx.baseDir, 'shared')
              const sharedExists = fs.existsSync(sharedDir)
              lines.push(`Shared namespace: ${sharedExists ? 'exists' : 'missing'}`)
              if (sharedExists) {
                try {
                  const sharedAtoms = listAtoms(sharedDir)
                  lines.push(`Shared atoms: ${sharedAtoms.length}`)
                } catch {
                  lines.push('Shared atoms: (read error)')
                }
              }
              lines.push(`Shared recall: ${mctx.sharedRecall ? 'enabled' : 'disabled'}`)
            }

            lines.push(
              `Atoms: ${atoms.length}`,
              `Types: ${JSON.stringify(typeCounts)}`,
              `Index: ${stats ? `${stats.atoms} indexed, ${stats.embeddings} embeddings` : 'no index (run mk_reflect to rebuild)'}`,
            )
            return ok(lines.join('\n'))
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
        const sessionKey = event.sessionKey || '__default__'
        setSession(sessionKey)

        // A new bootstrap implies the prior session ended without command:new/reset.
        // Delete its cached context to prevent unbounded Map growth.
        if (activeSessionKey !== sessionKey) {
          sessionContexts.delete(activeSessionKey)
        }
        activeSessionKey = sessionKey

        // Runtime agent identity: capture from OpenClaw event context.
        // OpenClaw provides agent identity via context.agentId (documented),
        // context.agentIdentity.id, or context.agent.id (alternate paths).
        const runtimeAgentId = event.context?.agentId              // OpenClaw documented path
          ?? event.context?.agentIdentity?.id                      // structured identity object
          ?? event.context?.agent?.id                              // alternate nested path
        let agentId: string | undefined
        if (typeof runtimeAgentId === 'string' && runtimeAgentId.length > 0) {
          assertValidAgentId(runtimeAgentId)
          agentId = runtimeAgentId
        }

        // Resolve and cache the memory context for this session.
        // Done once here — all subsequent tool calls and hooks use the cache.
        const mctx = resolveEffectiveMemoryContext(cfg, agentId)
        sessionContexts.set(sessionKey, mctx)

        if (!fs.existsSync(mctx.effectiveDir)) {
          event.messages?.push('mk: no memory dir — file-first fallback')
          return
        }
        try {
          const bundle = await smartRecall(mctx, {
            agent_id: mctx.agentId,
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
            // Idempotent replace-or-append: OpenClaw core caches the
            // bootstrap files array by sessionKey and hands the same
            // reference to every invocation, so an unconditional push
            // would accumulate duplicates across runs.
            const files = event.context.bootstrapFiles
            const next = { path: 'memory-kernel-context.md', content: context }
            const idx = files.findIndex(
              (f: { path?: string }) => f?.path === next.path,
            )
            if (idx >= 0) files[idx] = next
            else files.push(next)
          }
          const bootstrapMsg = mctx.isolated
            ? `mk: bootstrap agent=${mctx.agentId} isolated=true shared=${mctx.sharedRecall} atoms=${count}`
            : `mk: bootstrap injected ${count} atoms`
          event.messages?.push(bootstrapMsg)
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
        const mctx = getContext(event.sessionKey)
        try {
          const result = checkpoint({
            memoryDir: mctx.effectiveDir,
            agent_id: mctx.agentId,
            session_id: event.sessionKey || 'unknown',
            task: 'pre-compaction save',
            // Isolation-aware recall: merge agent + shared atoms
            baseDir: mctx.baseDir,
            isolated: mctx.isolated,
            sharedRecall: mctx.sharedRecall,
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
        const mctx = getContext(event.sessionKey)
        try {
          reflect({
            memoryDir: mctx.effectiveDir,
            agent_id: mctx.agentId,
            session_id: event.sessionKey || 'unknown',
          })

          const sessionId = event.context?.sessionEntry?.id
          if (sessionId) {
            writeEpisode(mctx.effectiveDir, sessionId, `Session ended via /${event.action} command`, {
              agent_id: mctx.agentId,
            })
          }

          event.messages?.push('mk: reflect complete')
        } catch {
          // fail silent
        } finally {
          // Clean up per-session state to prevent unbounded Map growth
          const key = event.sessionKey || '__default__'
          sessionContexts.delete(key)
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
