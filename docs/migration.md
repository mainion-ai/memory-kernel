# Migration Guide

How to bring existing memory into memory-kernel from various starting points.

---

## Path 1: From raw markdown files (CLAUDE.md, notes, docs)

You have `.md` files with knowledge — project notes, architecture docs, a hand-written CLAUDE.md, etc.

**Use `mk import`:**

```bash
# Dry run — preview what would be extracted without creating atoms
mk import --dry-run -d /path/to/memory myfile.md

# Import — creates one atom per H2/H3 section
mk import -d /path/to/memory myfile.md

# Override the auto-detected type (e.g., force all chunks to "fact")
mk import -d /path/to/memory --type fact myfile.md
```

**How it works:**
1. Splits the file by H2/H3 headings (falls back to bullet lists, then whole file)
2. Infers atom type from keywords (`decided` → decision, `must/never` → constraint, `believe/think` → belief, etc.)
3. Infers confidence from content (URLs and code → 0.9, prose → 0.75, uncertain language → 0.5)
4. Creates one atom per chunk with events logged

**After import:**
```bash
mk reindex -d /path/to/memory   # Rebuild SQLite index
mk reflect -d /path/to/memory   # Deduplicate, detect conflicts
mk doctor -d /path/to/memory    # Verify everything is healthy
```

**Tips:**
- Run `--dry-run` first to see the chunks before committing
- Review the auto-detected types — `mk import` uses keyword heuristics, not magic
- You can always edit the generated atom files directly (they're just markdown with YAML frontmatter)

---

## Path 2: From an existing memory-kernel (pre-v1.0)

You already have a memory directory with atoms but want to upgrade to v1.0.

**Step 1: Update the package**
```bash
npm install memory-kernel@latest
```

**Step 2: Bootstrap event sourcing** (if upgrading from < v0.5)

Pre-v0.5 atoms don't have V2 events. Bootstrap generates synthetic `atom_imported` events:

```bash
mk bootstrap-events -d /path/to/memory
```

This is idempotent — running it twice won't duplicate events.

**Step 3: Rebuild and verify**
```bash
mk reindex -d /path/to/memory   # Rebuild index with new schema
mk reflect -d /path/to/memory   # Run lifecycle (may trigger new features like conflict detection)
mk doctor -d /path/to/memory    # Health check
mk status -d /path/to/memory    # Confirm atom/event counts
```

**What's new that might affect existing data:**
- FTS5 full-text search index (built automatically on `reindex`)
- Classification field (`TEAM` default if missing — no action needed)
- Episode support (new `EPISODES/` directory created on first use)
- Evidence store (new `EVIDENCE/` directory created on first use)

No existing atoms need to be modified. New fields get sensible defaults.

---

## Path 3: From another memory system (Mem0, custom DB, embeddings store)

Export your data to markdown first, then use `mk import`.

**Generic approach:**
1. Export each memory/fact/note as a markdown section:
   ```markdown
   ## Server Configuration
   Production server runs PostgreSQL 15 on port 5432.
   Connection pool size: 20. SSL required.

   ## API Design Decision
   Decided to use cursor-based pagination instead of offset.
   Reason: better performance at scale, stable under concurrent writes.
   ```
2. Save as `exported-memories.md`
3. Run `mk import -d /path/to/memory exported-memories.md`
4. Review and adjust types/confidence in the generated atoms

**From Mem0 specifically:**
- Export memories via Mem0's API (`client.get_all()`)
- Format each memory as an H2 section in markdown
- Import with `mk import`
- Note: Mem0's vector embeddings don't transfer — memory-kernel uses typed atoms, not embeddings

---

## Path 4: From scratch (new agent)

```bash
# Initialize a fresh memory directory
mk init /path/to/memory

# Start remembering
mk remember -d /path/to/memory --type fact "Server runs Debian 13 on aarch64"
mk remember -d /path/to/memory --type decision "Use TypeScript for all new services"
mk remember -d /path/to/memory --type preference "User prefers direct communication"
```

Or use the TypeScript API:
```typescript
import { createAtom, recall, reflect } from 'memory-kernel';

createAtom({
  memoryDir: '/path/to/memory',
  agent_id: 'my-agent',
  session_id: 'session-001',
  type: 'fact',
  slug: 'server-config',
  body: 'Production server runs Debian 13 on Raspberry Pi 5.',
  confidence: 1.0,
});
```

---

## Path 5: Multi-agent merge (syncing memory between agents)

Two agents forked from a shared base and diverged. Merge them back:

```bash
# Agent B exports their event log
cp /agent-b/memory/events.ndjson /tmp/agent-b-events.ndjson

# Agent A merges B's events (idempotent, conflict-safe)
mk merge -d /agent-a/memory --remote /tmp/agent-b-events.ndjson

# Rebuild and verify
mk reindex -d /agent-a/memory
mk reflect -d /agent-a/memory   # Will detect conflicts if agents disagreed
mk doctor -d /agent-a/memory
```

Events are deduplicated by ID — merging the same log twice is safe.

---

## Directory layout after migration

```
/path/to/memory/
├── atoms/                  # Active atoms (markdown files)
│   ├── FACT-2026-03-09-SERVER-CONFIG/
│   │   └── atom.md
│   ├── DECI-2026-03-09-USE-TYPESCRIPT/
│   │   └── atom.md
│   └── ...
├── ARCHIVE/                # Archived/expired atoms
├── CONFLICTS/              # Detected contradictions
├── EPISODES/               # Session summaries
├── EVIDENCE/               # Content-addressed blobs
├── events.ndjson           # Append-only event log
├── .memory-index.db        # SQLite index (rebuildable)
├── INDEX.md                # Auto-generated overview
├── DECISIONS.md            # Auto-generated decisions view
├── CONSTRAINTS.md          # Auto-generated constraints view
├── OPEN_QUESTIONS.md       # Auto-generated open questions view
└── HANDOFF.md              # Auto-generated handoff summary
```

---

## Verify migration

After any migration path, run:

```bash
mk doctor -d /path/to/memory    # Schema validation, link checks
mk status -d /path/to/memory    # Atom counts, event counts, index health
mk recall -d /path/to/memory    # Test recall — should return your atoms
```

If `doctor` reports issues, the fix is usually:
```bash
mk reindex -d /path/to/memory   # Rebuild index from files
mk reflect -d /path/to/memory   # Re-run lifecycle
```

Files are always the source of truth. The index is derived and rebuildable.
