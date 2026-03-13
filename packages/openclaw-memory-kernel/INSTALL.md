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

You should see `mk_remember`, `mk_recall`, `mk_reflect`, and `mk_context_bundle` listed under active tools.

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

## Troubleshooting

**Tools don't appear after restart**
- Check that `load.paths` points to the directory containing `package.json` (not `src/` or `dist/`)
- Run `npm run build` — OpenClaw loads `dist/index.js`, not the TypeScript source
- Check gateway logs for plugin load errors

**`memoryDir is required` error**
- Ensure `config.memoryDir` is set in `openclaw.json`, or export `MEMORY_ENCRYPTION_KEY` to the gateway process environment

**SECRET atoms show as `MKENC:v1:...`**
- The encryption key is not available. Verify `MEMORY_ENCRYPTION_KEY` is exported in the shell that starts OpenClaw (not just your terminal session)

**`mk_recall` returns nothing**
- Run `mk_reflect` once to build the SQLite FTS5 index after the first `mk_remember` calls
- Or run `mk reindex <memoryDir>` from the CLI
