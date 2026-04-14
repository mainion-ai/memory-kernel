# Installing openclaw-memory-kernel

## 1. Build the plugin

```bash
cd packages/openclaw-memory-kernel
npm install
npm run build
```

This produces `dist/index.js`, which is the file OpenClaw loads.

## 2. Initialise a memory directory

```bash
npm install -g memory-kernel   # if not already installed
mk init ~/.openclaw/mk-memory
```

You only do this once. The directory holds the NDJSON event log, atom files, and SQLite index.

## 3. Add to `~/.openclaw/openclaw.json`

### Minimal (no encryption)

```json
{
  "plugins": {
    "load": {
      "paths": ["/absolute/path/to/packages/openclaw-memory-kernel"]
    },
    "entries": {
      "memory-kernel": {
        "enabled": true,
        "config": {
          "memoryDir": "/Users/YOU/.openclaw/mk-memory"
        }
      }
    }
  }
}
```

### With encryption for SECRET atoms

SECRET-classified atoms are encrypted at rest with AES-256-GCM. To enable this, provide a key.

**Option A — env var reference (recommended)**

```json
{
  "plugins": {
    "load": {
      "paths": ["/absolute/path/to/packages/openclaw-memory-kernel"]
    },
    "entries": {
      "memory-kernel": {
        "enabled": true,
        "config": {
          "memoryDir": "/Users/YOU/.openclaw/mk-memory",
          "encryptionKey": "${MEMORY_ENCRYPTION_KEY}"
        }
      }
    }
  }
}
```

Then export the key before starting OpenClaw:

```bash
# Generate a key (do this once, store it safely)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Add to your shell profile (~/.zshrc or ~/.bashrc)
export MEMORY_ENCRYPTION_KEY="<your-64-char-hex-key>"
```

**Option B — 1Password / exec secret**

```json
"encryptionKey": {
  "source": "exec",
  "provider": "default",
  "id": "op read op://Personal/memory-kernel/encryptionKey"
}
```

**Option C — passphrase (shorter, PBKDF2-derived)**

```json
"encryptionKey": "${MEMORY_ENCRYPTION_KEY}"
```

A passphrase shorter than 64 hex chars is automatically stretched via PBKDF2. Convenient but slightly slower on first use.

> **Key safety**: without the key, SECRET atoms appear as unreadable `MKENC:v1:...` blobs.
> PUBLIC, TEAM, and PERSONAL atoms are never encrypted regardless of key.

## 4. Restart OpenClaw

```bash
# if running as a background service
openclaw restart

# or just quit and reopen the app
```

## 5. Verify

In any OpenClaw session:

```
/context detail
```

You should see `mk_remember`, `mk_recall`, `mk_reflect`, `mk_context_bundle`, and `mk_status` listed under active tools.

You can also verify the plugin from the CLI:

```bash
openclaw plugins inspect memory-kernel
```

Look for `Status: loaded`, five entries under **Tools**, and three named entries under **Custom hooks** (`mk_bootstrap_recall`, `mk_precompact_checkpoint`, `mk_session_end`).

Run a quick round-trip:

```
Use mk_remember to store this decision: we use pnpm for package management. confidence 0.95.
```

```
Use mk_recall with task "package manager" — what comes back?
```

## Optional config fields

| Field | Default | Description |
|---|---|---|
| `memoryDir` | `$MEMORY_DIR` env | Path to memory directory. Required if env var not set. |
| `encryptionKey` | — | Key for SECRET atom encryption. Omit to skip encryption. |
| `agentId` | `"openclaw"` | Label recorded in the audit event log. |
| `embeddingProvider` | — | Enables semantic recall. Set to `"openai"`. |
| `embeddingApiKey` | `$OPENAI_API_KEY` fallback | API key for embeddings. Falls back to `OPENAI_API_KEY` when provider is `openai`. |
| `embeddingModel` | provider default | e.g. `"text-embedding-3-small"`. |

## Enabling semantic recall (optional)

Without embeddings, `mk_recall` uses FTS5 keyword search + type-weighted ranking — good for typed queries, but not fuzzy semantic matches. To enable hybrid FTS5 + vector recall:

```json
{
  "plugins": {
    "entries": {
      "memory-kernel": {
        "enabled": true,
        "config": {
          "memoryDir": "/Users/YOU/.openclaw/mk-memory",
          "embeddingProvider": "openai"
        }
      }
    }
  }
}
```

If `OPENAI_API_KEY` is already available to the gateway process (e.g. exposed via the OpenAI plugin), the memory-kernel plugin reuses it automatically — no need to duplicate the key.

Then backfill embeddings for any existing atoms (one-time):

```bash
MEMORY_DIR=/Users/YOU/.openclaw/mk-memory \
EMBEDDING_PROVIDER=openai \
EMBEDDING_API_KEY="$OPENAI_API_KEY" \
mk reindex --embed
```

New atoms created via `mk_remember` after this are embedded automatically.

Verify:

```bash
mk status -d /Users/YOU/.openclaw/mk-memory
```

Look for `Embeddings: ✓ (N vectors, model: text-embedding-3-small)`.

## Lifecycle hooks

The plugin registers three named lifecycle hooks automatically — no agent action required:

| Hook | Event | What it does |
|---|---|---|
| `mk_bootstrap_recall` | `agent:bootstrap` | Recalls relevant memories and injects them into the agent's bootstrap context |
| `mk_precompact_checkpoint` | `session:compact:before` | Writes a checkpoint to memory before context compaction |
| `mk_session_end` | `command:new`, `command:reset` | Runs `reflect()` and writes a session episode when the user starts a new session |

## Troubleshooting

**Tools don't appear after restart**
- Check that `load.paths` points to the directory containing `package.json` (not `src/` or `dist/`)
- Run `npm run build` — OpenClaw loads `dist/index.js`, not the TypeScript source
- Check gateway logs for plugin load errors

**`memoryDir is required` error**
- Ensure `config.memoryDir` is set in `openclaw.json`, or export `MEMORY_DIR` to the gateway process environment

**SECRET atoms show as `MKENC:v1:...`**
- The encryption key is not available. Verify `MEMORY_ENCRYPTION_KEY` is exported in the shell that starts OpenClaw (not just your terminal session)

**`mk_recall` returns nothing**
- The plugin auto-reindexes on load if no index is present — check the gateway logs for `memory-kernel: reindex on init failed:` (it will log the underlying error if it couldn't rebuild).
- Run `mk_reflect` once to rebuild the SQLite FTS5 index, or from the CLI: `mk reindex -d <memoryDir>`.
- If you expect semantic matches and `mk_status` shows `0 embeddings`, see *Enabling semantic recall* above.

**Semantic recall not working / `0 embeddings`**
- Verify `embeddingProvider` is set in `openclaw.json` plugin config.
- Verify the gateway process has either `embeddingApiKey` in config or `OPENAI_API_KEY` in its environment (check `~/Library/LaunchAgents/ai.openclaw.gateway.plist` on macOS).
- Run `mk reindex --embed -d <memoryDir>` once to backfill embeddings for existing atoms.
