<p align="center">
  <img src="docs/images/transparent_logo.png" alt="Memory Kernel" width="150">
</p>

# Memory Kernel — A Filing Cabinet for AI Agents

> *Persistent, structured memory that survives the end of every conversation. Three verbs — **retain, recall, reflect** — over plain markdown files and an event log.*

> *You don't need to be a programmer to understand this. If you've ever written a sticky note, kept a journal, or cleaned out a filing cabinet, you already know how Memory Kernel works.*

---

## The Problem: Goldfish Agents

<p align="center">
  <img src="docs/images/goldfish.png" alt="Before and after: an agent without memory vs with Memory Kernel" width="500">
  <br>
  <em>Left: your agent today. Right: your agent with Memory Kernel.</em>
</p>

Imagine you hire an assistant. They're brilliant — fast, articulate, great at solving problems. But every morning they walk in with absolutely no memory of yesterday. You explain the project again. They ask the same questions. They contradict decisions they made last week. They forget your name.

That's what AI agents are like today. They have a **context window** — a short-term memory that holds the current conversation. When the conversation ends or gets too long, everything vanishes. The next time the agent starts up, it's a blank slate.

Memory Kernel fixes this. It gives the agent a **filing system** — a structured, persistent memory that survives between conversations, across days, weeks, and months.

---

## The Filing Cabinet Analogy

Think of Memory Kernel as a **filing cabinet** in an office. Here's how the analogy maps:

| Real World                | Memory Kernel               |
|---------------------------|-----------------------------|
| A single index card       | An **atom**                 |
| Writing on the card       | The atom's **body** (markdown text) |
| The label on top          | The atom's **type** and **metadata** |
| Filing it under a tab     | **Tags** and **paths** (scope) |
| The filing cabinet itself | The **memory directory** on disk |
| A logbook of everything   | The **event log** (`events.ndjson`) |
| A quick-lookup index      | The **SQLite index** (`.memory-index.db`) |
| A summary sheet on top    | Auto-generated **views** (INDEX.md, etc.) |

---

## At a Glance — The Whole System in One Picture

```
     YOU (or your agent)
         |
         |  "Remember this" / "What do I know?" / "Clean up"
         |
         v
  +--------------+
  | RETAIN       |  Creates/updates/archives atoms
  | RECALL       |  Queries atoms by type, tags, paths, budget
  | REFLECT      |  Expires, deduplicates, promotes, regenerates views
  +--------------+
         |
         |  reads/writes
         |
         v
  +--------------+     +-------------------+
  | Atom Files   |<--->| SQLite Index      |
  | (ENTITIES/)  |     | (speed cache,     |
  |              |     |  always derived)  |
  +--------------+     +-------------------+
         |
         |  every mutation logged
         |
         v
  +--------------+     +-------------------+
  | Event Log    |---->| Replay            |
  | (events.ndjson)    | (reconstruct      |
  |              |     |  everything from  |
  |              |     |  events alone)    |
  +--------------+     +-------------------+
         |
         |  summarized into
         |
         v
  +--------------+
  | Views        |
  | INDEX.md     |
  | DECISIONS.md |
  | CONSTRAINTS  |
  | OPEN_QUESTIONS|
  | HANDOFF.md   |
  +--------------+
```

**Files are truth.** Everything else is derived. Delete the SQLite index? Rebuild it. Delete the views? Reflect regenerates them. Delete the atom files? Replay them from the event log. The system is designed so that any single component can be lost and rebuilt from the others.

---

## Reading Paths

> **Just want the gist?** Read Ch. 1–2 and Ch. 11 (A Day in the Life). ~10 min.
> **Evaluating it for your project?** Add Ch. 10 (on-disk layout) and "Why It Works." ~20 min.
> **Adopting it?** Read the whole thing. ~50 min.
> **Curious how it grew up?** Skip to Ch. 19 and follow the version arc through Ch. 26, with the recent-history catch-up in Ch. 27.
> **Curious where it's heading?** Read Ch. 28.

---

## Five Things That Make This Different

1. **Files are truth.** No database. Every piece of knowledge is a plain markdown file you can open in any text editor — or commit to git.
2. **Self-cleaning.** Each piece of knowledge has an expiry date baked in. Stale beliefs get archived automatically, so the memory doesn't grow into a landfill.
3. **Smart recall.** When the agent asks "what do I know about X?", the system doesn't just dump everything — it ranks by relevance, type, age, and how often each atom has been referenced, then fits the best matches into the available space.
4. **Two agents can share a brain without colliding.** Each agent gets a private drawer plus a shared corkboard. When drawers need to merge, conflicts are flagged, not silently resolved.
5. **Tested like infrastructure.** 1,671 automated checks run on every change. 95 out of 100 memory queries finish in under 3 milliseconds. This is not a weekend toy.

---

## Chapter 1: The Atom — Your Smallest Unit of Knowledge

An **atom** is the smallest piece of knowledge the system stores. It's literally a markdown file on your computer — you can open it in any text editor, read it, even edit it by hand.

Every atom has two parts:

1. **Frontmatter** — metadata at the top (wrapped in `---` fences), written in YAML
2. **Body** — the actual knowledge, written in markdown

Here's what one looks like:

```
---
id: FACT-2026-03-10-SERVER-RUNS-DEBIAN
type: fact
status: active
confidence: 1.0
created_at: "2026-03-10T14:00:00Z"
updated_at: "2026-03-10T14:00:00Z"
ttl_days: null
scope:
  tags: [infrastructure, server]
  paths: [/projects/my-server]
classification: TEAM
---

The production server runs Debian 13 on a Raspberry Pi 5.
Hostname: prod-01. IP: 10.0.1.42.
```

Let's break that down:

- **id** — a unique name, auto-generated from the type, date, and a slug you provide
- **type** — what *kind* of knowledge this is (more on this in a moment)
- **status** — is it a `draft`, `active`, `archived`?
- **confidence** — how sure are we? 0.0 = wild guess, 1.0 = absolutely certain
- **ttl_days** — how long before it expires? `null` means forever
- **scope** — tags and file paths for organizing and filtering
- **classification** — who should see this? TEAM, PERSONAL, or SECRET

### Why Nine Types?

Not all knowledge is equal. "The server runs Debian" is a fact — high confidence, permanent. "I think Redis might be faster" is a belief — lower confidence, should be re-evaluated. "Never expose internal IPs in API responses" is a constraint — a hard rule.

Memory Kernel has **nine types**, each serving a different purpose:

**Permanent knowledge (no expiry):**
- **fact** — verified, true things ("The database is PostgreSQL 16")
- **decision** — choices that were made and why ("We chose TypeScript because...")
- **constraint** — rules that must not be broken ("Max 100 API calls per minute")
- **procedure** — step-by-step instructions ("To deploy: build, test, push, tag")

**Temporary knowledge (auto-expires):**
- **belief** — hypotheses, not yet proven ("I think caching will help" — 30 day TTL)
- **preference** — how the user likes things done ("Use short sentences" — 180 day TTL)
- **open_question** — things we need to figure out ("Should we use Redis?" — 90 day TTL)
- **entity_summary** — descriptions of important things ("The billing service handles Stripe" — 180 day TTL)

**Special:**
- **conflict** — two pieces of knowledge that contradict each other ("Docs say port 8080, config says 3000" — 30 day TTL)

The **TTL** (time-to-live) is the key insight — *this is what makes the system self-cleaning instead of ever-growing.* A belief that hasn't been proven in 30 days probably isn't worth keeping. A preference that nobody has mentioned in 6 months might have changed. The system automatically cleans these up.

---

## Chapter 2: The Three Operations — Retain, Recall, Reflect

Everything Memory Kernel does boils down to three verbs.

### Retain — "Remember This"

When the agent learns something new, it **retains** it. This means creating an atom file and writing it to disk.

**Example scenario:** An agent is working on a project and discovers that the production API has a rate limit of 500 requests per minute.

What happens:
1. A markdown file gets created in `ENTITIES/FACT-2026-03-10-API-RATE-LIMIT-a1b2.md`
2. An event gets appended to `events.ndjson`: `{"action": "atom_created", "atom_refs": ["FACT-..."], ...}`
3. If the SQLite index exists, it gets updated too

The agent can also **update** atoms (change confidence, add tags, edit the body) or **archive** them (soft-delete by moving to the `ARCHIVE/` folder).

Every single one of these actions gets logged as an event. Nothing happens silently.

### Recall — "What Do I Know About X?"

When the agent needs context for a task, it **recalls** relevant knowledge. This is like walking to the filing cabinet and pulling out the right cards.

**Example scenario:** The agent is about to work on the API layer. It asks: "What do I know about the API?"

What happens:
1. Memory Kernel filters atoms by the requested types, tags, and paths
2. It sorts them by priority (active beats draft beats archived)
3. It trims the results to fit a **token budget** (so the agent's context window doesn't overflow)
4. It returns the matching atoms as structured text the agent can read

The recall system has a fast path and a slow path:
- **Fast path:** If a SQLite index exists, it queries that (milliseconds)
- **Slow path:** If no index, it scans every file on disk and filters in memory (works, but slower)

Either way, you get the same results. The index is just a speed trick.

There's also **task-aware recall**. If you tell recall what you're working on — `task: "fix pagination bug"` — it uses a built-in search and ranking system (the same kind Wikipedia uses internally) to float the atoms that best match the task description to the top, and leave unrelated ones at the bottom. Run the same query twice on the same memory and you get the same order — no randomness.

And if you want to include **session episodes** — summaries of past work sessions — you can ask for those too with `include_episodes: true`. The system returns recent episode summaries alongside the atoms, so the agent knows not just *what* it knows but also *what it did* in recent sessions.

There are also privacy rules baked in. Atoms classified as `PERSONAL` or `SECRET` are excluded from recall by default. You have to explicitly ask for them.

### Reflect — "Clean Up and Organize"

<p align="center">
  <img src="docs/images/lifecycle.png" alt="The lifecycle of knowledge: from raw information to typed atoms to expiry and promotion" width="700">
  <br>
  <em>Knowledge flows in as raw information, crystallizes into typed atoms, and evolves over time — some expire, some get promoted.</em>
</p>

Over time, knowledge accumulates. Some of it expires. Some of it is duplicated. Some beliefs become proven facts. **Reflect** is the cleanup crew.

**Example scenario:** The agent has been running for a month. It calls `reflect()` to tidy up.

What happens, in order:

1. **Expire** — Any atom past its TTL gets moved to `ARCHIVE/` with status `expired`. A 30-day-old belief? Gone. A 90-day-old unanswered question? Archived.

2. **Deduplicate** — If two atoms of the same type have identical body text, the older one gets archived. Why keep two copies of the same fact?

3. **Promote** — Beliefs with confidence >= 0.9 get promoted to facts. Their type changes from `belief` to `fact`, their status changes from `draft` to `active`, and their TTL becomes permanent. The belief has been proven.

4. **Detect conflicts** — Look for pairs of `fact` or `decision` atoms that cover the same territory (overlapping scope paths) but have very different confidence scores (more than 0.3 apart). When such a pair is found, a `conflict` atom is created in `CONFLICTS/` and both source atoms are linked to it. This is a heuristic — it catches obvious disagreements but isn't trying to resolve them.

5. **Regenerate views** — Five summary files get rebuilt from the current state:
   - `INDEX.md` — a routing map of all active atoms
   - `DECISIONS.md` — every decision that's been made
   - `CONSTRAINTS.md` — all active rules and boundaries
   - `OPEN_QUESTIONS.md` — unresolved questions
   - `HANDOFF.md` — everything the next session needs to know

Every action reflect takes (each expiry, each dedup, each promotion) gets logged as its own event.

---

## Chapter 3: The Event Log — Your Receipt Book

The file `events.ndjson` is the **receipt book** for everything that ever happened. Every create, update, archive, promote, expire, and reflect gets recorded as a single line of JSON.

Here's what one event looks like (formatted for readability):

```json
{
  "timestamp": "2026-03-10T14:00:00.000Z",
  "action": "atom_created",
  "agent_id": "my-agent",
  "session_id": "session-42",
  "atom_refs": ["FACT-2026-03-10-API-RATE-LIMIT-a1b2"],
  "schema_version": 2,
  "atom_snapshot": "---\nid: FACT-...\ntype: fact\n---\nThe API rate limit is 500/min."
}
```

The crucial part is `atom_snapshot` — it contains the **full text of the atom at that moment**. This means the event log alone can reconstruct the entire memory state. You don't even need the atom files.

> **Why this one field carries the whole system:** `atom_snapshot` is the difference between "we logged what happened" and "we logged what the world looked like." Without it, a delete event loses the thing that was deleted. With it, replay can rebuild every atom that ever existed.

### Why This Matters

Imagine your filing cabinet catches fire (your disk gets corrupted, you accidentally delete files). If you have the event log, you can rebuild everything. Just replay the events in order, and every atom gets reconstructed exactly as it was.

This is called **event sourcing** — the log of what happened IS the truth, and the current files on disk are just a convenient cache of the latest state.

### Replay — Time Travel

The `replay()` function reads through events and rebuilds the atom state. It's a pure mathematical fold — same events in, same atoms out, every time.

You can even replay up to a specific timestamp to see what memory looked like at any point in the past. It's like time travel for your knowledge base.

### Compaction — Thinning the Receipt Book

After months of operation, the event log can get large. If you updated an atom 50 times, do you really need all 50 intermediate snapshots? Probably not — you just need the latest one.

`compactLog()` (or `mk compact` from the command line) thins the log by keeping only the **latest** mutation event per atom. All non-mutation events (like `reflect_completed`) are preserved. A backup of the original log is created first, just in case.

---

## Chapter 4: The SQLite Index — Your Speed Dial

Reading every atom file from disk every time you need to recall something is slow. Imagine walking to a filing cabinet with 10,000 cards and flipping through each one.

The SQLite index is a **lookup table** that lives alongside your atom files. It stores:
- Atom IDs, types, statuses, confidence scores
- Tags and paths (for fast filtering)
- Timestamps (for sorting)

When you call `recall()`, the system first checks if this index exists. If it does, it queries SQLite (which is blazing fast) instead of scanning the filesystem.

**Important:** The index is *always derived from the files*. If you delete it, nothing is lost. Run `mk reindex` and it gets rebuilt from scratch. The files are truth, the index is just a shortcut.

The index has **connection caching** — once opened, the database connection is reused for all subsequent operations in the same process. This avoids the overhead of re-running schema setup on every query.

It also has **schema versioning** — if the index was created by an older version of Memory Kernel with a different schema, it auto-detects this and rebuilds itself.

---

## Chapter 5: The Evidence Store — Your Attachment Folder

Sometimes knowledge isn't text — it's a file. A screenshot, a log dump, a configuration file. The **evidence store** is like an attachment folder for your filing cabinet.

When you store evidence:
1. The file's content gets hashed with SHA-256 (a fingerprint)
2. It's saved as `EVIDENCE/{hash}.blob`
3. You reference the hash from your atom

Because it's **content-addressed** (named by its hash), you can never accidentally overwrite one piece of evidence with another. If two different files have the same hash, they have the same content. If the content is different, the hash is different.

---

## Chapter 6: Episodes — Your Session Diary

Atoms store *what* you know. **Episodes** store *what you did*. An episode is a written summary of a work session — what happened, what was fixed, what was decided, what still needs attention.

Each episode is a markdown file in the `EPISODES/` folder, named after the session ID. You write one at the end of each session:

```
mk episode -d ./my-memory --session-id "2026-03-11-morning" \
  --summary "Resolved pagination bug. Updated 3 atoms. Auth module next." \
  --tags api,bugfix
```

Episodes have a few useful properties:

- **Newest-first listing** — `mk episodes` shows recent sessions at the top, so the agent knows what just happened
- **Linked to atoms** — `linkEpisodeToAtom()` attaches an episode to specific atoms, creating a provenance trail ("this decision was affected by session X")
- **Searchable via recall** — when you call recall with `include_episodes: true`, recent episode summaries are included alongside the atoms. Combine with `task` and only the episodes matching your task's keywords are returned
- **Excluded from atom listings** — episodes live in `EPISODES/`, not `ENTITIES/`, so they never show up as atoms and don't pollute the atom store

Think of episodes as a captain's log. The atoms are your charts and instruments — precise and persistent. The episodes are your entries about what voyage you took and what you learned.

---

## Chapter 7: The Views — Your Summary Sheets

Nobody wants to read 500 atom files to understand the current state. Memory Kernel auto-generates five **views** — summary documents that give you the big picture at a glance.

| View               | What it shows                                              |
|---------------------|------------------------------------------------------------|
| `INDEX.md`          | A routing map — all active atoms grouped by type, with one-line summaries |
| `DECISIONS.md`      | Every decision ever made, organized by status              |
| `CONSTRAINTS.md`    | All active rules and boundaries                            |
| `OPEN_QUESTIONS.md` | Unresolved questions, grouped by status (open, resolved, rejected) |
| `HANDOFF.md`        | A cross-session handoff — recent events + active atoms + a summary for the next agent |

These get regenerated every time `reflect()` runs. They're read-only outputs — don't edit them by hand, they'll be overwritten.

The `HANDOFF.md` is especially useful. When one agent session ends and another begins, the new session can read the handoff document to understand what happened before, what's currently active, and what needs attention.

---

## Chapter 8: Bootstrap — Onboarding an Existing Memory

What if you already have atom files on disk, but your event log is missing or incomplete? Maybe you created atoms before event sourcing was added, or you're migrating from an older version.

**Bootstrap** solves this. It:
1. Reads all existing atom files from disk
2. Creates synthetic `atom_imported` events for each one (with full snapshots)
3. Prepends these import events before the existing log
4. Creates a timestamped backup of the original event log

After bootstrapping, your event log can reconstruct every atom — even ones that existed before event sourcing was a feature.

Bootstrap is **idempotent** — run it twice, and it won't duplicate anything. It checks which atoms already have import events and skips them.

---

## Chapter 9: The Checkpoint — Packing for a Trip

A **checkpoint** is a self-contained bundle that captures the current state of memory for a specific task. Think of it as packing a travel bag: you don't take the entire filing cabinet, you take the relevant cards.

When you create a checkpoint:
1. `reflect()` runs first (cleanup)
2. `recall()` gathers relevant atoms for the given task and token budget
3. The five views are included (freshly generated)
4. Everything is assembled into a single markdown document

This is perfect for **handoff** — when one agent session ends and another picks up. The new session gets a concise, relevant snapshot instead of the entire raw memory.

---

## Chapter 10: On-Disk Layout — What's Actually on Your Computer

When you run `mk init ./my-memory`, you get this folder structure:

```
my-memory/
  ENTITIES/          <- Your atom files live here
  ARCHIVE/           <- Soft-deleted and expired atoms
  EVIDENCE/          <- Content-addressed binary blobs
  CONFLICTS/         <- Conflict atoms
  EPISODES/          <- Session summaries
  events.ndjson      <- The event log (append-only)
  INDEX.md           <- Auto-generated routing map
  HANDOFF.md         <- Auto-generated handoff document
  DECISIONS.md       <- Auto-generated decision log
  CONSTRAINTS.md     <- Auto-generated constraints list
  OPEN_QUESTIONS.md  <- Auto-generated questions list
  .memory-index.db   <- SQLite cache (optional, derived)
```

Everything is plain files. You can:
- **Read** them in any text editor
- **Diff** them in git to see what changed
- **Commit** them to version control for history and backup
- **Copy** them to another machine
- **Grep** them with standard Unix tools

No database server. No cloud service. No vendor lock-in. Just files.

---

## Chapter 11: A Day in the Life

Let's walk through a realistic scenario from start to finish.

### Morning: Session Starts

The agent wakes up. It reads `HANDOFF.md` to understand what happened yesterday:

> *"Last session: fixed a bug in the API rate limiter. Created 2 new facts, updated 1 decision. 3 open questions remain about caching strategy."*

The agent now has context. It knows where it left off.

### Working: Agent Learns Things

During the session, the agent discovers several things:

**Discovery 1:** The Redis cache expires keys after 5 minutes (not 10 as documented).

The agent creates a fact atom:
```
Type: fact
Body: "Redis cache TTL is 5 minutes, not 10 as previously documented."
Tags: [infrastructure, redis, cache]
Confidence: 1.0
```

**Discovery 2:** It *thinks* enabling compression might reduce API response times by 40%.

The agent creates a belief:
```
Type: belief
Body: "Enabling gzip compression could reduce API response times by ~40%."
Tags: [performance, api]
Confidence: 0.6
TTL: 30 days
```

**Discovery 3:** It resolves an open question from yesterday.

The agent updates the existing open_question atom, changing its status to `resolved` and updating the body with the answer.

Every one of these actions gets logged in the event log with a full snapshot of the atom.

### Afternoon: Agent Needs Context

The agent is about to work on the caching layer. It recalls relevant knowledge:

```
recall(memoryDir, {
  tags: ['cache', 'redis', 'performance'],
  max_tokens: 4000
})
```

This returns:
- The fact about Redis TTL being 5 minutes
- The belief about compression
- Any decisions about caching strategy
- Any constraints about cache size or eviction

All fitting within 4,000 tokens, sorted by relevance and recency.

### Evening: Reflect and Handoff

At the end of the day (or via a cron job), `reflect()` runs:

1. **Expire:** An old belief from 35 days ago (TTL was 30) gets archived
2. **Dedup:** Two identical facts about the same API endpoint get merged (older archived)
3. **Promote:** A belief from last week about database indexing had its confidence raised to 0.95 — it gets promoted to a fact
4. **Views regenerated:** INDEX.md, DECISIONS.md, etc. all get fresh content

A checkpoint creates the handoff document. Tomorrow's session will read it and pick up right where today left off.

### Night: Compaction (Optional)

If the event log has grown large, `mk compact` runs. It keeps only the latest event per atom and removes the intermediate updates. A backup of the full log is saved first.

Before: 2,847 events
After:    412 events (latest state for each atom + all reflect/checkpoint events)
          ↑ 86% reduction, byte-identical replay output — no information lost.

The compacted log can still reconstruct the exact same current state via replay.

---

## Chapter 12: The Safety Net

Memory Kernel has several safety features built in:

### Path Traversal Guards
Every file operation validates that the path stays within the memory directory. A crafted atom ID containing `../` can't trick the system into writing to `/etc/passwd` or reading files outside the memory folder.

### Idempotent Operations
- Archiving an already-archived atom is a no-op (prevents accidental data loss)
- Bootstrapping twice doesn't create duplicate imports
- Compacting an already-compact log does nothing

### Backups Before Destructive Operations
- Bootstrap creates a timestamped backup of events.ndjson before rewriting
- Compact creates a timestamped backup before removing events
- Archive moves files to `ARCHIVE/` instead of deleting them

### Atomic Writes
Files are written to a temporary name first, then renamed into place. If the process crashes mid-write, you get either the old file or the new file — never a corrupted half-written mess.

### Classification-Based Privacy
Atoms can be classified as `TEAM`, `PERSONAL`, or `SECRET`. Personal and secret atoms are excluded from default recall — an agent won't accidentally include your private notes in a response.

---

## Chapter 13: The CLI — Your Command Line Remote Control

You don't need to write code to use Memory Kernel. The `mk` command gives you everything:

```bash
# Start fresh
mk init ./my-memory

# Remember something
mk remember -d ./my-memory --type fact --tags server,setup \
  "Production runs Debian 13 on Raspberry Pi 5"

# Check what's stored
mk status -d ./my-memory

# Pull relevant context (basic)
mk recall -d ./my-memory --types fact

# Pull context for a specific task (ranked by relevance, best matches first)
mk recall -d ./my-memory --task "fix pagination bug"

# Pull context with recent session history included
mk recall -d ./my-memory --task "auth module" --include-episodes

# Write a session episode when a session ends
mk episode -d ./my-memory --session-id "session-42" \
  --summary "Fixed pagination bug, updated 3 atoms" \
  --tags api,bugfix

# List recent episodes
mk episodes -d ./my-memory --limit 5

# Clean up and consolidate
mk reflect -d ./my-memory --agent-id my-agent --session-id s1

# Generate a handoff bundle
mk checkpoint -d ./my-memory --task "Fix the API bug"

# Speed up queries
mk reindex -d ./my-memory

# Shrink the event log
mk compact -d ./my-memory

# Replay from events to a new directory
mk replay --from ./my-memory/events.ndjson --output-dir ./fresh-copy

# Migrate old atoms to event-sourced format
mk bootstrap-events -d ./my-memory --agent-id my-agent

# Health check
mk doctor -d ./my-memory
```

---

## Why It Works

Memory Kernel works because it respects a few simple principles:

1. **Structure over soup.** Typed atoms with metadata beat a giant text dump. The system can reason about its own knowledge — expire stale beliefs, promote proven hypotheses, detect contradictions.

2. **Files over databases.** Markdown files are universal. Any tool can read them, any human can understand them, and git gives you free version history, backup, and collaboration.

3. **Events over snapshots.** Recording what happened (event sourcing) is more powerful than just saving current state. You get history, replay, audit trails, and time travel — all from one append-only file.

4. **Budget-aware retrieval.** An agent's context window has a limited size. Recall doesn't dump everything — it selects the most relevant atoms and fits them into the available token budget.

5. **Automatic maintenance.** Reflect runs periodically and handles the housekeeping — expiring stale data, removing duplicates, promoting confirmed beliefs. The memory stays clean without manual intervention.

6. **Collaboration without coordination.** When two agents work in parallel, their memories can be merged later without locking or synchronisation during the work. The event log records everything; the merge step reconciles it.

---

## A Turning Point

Everything up to this chapter described **what Memory Kernel does**: atoms, events, views, recall, reflect. If you stop reading here, you've got the whole picture.

Everything from here on describes **how it became good at doing it**. Each of the next thirteen chapters solves one real problem that showed up as people used the system. They're a development story, not a changelog — you can read them as a sequence, and each chapter builds on the one before it.

If you're just evaluating whether Memory Kernel fits your project, "Why It Works" (above) is a perfectly fine stopping point. If you're curious how a filing cabinet grew into office infrastructure, keep going.

---

## Chapter 14: When Two Agents Meet — Merging Memories

### The Parallel Universe Problem

Imagine your team deploys two AI agents to work on the same codebase over the weekend. Agent A is fixing bugs. Agent B is exploring a refactor. Both have their own memory directories. Both are writing facts, decisions, and constraints as they go.

On Monday, you want to combine their knowledge. What happens?

Without a merge mechanism, you'd have to choose: keep Agent A's memory, or keep Agent B's memory. You'd lose half the work.

With Memory Kernel's merge, you union them — keeping everything both agents learned, automatically detecting where they disagreed.

### The Event Log Is the Key

Here's the clever part: because Memory Kernel is event-sourced, every memory directory tells you *exactly what happened and when*. Each create, update, and archive is a timestamped event in `events.ndjson`.

When you merge two event logs, you're not merging messy state — you're merging a clean, ordered history of facts.

```
Agent A's events.ndjson:          Agent B's events.ndjson:
  t=1: create FACT-A1               t=1: create FACT-B1
  t=3: create FACT-A2               t=2: update FACT-A1 (different value!)
  t=5: update FACT-A1               t=4: create FACT-B2
```

### What mk merge Does

```bash
mk merge -d ./agent-a-memory --remote ./agent-b-memory
```

The merge does four things:

1. **Union** — Combine all events from both logs. If the same event appears in both (maybe the two agents started from a shared copy), it gets counted once, not twice. Every event has a unique ID, so the system can tell duplicates apart from genuinely-separate events.

2. **Sort** — Put all the combined events in time order. The result is a single, consistent history of every action both agents ever took — as if they had been sharing one cabinet the whole time, just in slow motion.

3. **Replay** — Re-run the sorted events one by one, the same way each agent originally built their memory. The output is a new, unified set of atoms that reflects everything either agent learned.

4. **Conflict detection** — If the *same* atom got changed by both agents independently, the merge creates a `conflict` atom flagging the disagreement. This shows up the next time someone runs cleanup, so a human (or the agent itself) can decide which version to keep.

### The Filing Cabinet Analogy

Imagine two assistants both keeping a shared filing cabinet, but working in separate rooms. Agent A files a note: "The database timeout is 30 seconds." Agent B, independently, files a note: "The database timeout is 60 seconds."

When you merge the cabinets, you don't silently pick one and discard the other. Instead, a sticky note appears on top: "CONFLICT: two agents disagree about database timeout — see CONFLICTS/ for details."

The merge never loses information. It surfaces disagreements for resolution.

### Dry-Run Mode

Not sure what will happen? Use `--dry-run` to preview:

```bash
mk merge -d ./agent-a-memory --remote ./agent-b-memory --dry-run
```

This shows you how many atoms would be written and how many conflicts would be created — without touching any files.

### When to Merge

- After two agents worked on the same project in parallel
- When pulling a teammate's memory directory into your own
- After restoring from a backup: merge the backup's events with the current log to get a complete history
- In CI: merge the memory from a feature branch run with the main branch memory before deploy

### The Result

After `mk merge`, you have one memory directory that knows everything both agents knew. Run `mk reflect` to clean up any stale or duplicate atoms that surfaced in the merge, and run `mk recall` to load the unified context into your next session.

The two agents' weekend work is combined in seconds, with no data lost and disagreements clearly flagged.

That's it. A filing cabinet for AI agents, built from markdown files, an event log, and three simple operations. No magic, no proprietary formats, no cloud dependencies. Just structured knowledge that persists.

---

## Chapter 15: Keeping Secrets — Encryption at Rest

Your filing cabinet sits on a disk. Anyone with access to that disk can read your index cards — open the files in a text editor, browse them in a terminal, grep through them. For most knowledge that's fine. But what if some cards contain API keys, personal health data, passwords, or confidential business decisions?

Memory Kernel has a way to lock those cards.

### The Lock: SECRET Classification + Encryption Key

Every atom has a **classification** field. Most atoms are `TEAM` — readable by anyone working on the project. But if you set an atom's classification to `SECRET`, Memory Kernel will encrypt its file on disk.

Here's what a SECRET atom looks like *with* the key:

```
---
id: FACT-2026-03-10-API-KEY-a1b2
type: fact
status: active
classification: SECRET
---

The production Stripe API key is sk_live_AbCdEf1234567890...
```

And here's what that same file looks like *without* the key (what an attacker sees on disk):

```
MKENC:v1:dGhpcyBpcyBhIHRlc3Q=:7Bx9mK3nQ2pR8sT1uV6wY0zA4bC5dE6fG7hI8jK9lM...
```

One line. Unreadable. The `MKENC:v1:` prefix tells the system "this file is encrypted" — so even if you forget to set the key, it won't try to parse the encrypted blob as markdown and silently return garbage.

### Setting Up Encryption

Set an environment variable before running:

```bash
# Option 1: 64-character hex key (most secure — use a password manager)
export MEMORY_ENCRYPTION_KEY="a3f9b2e1d4c7f0a8b3e6d9c2f5a8b1e4d7c0f3a6b9e2d5c8f1a4b7e0d3c6f9a2"

# Option 2: A passphrase (easier to remember — the system stretches it into a full key using a standard password-hardening method)
export MEMORY_ENCRYPTION_KEY="my-super-secret-passphrase"
```

That's it. From that point on:
- Any atom you create with `classification: SECRET` is automatically encrypted when saved
- `readAtom()` automatically decrypts it when you read it back
- The encryption/decryption happens transparently — your code doesn't need to change at all

### What Happens Without the Key

If someone tries to read a SECRET atom without the key set:
- `listAtoms()` prints a warning to stderr and **skips** the encrypted atom — it doesn't crash, it doesn't return corrupted data, it just quietly moves on
- `recall()` never returns encrypted atoms without the key — they're invisible to the agent

If you set the wrong key, `readAtom()` will fail with a decryption error. To verify your key is correct:

```bash
mk doctor -d ./my-memory
```

This checks that all encrypted atoms can be decrypted with the current key.

### The Encryption Details (For the Curious)

- **The lock itself:** AES-256-GCM — the same encryption used by HTTPS websites, Signal, and most modern banking apps. If you trust your bank's website, you can trust this lock.
- **Turning a passphrase into a key:** if you give the system a short passphrase instead of a 64-character random string, it runs the passphrase through a hardening function (100,000 rounds of transformation). This makes it very expensive for an attacker to guess your passphrase by trying millions of candidates — each guess costs them the full hardening work.
- **What's locked and what's not:** the body of the atom (the actual knowledge) is encrypted. The label on top (id, type, status) stays readable — so the system can count and file the cards without needing to unlock them.
- **The event log:** the snapshot of a SECRET atom stored in the event log is also encrypted. Non-secret events are readable without the key, so you can still audit what happened without exposing private content.

The bottom line: you can keep sensitive knowledge in the same filing cabinet as everything else, with a lock on the drawer that contains it.

---

## Chapter 16: Talking to Claude — The MCP Server

You've built a filing cabinet. But every time you want the agent to use it, you have to write code: import the SDK, call `recall()`, pass the results to the agent. What if the agent could open the filing cabinet itself?

That's what the MCP server does.

### What Is MCP?

MCP stands for **Model Context Protocol** — a standard that lets AI assistants (Claude, Cursor, and others) talk to local servers on your computer. Think of it as a USB plug for tools: you connect a tool to the AI, and the AI can use it without any custom integration code.

Memory Kernel ships an MCP server that you can connect to Claude Desktop, Claude Code, or any other MCP-compatible AI tool in minutes.

### Setting It Up

Install and configure once:

```json
// In your Claude Desktop config file (claude_desktop_config.json)
{
  "mcpServers": {
    "memory-kernel": {
      "command": "npx",
      "args": ["mk-mcp"],
      "env": {
        "MEMORY_DIR": "/path/to/your/memory",
        "MCP_AGENT_ID": "claude",
        "MCP_SESSION_ID": "session-001"
      }
    }
  }
}
```

Restart Claude Desktop. Memory Kernel is now a tool Claude can call. No code required.

### What Claude Can Do With It

The MCP server exposes **8 tools** — actions Claude can take:

| Tool | What it does | Equivalent to |
|---|---|---|
| `remember` | Store a new atom | `createAtom()` |
| `recall` | Fetch relevant atoms for a task | `recall()` |
| `reflect` | Run cleanup and consolidation | `reflect()` |
| `merge` | Merge another agent's memory | `mergeEventLogs()` |
| `gc` | Archive expired atoms | `reflect()` (GC mode) |
| `list_conflicts` | Show conflicting atoms | `listAtoms({ type: 'conflict' })` |
| `resolve_conflict` | Mark a conflict as resolved | `resolveConflict()` |
| `get_context_bundle` | Get a full handoff snapshot | `checkpoint()` |

And **4 resources** — documents Claude can read directly:

- `memory://decisions` — all active decisions
- `memory://constraints` — all active rules
- `memory://handoff` — the cross-session handoff document
- `memory://open-questions` — all unresolved questions

### A Concrete Example

You're working with Claude on a backend project. You ask:

> *"What do we know about the authentication module?"*

Claude calls the `recall` tool with `task: "authentication module"`. Memory Kernel searches its index, finds 4 relevant atoms, and returns them to Claude. Claude reads them and answers:

> *"Based on memory: the auth module uses JWT tokens (decision from March 10), the token TTL is 24 hours (fact, confidence 1.0), and there's an open question about refresh token rotation that hasn't been resolved."*

All of that came from the filing cabinet — not from the current conversation, not from the model's training data. It came from persistent, structured knowledge that survived across sessions.

Later, Claude creates a new atom:

> *"I'll remember that we decided to use PKCE for the OAuth flow."*

Claude calls the `remember` tool. An atom gets created. The decision persists.

### Provenance on Every Call

Every tool response includes a `provenance` block:

```json
{
  "provenance": {
    "memoryDir": "/path/to/memory",
    "agent_id": "claude",
    "session_id": "session-001",
    "executed_at": "2026-03-10T14:00:00Z",
    "atoms_returned": 4
  }
}
```

This tells you exactly when the call was made, who made it, and which atoms were involved. Every `recall` call is also logged as an `atom_read` event in the event log — a complete audit trail of what the agent read and when.

---

## Chapter 17: Importing the Past — mk import

You've been keeping notes for months. A README full of architectural decisions. Meeting notes with action items. A design doc with constraints. Can Memory Kernel absorb all of that existing knowledge without you manually copying each piece into an atom?

Yes. That's what `mk import` is for.

### How It Works

```bash
# Preview what would be created (no files written)
mk import --from ARCHITECTURE.md --dir ./my-memory --dry-run

# Actually import it
mk import --from ARCHITECTURE.md --dir ./my-memory \
  --agent-id my-agent --session-id session-import-1
```

Memory Kernel reads the file, chops it into chunks, figures out what type of atom each chunk should be, and creates one atom per chunk. The whole document becomes part of your structured memory.

### How It Splits Your File

The importer tries three strategies, in order:

1. **Section headings first.** If your document has sub-headings like `## Database Choice` or `## Open Questions`, each section becomes one atom. This works beautifully for design docs and READMEs.

2. **Bullet points as a fallback.** If there are no headings but there are bullet lists, each bullet becomes its own atom.

3. **The whole file as a last resort.** If the file has no structure at all — just flowing prose — the entire file becomes a single atom.

Chunks shorter than 20 characters get dropped. They're too short to carry useful meaning ("TODO:", "Notes:", and similar leftovers).

### Type Inference

Memory Kernel reads each chunk and infers what type of atom it should be based on keywords:

| If the text contains… | The atom becomes… |
|---|---|
| "decided", "chose", "we will", "agreed" | `decision` |
| "must", "never", "required", "prohibited" | `constraint` |
| "question", "how do we", "should we", ends with "?" | `open_question` |
| "believe", "probably", "might", "I think" | `belief` |
| anything else | `fact` |

### Confidence Inference

The confidence score is also inferred from the content:

- Contains a URL or `backtick code` → confidence 0.9 (citable, specific)
- Contains "believe", "probably", "might" → confidence 0.5 (uncertain)
- Everything else → confidence 0.75 (default)

### A Concrete Example

Say you have this `ARCHITECTURE.md`:

```markdown
## Database Choice

We decided to use PostgreSQL 16 as the primary database.
See benchmark results at https://benchmarks.example.com.

## Open Questions

Should we use read replicas for the reporting queries?
How do we handle schema migrations in production?

## Constraints

We must maintain < 100ms p95 query latency.
Never expose internal database IDs in API responses.
```

Running `mk import` on this creates 4 atoms:
- `decision`: "We decided to use PostgreSQL 16..." → confidence 0.9 (has a URL)
- `open_question`: "Should we use read replicas..." → confidence 0.75
- `open_question`: "How do we handle schema migrations..." → confidence 0.75
- `constraint`: "We must maintain < 100ms p95..." → confidence 0.75
- `constraint`: "Never expose internal database IDs..." → confidence 0.75

Five years of notes, imported in seconds.

---

## Chapter 18: The Test Bench — How We Know It Works

Memory Kernel stores knowledge that AI agents rely on to make decisions. If a key fact gets corrupted, mangled, or silently dropped during routine maintenance, the agent might make the wrong call. How do we know the system is reliable?

We test it. A lot.

### 551 Tests, 21 Files

Every time a change is made to Memory Kernel, 551 automated checks run. Each check is a small program that says: *"given this situation, I expect this result."* If any of them disagree, the change is rejected before it can reach users.

These tests cover every layer of the system — from individual functions ("does `percentile([1,2,3], 95)` return the right value?") all the way up to full end-to-end scenarios ("create 100 atoms, run reflect 5 times, then merge with a remote memory — does everything come out right?").

### Compaction-Loss Torture Tests

Here's the scenario that keeps us up at night: the cleanup cycle (`reflect`) runs and accidentally truncates the body of an atom. A rule like "use TLS v1.3+ in production" gets shortened to just "use TLS". The port number "8080" disappears. The cross-reference "see AUTH-CONFIG" gets dropped.

The agent reads the atom later and gets incomplete or wrong information. Silently. With no error.

To prevent this, we have **compaction-loss torture tests**. These tests write atoms with specific content — exact numbers, specific rules, cross-references, conditional logic, open questions — and then run the reflect cycle 5 times in a row. After all 5 cycles, every test checks that the content is still there, character by character.

Here's what one such test checks after 5 cleanup cycles:

```
✓ Port: 8080 — still there
✓ Timeout: 30s — still there
✓ If production: use TLS — still there
✓ If retries exhausted: circuit-break for 60s — still there
✓ Rationale: cursor pagination chosen after benchmarking — still there
✓ Related: FACT-2026-AUTH-CONFIG — still there
✓ Does the approach handle IPv6? — still there
```

If any line is missing or changed, the test fails and the change is blocked.

### Replay Determinism

The event log is the source of truth. `replay()` is the function that rebuilds atom state from events. For this to be reliable, it must be **deterministic**: given the exact same sequence of events, you must get the exact same output — always, on any machine, at any time.

We verify this by replaying the same event log twice in a row and comparing the results character by character:

```
replay(events) → result1
replay(events) → result2
check: result1 and result2 are exactly identical, right down to the last byte
```

If anything sneaks in that's not perfectly reproducible — a random ordering, a timestamp from the wall clock, a set whose iteration order varies — this test catches it.

### Reflect Idempotence

Running cleanup once on a tidy memory should produce the same result as running it twice. The second pass shouldn't invent new work to do, shouldn't change atoms that are already correct, and shouldn't emit extra events.

We verify this explicitly:

```
reflect(memory) → views_v1
reflect(memory) → views_v2   (same memory, second pass)

check: views_v1 and views_v2 are identical
check: second pass deduplicated nothing
check: second pass expired nothing
check: second pass promoted nothing
```

This matters because reflect runs automatically on a schedule. If each run modified things slightly, the system would drift over time.

### Stress Tests

Normal tests use 3–5 atoms. The stress test suite uses **500 atoms** — 5× the scale that a typical session would accumulate. All the operations run: create, update, archive, merge with a second agent's memory, search, reflect.

At 500 atoms without the speed-cache index, the entire cleanup cycle completes in under 15 seconds. With the index, 95% of recall queries finish in under 100 milliseconds (that's the "p95" number — 95 out of 100 queries are at least that fast).

The stress tests also hammer the error paths: corrupted event log lines, atom files with invalid frontmatter, path traversal attempts (`../evil`), concurrent archive operations. The system must handle all of these gracefully — no crashes, no silent data corruption.

### The Benchmark Harness

Speed matters. An agent that waits 5 seconds for a recall can't have a real conversation.

The benchmark harness creates 100 atoms, runs 50 recall queries, and records how long each one takes:

```bash
npm run bench
```

Output:

```json
{
  "recall": {
    "p50_ms": 2.2,
    "p95_ms": 2.97,
    "p99_ms": 3.92,
    "samples": 50,
    "target_p95_ms": 50,
    "meets_target": true
  },
  "reflect": { "elapsed_ms": 150.37 },
  "replay": { "elapsed_ms": 1.65, "events_count": 161 }
}
```

Here's how to read those numbers: `p50` is the typical query (half are faster, half are slower). `p95` is the slower end — 95% of queries finish in under this time. `p99` is the tail — even the slowest 1% of queries finish within this time.

The target we set before shipping was: 95% of queries under 50 milliseconds. The actual result is 3 milliseconds — **16× better than required**.

> **Why the gap matters:** agents query memory 5–20 times per session. At 50ms each, the query budget shows up as a noticeable pause. At 3ms, every query disappears into the noise — recall stops being something the agent has to plan around.
>
> For a sense of scale: 3 milliseconds is roughly the time a modern SSD takes to open and close a single file. A fresh keyword query on a cold local database typically takes 10–30ms. Recall is running faster than most systems ever ask the filesystem to serve.

You can pin a baseline for your own machine:

```bash
npm run bench:baseline      # saves result to scripts/bench-baseline.json
```

If a future change makes recall significantly slower, you'll see it immediately when you re-run the benchmark. No surprises in production.

### Why This Level of Testing?

Because memory is load-bearing. An agent that makes decisions based on corrupted facts is worse than an agent with no memory — at least with no memory, you know it's working from scratch. A corrupted fact is invisible damage.

Every test is a promise: *this invariant holds, on every machine, after every change.* The 1,671 tests are 1,671 such promises.

---

## The Version Arc — How Memory Kernel Grew Up

The next eight chapters are a development story, not a changelog. Each release solved a specific problem the previous one exposed. Here's the shape of the arc, using the real version numbers you'll find on npm and in `CHANGELOG.md`:

```
 v1.0  ── v1.0.1 ── v1.4 ── v1.5 ── v1.6 ── v1.7 ── v1.9 ── v1.12 ── v1.15
 core     docs +    type &  body-   ACT-R   --json  closure  prod-    extract,
 library  plugin    age-    text    citation across  metric   ready    consoli-
 shipped  rename    aware   refs    model   the     (self-   infra +  date,
                    recall                  CLI     ref.     per-     lint
                                                    index)   agent
 Ch.1–18  Ch.19     Ch.20   Ch.21   Ch.22   Ch.23   Ch.24    Ch.25–26  Ch.27
```

v1.0 proved the library worked. v1.0.1 made it approachable. v1.4 taught it what matters most. v1.5 taught it to read its own prose. v1.6 added citation-frequency activation. v1.7 made every command machine-readable. v1.9 gave the store a way to measure its own complexity. v1.12 bolted it to the floor as infrastructure *and* gave each agent its own drawer — the two huge changes shipped in the same release. v1.13 through v1.15 added episode-aware recall, ranking fixes, and the `extract`/`consolidate`/`lint` commands.

---

## Chapter 19: Opening the Doors — Docs, Plugins, and a Cleaner API

v1.0.0 was the proof that Memory Kernel worked. v1.0.1 was about making it easy to use.

After Milestone G shipped, the question shifted from *"does it work?"* to *"can someone new pick this up in an afternoon?"* The answer was: *mostly, but there are rough edges.*

### The Name Problem

When the MCP server launched in Milestone E, its tools were named after what they did: `remember`, `recall`, `reflect`, `merge`. Simple, but a problem once the native OpenClaw plugin arrived. The plugin also exposed tools named `mk_remember`, `mk_recall` — and suddenly there were two naming conventions living side by side. Clients that connected to both the MCP server and the plugin would see confusing duplicates.

The fix was straightforward: rename all 8 MCP server tools to carry the `mk_` prefix. `remember` → `mk_remember`, `resolve_conflict` → `mk_resolve_conflict`, and so on. The prefix makes the source obvious at a glance — any tool starting with `mk_` comes from Memory Kernel.

It was a breaking change. Anyone with a Claude Desktop or Cursor config pointing at the old names had to update it. But the CHANGELOG gave them the full migration table, and the change made the system significantly less confusing going forward.

### The Three Guides

Three documents were written to answer the most common questions from new users:

**"How do I bring in my existing notes?"** — The migration guide (`docs/migration.md`) covers five different starting points: raw markdown, upgrading from a pre-v1.0 memory directory, migrating from another memory system, starting fresh, and setting up multi-agent merge. Each path has concrete commands and a "what to check after" section.

**"Should I even use this?"** — The decision guide (`docs/when-to-choose-memory-kernel.md`) is deliberately honest. Memory Kernel isn't always the right tool. If you're building a simple chatbot with a few static facts, a plain markdown file is fine. If you need semantic vector search, that's a different layer. The guide helps people self-select: use Memory Kernel when you need typed, versioned, audited memory with lifecycle management across long-running sessions.

**"How do I connect this to OpenClaw?"** — The OpenClaw MCP guide (`docs/openclaw-mcp.md`) is a zero-code quick-start for the most common setup: running Memory Kernel as an MCP server and pointing OpenClaw at it. Five minutes from `npm install` to first `mk_remember` call.

### The Native Plugin

For OpenClaw users who wanted even tighter integration, the native plugin (`packages/openclaw-memory-kernel/`) was the answer. Instead of running a separate MCP server process, the plugin loads directly into OpenClaw as a first-class extension.

The trade-off is scope: the native plugin exposes only the four core tools — `mk_remember`, `mk_recall`, `mk_reflect`, `mk_get_context_bundle`. The maintenance tools (`mk_merge`, `mk_gc`, `mk_list_conflicts`, `mk_resolve_conflict`) are available through the MCP server for users who need them, but kept out of the plugin's default surface to reduce cognitive load for the common case.

The plugin ships with its own `SKILL.md` — a routing guide that tells the agent exactly when to call which tool and why. It's the difference between an agent that *has* memory and an agent that *uses* memory well.

### What v1.0.1 Represents

v1.0.0 proved the system was solid. v1.0.1 made it approachable.

If v1.0.0 was building the filing cabinet, v1.0.1 was labeling the drawers, writing the user manual, and putting up a sign that says *"you can use this now — here's how."*

---

## Chapter 20: Teaching the System to Care About Age and Type

v1.0.0 proved memory-kernel could store and retrieve. v1.4.0 tackled the harder question: *what should surface first?*

The original recall was democratic. Every active atom had an equal chance of appearing in the context window. The order was recency — whatever was updated most recently bubbled to the top. Simple, predictable, wrong.

The problem became obvious in practice. An agent working on a deployment task would get back a mix of: a decision made six months ago that still mattered, a belief from yesterday that was probably stale, an open question from three weeks ago, and a constraint from last year that was absolutely non-negotiable. All scored the same. The constraint would often lose to the belief simply because the belief was newer.

### Phase 1: Teaching the System About Time

The first fix was a gentle fading-with-age. Not expiry — the expiry clock already handles the "throw this away" case. This was softer: a continuous nudge that made older atoms contribute less to ranking, without removing them.

The rule is "half-life thirty days": a fact one month old counts half as much as a fresh one. Two months old, a quarter. Three months, an eighth. Age fades slowly, not suddenly, and agents working with long-lived knowledge can stretch the half-life to whatever suits them.

The fade doesn't overpower relevance — it just nudges it. By default, 80% of an atom's score still comes from how well it matches the query; only 20% comes from how recent it is. An agent that wants pure relevance can turn the fade off entirely.

One edge case took a moment to get right: atoms dated in the future (scheduled decisions, planned constraints). The age math would count them as "negatively old," scoring them higher than they should be. A simple "clamp age to zero if negative" fixed it.

### Phase 2: Types Are Not Peers

The second insight was simpler to state but harder to implement: a constraint is worth more than a belief. Not because a user said so — because of what the types *mean*. A constraint is a hard rule. A belief is a guess. When filling a limited context window, you'd rather have the constraint and miss the belief than the other way around.

So each type gets a multiplier. Constraints count 1.5×. Decisions 1.3×. Procedures 1.2×. Facts and preferences 1.0×. Open questions 0.9×. Beliefs and entity-summaries 0.8×. These aren't arbitrary — they reflect how much weight each type deserves when the agent is trying to get something done.

Confidence works alongside this. An atom with low confidence doesn't drop to zero — it falls to at worst 70% of its full weight. A low-confidence fact is still a valid data point; you don't want to silently suppress what you're unsure of.

One more guarantee: reserved space. If you have twenty constraints in memory and a tight context window, the system reserves at least a small chunk of space for constraint content, no matter what. Only after that reservation is filled does the rest of the budget get packed with everything else by score.

### Phase 3: Atoms Don't Live in Isolation

The third phase came from a real failure: related atoms that should reinforce each other were being treated as independent. A decision that built on another decision — you'd want both — but if only one matched the query's keywords, the other would score near zero.

The solution was to let atoms declare how they're connected. A new `related-to` field lets an agent say things like "this decision extends that one," "this belief contradicts that constraint," "this procedure supersedes that one." Seven relation types cover the common cases: `extends`, `contradicts`, `supports`, `caused_by`, `supersedes`, `applied_to`, `related`.

With those connections in place, recall walks the connections. When one atom scores high, a small amount of that score "spreads" to its directly-connected neighbours — similar to how a vivid memory helps you recall related ones. The system uses a diminishing-returns rule: if a neighbour already got boosted once, a second boost adds less, so no single atom runs away with all the score.

### The Shape of v1.4.0

What emerged is a six-step scoring pipeline. In plain English:

1. **Find matches.** Score each atom on how well it matches the query — both by shared words and (optionally) by meaning.
2. **Fade old ones.** Multiply by a recency factor, so a six-month-old atom counts less than a brand-new one.
3. **Blend the two.** Mostly relevance, with a pinch of recency.
4. **Weigh by type and confidence.** A high-confidence constraint beats a low-confidence belief, all else equal.
5. **Spread to neighbours.** Atoms related to a high scorer get a small lift.
6. **Pack the budget.** Reserved types (like constraints) fill first. The rest of the space gets filled by top score.

Every knob in this pipeline is tunable. The defaults are designed to work well without fiddling, but agents with specific needs — a domain where all decisions stay relevant for years, or where constraint violations are catastrophic — can dial any parameter per-call or via environment variable.

The 690 tests are 690 promises that the pipeline behaves exactly as specified. The scoring is fast enough that adding all three phases barely moved the speed benchmark — each atom's score gets computed once before sorting, not re-computed on every comparison.

If v1.0.1 was labeling the drawers, v1.4.0 is teaching the system which drawer matters most for what you're doing right now.

---

## Chapter 21: The System That Reads Its Own Files

Chapter 20 gave us connections between atoms — typed links like "this decision extends that one" — that let recall spread score to related atoms. But there was a catch: someone had to *create* those connections. The agent had to remember to write "this extends that." If it forgot — or never noticed the connection — the link didn't exist.

Most connections went unstated. An agent would write a belief about file-first architecture, then three days later write a decision that referenced "the file-first approach" in its body text — without linking the two atoms. The knowledge graph had holes wherever humans (or agents) were imprecise.

### Reading Between the Lines

The fix was `mk relink`. Instead of waiting for someone to draw the arrows, the system reads every atom's body text and looks for atom IDs. If a belief's body mentions `DECI-2026-03-11-FILE-FIRST`, relink infers a relationship. It goes further: the words *around* the reference hint at the type. "This extends DECI-2026-03-11-FILE-FIRST" becomes an `extends` edge. "See also DECI-2026-03-11-FILE-FIRST" becomes `related`.

Relink runs automatically when an atom is created or updated. The event log captures the extracted relations as part of the atom snapshot, so they're auditable and replayable just like everything else. No silent side effects.

But atom IDs are formal references — the kind you use when you're being precise. People (and agents) are rarely that precise.

### What's in a Name?

Consider the atom ID `DECI-2026-03-11-FILE-FIRST-abc12`. The slug buried in that ID is `FILE-FIRST`. The system extracts that slug and derives a concept name: *"file first"*. It also generates variants — hyphenated, spaced, underscored — so "file-first", "file first", and "file_first" all match.

Now it scans every other atom's body for those concept names. When a belief says "the file first approach proved resilient" — without mentioning any atom ID — the system finds the connection anyway.

### The Informal Network

On a 93-atom store, atom-ID references found 46 citations. Concept-name matching found 160. The informal reference layer was 3.5× larger than the explicit one. More than three out of four connections existed only in natural language, invisible to anything that only looked for formal IDs.

```
Formal atom-ID links:  ██████  46
Concept-name matches:  ████████████████████████  160  (3.5×)
```

These concept-name citations become actual graph edges — the same kind that spreading activation traverses in `wander`. Connections that were locked inside prose now participate in the graph walk. An atom that was isolated because nobody linked to it by ID might turn out to be one of the most-referenced concepts in the store.

If v1.4.0 taught the system which drawer matters most, this taught it that the *contents* of the drawers are a map to each other.

---

## Chapter 22: Memory That Remembers Being Remembered

Chapter 21 gave the system a way to count how often each atom gets mentioned by others. But it wasn't *using* that signal. A foundational belief cited by 28 other atoms scored the same as a one-off note cited by nothing. The system knew about popularity but treated it as trivia.

Think about how your own memory works. You don't remember a fact because you *decided* to — you remember it because you *used* it. The more you reach for an index card, the more worn the edges get, the faster your fingers find it next time. But if you stop reaching for it, it gradually sinks to the back of the drawer.

### Borrowed From How Brains Work

Cognitive scientists noticed this pattern in human memory decades ago. Anderson and Schooler published a paper in 1991 describing exactly how memory activation rises with use and fades with time. Their finding was simple: both factors matter, and they combine predictably.

The intuition, without the math: **frequency fights decay**. A belief that's been cited 28 times stays accessible long after a belief cited zero times would have faded. You can have an old memory that's still vivid — if you've used it a lot — and a recent memory that's barely there, because you haven't.

The previous version of Memory Kernel only considered how recent an atom was. That turned out to be too aggressive. Knowledge that was important six months ago but still heavily referenced would sink below recently-created trivia. The new approach — borrowed directly from the cognitive science model — fixes this. Age still matters. But being referenced fights against fading.

### Softening the Scale

The raw activation number can range widely — from very low (old, never cited) to very high (recent, heavily cited). That range needs to be squashed into something the rest of the scoring pipeline can use.

The first attempt was a standard squashing function — the kind commonly used in math and machine learning. It worked, but had a problem: atoms at the low end got pushed very close to zero, effectively silencing them. But a low-activation atom might still be the *only* atom that matches a query. You don't want it scoring 2% just because it's not popular.

The fix was to use a softer squash. The low end no longer collapses to zero. An unpopular atom still scores at least 70% of a popular one — it's deprioritised, not erased.

### The Citation Table

All of this needed a new place to live in the speed-cache index. A citations table was added — it tracks which atoms cite which, how many times, and whether the citation was a formal ID reference or an informal concept-name match. That table is what the activation math reads from when it needs to know how "used" each atom has been.

The filing cabinet now has fingerprints on the cards. The more a card has been handled — referenced, extended, cited in passing — the easier it is to find. And the system knows which cards have never been touched.

---

## Chapter 23: Not All Edges Are Equal

By v1.6, the memory graph had edges (Chapter 20), body-text discovery (Chapter 21), and frequency-weighted activation (Chapter 22). But every edge still carried the same weight during spreading activation — something v1.7 would start to fix. An `extends` edge — the developmental backbone of a belief chain — had the same influence as a `related` edge, which is often a residual catch-all for "these two things are vaguely connected."

That's like saying a bridge and a wall both connect two rooms. Technically true. Not equally useful for getting across.

### Machines Talking to Machines

Before tackling edge weights, a smaller change laid groundwork: every CLI command gained a `--json` flag. Human-readable tables are fine for a terminal, but when another program needs to parse the output — a CI pipeline checking closure metrics, a plugin reading recall results — structured JSON is the only sane interface.

The pattern is consistent across all commands: add `--json` to any command and you get structured output instead of a table. If something goes wrong, you get a clean `{"error": "..."}` response and a non-zero exit code. No exceptions, no surprises for the program parsing the output.

### Surprising Collisions

The `wander` command finds collision candidates — pairs of atoms from distant domains that unexpectedly activate together. The original filter for "distant" was simple: different atom types. A belief colliding with a decision? Interesting. A belief colliding with a belief? Probably not.

This was wrong. In a store where 70% of atoms are beliefs, the type-difference filter discarded roughly 90% of potential collisions. Two beliefs with completely disjoint vocabularies — one about deployment strategy, the other about user research methodology — are genuinely surprising together. Their types are the same but their *content* is worlds apart.

The replacement is simpler: measure how many tags two atoms *share* versus how many tags they have combined. If two atoms share no tags at all, they score as maximally different. Only pairs that are at least 70% different qualify as "surprising collisions." This surfaces same-type collisions the old filter would have silently discarded.

### Weighted Edges

The core change was giving each relation type its own weight during spreading activation:

| Relation      | Weight | Why |
|---------------|--------|-----|
| `extends`     | 1.5×   | Developmental backbone — if A extends B, they belong together |
| `caused_by`   | 0.8×   | Narrative arcs — temporal causation matters |
| `supports`    | 0.7×   | Evidence — real but secondary |
| `applied_to`  | 0.6×   | Cross-domain application — moderate signal |
| `contradicts` | 0.4×   | Tension — worth noting, but amplifying contradictions distorts the graph |
| `supersedes`  | 0.3×   | Historical — you rarely want to amplify the superseded version |
| `related`     | 0.3×   | Residual — keep visible but don't let unclassified edges dominate |

These aren't arbitrary. They reflect what each relation type *means* for knowledge retrieval. An `extends` chain is the developmental arc of an idea — you almost always want the full chain. A `supersedes` link points to something that's been replaced — useful for history, dangerous for decision-making.

Three presets package these weights for different modes of exploration. The `constitution` preset amplifies developmental chains (`extends` at 1.5×) — use it when you want to trace how a belief evolved. The `tension` preset amplifies contradictions (`contradicts` at 2.0×) — use it when you're looking for unresolved conflicts. The `narrative` preset amplifies causal arcs (`caused_by` at 2.0×) — use it when you're reconstructing how events unfolded.

### Asking for Help

Even with automatic linking and concept-name extraction, many connections still land as the generic `related` — the system found a link but couldn't tell what *kind*. The `mk enrich-relations` command fixes this by asking a small language model (running on your own machine, no cloud) to reclassify them.

For each `related` connection, the command sends both atoms' text to the model and asks: "Is this an `extends`, `supports`, `contradicts`, `caused_by`, or `supersedes` relationship?" The model answers with a type and a confidence number. Only answers above 70% confidence get accepted. A `--dry-run` flag lets you preview everything before any change gets written.

This is the first time Memory Kernel calls an AI model for its own maintenance. Everything else — automatic linking, citation counting, the wandering recall, the closure metric — is pure bookkeeping, no model needed. Enrich-relations is optional: the system works fine without it, but the connection graph gets sharper with it.

---

## Chapter 24: The Closure Test

*(v1.9 shipped `mk closure` as its headline feature.)*

When does a journal stop being a collection of notes and start being a *worldview*?

There's a tipping point. Early on, atoms are independent — each one stands on its own, can be understood in isolation, moved to another agent's memory without losing meaning. But as the store grows, atoms begin to reference each other. A belief about deployment strategy mentions a decision about infrastructure. That decision references a constraint from the security review. The constraint links back to the original belief.

At some point, the entries become so tangled that removing any one of them breaks the meaning of several others. The system is no longer a filing cabinet with independent cards — it's a web where every card is partly defined by its neighbours.

The sociologist Niklas Luhmann had a name for this: **operational closure**. A system that responds based on its own internal structure rather than external input. His card-index system (the Zettelkasten) famously reached this state — the cards referred to each other so densely that the system could "surprise" him, surfacing connections he hadn't consciously made.

### Measuring Self-Reference

The `mk closure` command computes how self-referential a memory store has become. The core metric combines two signals:

**Type composition** — what fraction of atoms are beliefs? Beliefs are inherently self-referential: they describe the system's own understanding, and they tend to reference other beliefs, decisions, and constraints. A store that's 80% facts is a database. A store that's 80% beliefs is a worldview.

**Entanglement** — how many cross-references exist per atom? Not just explicit relations from the index, but body-text references found by the citation scanner from Chapter 21.

The closure index combines both signals into one number, roughly on a scale from 0 to 10. A store that's 80% beliefs with an average of 3 formal connections and 2 informal body-text references per atom scores about 4.0. A store that's mostly isolated facts with few connections stays near 0. The scale is rough on purpose — small changes don't matter, big shifts do.

### The Three Phases

Memory stores grow through three phases, like an organism developing:

**Early** (under 20 atoms) — too small to measure. The sample size is insufficient for any structural conclusion. The system reports the phase honestly rather than guessing.

**Type-composition** (beliefs under 60%) — the store is still mostly external knowledge: facts, decisions, constraints gathered from the world. It has structure but not self-reference. Atoms are portable and classifiable.

**Entanglement** (beliefs at 60%+ and cross-references growing) — the store has become primarily self-referential. Beliefs describe the system's own understanding in terms of other beliefs. The closure index climbs as entanglement deepens.

The daily trajectory mode shows this evolution over time — each day's snapshot plotted on a timeline, phase transitions visible as inflection points.

### What Closure Predicts

Closure isn't good or bad. It's a measurement of structural maturity that predicts specific things:

**Can a small AI classifier still understand these atoms on its own?** At closure below 3, yes. A small model can read a belief and correctly categorise it, extract its key claims, or suggest connections. Above 5, accuracy drops below 55% in our observational measurements (these are not controlled experiments — the exact threshold depends on which classifier you use). The direction is what matters: the text has become so self-referential — beliefs described in terms of other beliefs — that any classifier looking at one atom in isolation gets confused.

**Can you copy a belief to a different project and have it still make sense?** At low closure, yes — atoms can be transplanted between agents and retain their meaning. Above closure 5, 87% or more of beliefs fail direct transplant. They reference concepts that only exist in the source store. *"file-first proved resilient under the deployment-rollback constraint"* is meaningless to an agent that has never seen the deployment-rollback constraint.

**What about pure structural measures — counting connections, mapping reach, spotting hubs?** Those work at any closure level, because they only look at the shape of the connection graph, not the meaning of the text. This is why the wandering recall (which walks connections) remains effective no matter how self-referential the store gets: it traverses structure, not semantics.

The closure index doesn't tell you whether your memory store is good or bad. It tells you whether it has become *its own thing* — and what that means for anything that tries to touch it from the outside.

---

## Chapter 25: Going to Production

*(v1.12 was the "move-in day" release: production infrastructure here in Chapter 25 and per-agent isolation in Chapter 26 — both shipped together.)*

Everything up to Chapter 24 was the library and the CLI: tools you run in a terminal, test with `npm test`, and integrate however you see fit. The system worked. But working and being *production-ready* are different problems.

Building a filing cabinet in a workshop is one thing. Installing it in a busy office where multiple agents need it simultaneously, where secrets can't be inlined in config files, and where the host framework needs to know exactly what happened during bootstrap — that's production.

### Secrets and Signals

The first production problem was configuration. The OpenClaw plugin needs an encryption key and optionally a key to call an external service for semantic search. In development, you write these as plain strings. In production — where the service configuration file might be checked into version control or visible to other processes on the machine — you really don't want the actual secret sitting there in plain text.

SecretRef solves this. Instead of writing `"embeddingApiKey": "sk-abc123"` (the real key, in the config), you write something like: *"the key lives in this file, go fetch it."*

```json
{
  "embeddingApiKey": {
    "source": "file",
    "provider": "vault",
    "id": "/run/secrets/embedding-key"
  }
}
```

When the plugin starts, it follows the pointer, reads the actual secret from the target file, and uses it. The config file itself never contains the secret — it only contains a map to where the secret lives. The pointer format is deliberately simple: step into this field, then that one. No fancy paths, no embedded code, nothing that could surprise you.

The second problem was observability. When the plugin bootstraps — loading atoms into the agent's context at session start — the host needs to know what happened. Did it inject 47 atoms? Zero atoms because the store is empty? Did it fail because the directory doesn't exist?

Bootstrap now emits visible signals via `event.messages`: "Injected 47 atoms into context", "No atoms yet — memory store is empty", or specific error messages. The host can read these and make fallback decisions. Session IDs from lifecycle events flow into tool audit trails, replacing the hardcoded "unknown" that was there before. Every `mk_remember` call in `events.ndjson` now traces back to the session that created it.

Pre-compaction checkpoint signals complete the observability picture. Before the host runs compaction — asking the agent to save anything worth keeping — the checkpoint captures atom count and token estimate, giving the compaction prompt the data it needs to route content intelligently.

### Two Ways to Search

Until now, recall was keyword-based. It found atoms whose text contained the search words — fast and predictable, but it misses matches by *meaning*. A query for "deployment strategy" won't find an atom titled "release pipeline approach" unless the words happen to overlap.

When the plugin is configured with a semantic search provider (a service that can compare two pieces of text for how similar they *mean*, not just what words they share), recall becomes hybrid. Keyword matches and meaning matches combine into one blended score. If the semantic service isn't available — no API key, no network, provider error — the system quietly falls back to keyword-only recall. No crash, no degraded behaviour, just slightly less coverage.

### The Doctrine

The hardest production problem wasn't technical. It was behavioural.

The machinery was ready. The tools existed. The plugin loaded. But agents kept writing knowledge to markdown files instead of calling `mk_remember`. Compaction routines saved insights back into `memory/*.md` instead of into atoms. The system had a primary memory layer that nobody was using as primary.

The fix was doctrine — explicit operating instructions that tell the host framework *how* to use the tools, not just *that* they exist.

The three-layer model makes the hierarchy clear:

| Layer | Role |
|-------|------|
| **Primary** — memory-kernel | Durable structured knowledge: facts, decisions, constraints, beliefs |
| **Secondary** — transcript search | Exact prior-conversation wording, unstructured legacy notes |
| **Support** — files | Daily logs, raw material, imported docs |

The AGENTS.md template tells the agent to call `mk_context_bundle` at session start. The MEMORY.md template declares memory-kernel atoms as the source of truth. The compaction prompt — the most critical piece — explicitly routes durable content to `mk_remember` *first*, before anything goes to files.

Tool descriptions themselves carry the routing rules. Even if a host's doctrine file lags behind, the agent reads the tool descriptions and picks up the three-layer model from there. Defence in depth: the correct behaviour is encoded in every layer that the agent touches.

### Developmental Arcs

One last change made the output *look* different. Beliefs connected by `extends` relations had always been stored as a graph, but when rendered — in CLAUDE.md, in context bundles, in handoff documents — they appeared as a flat list, sorted by date or score.

Graph-ordered rendering changed this. Beliefs now appear as indented developmental arcs. A root belief sits at the top. The belief that extends it is indented below. The belief that extends *that* sits one level deeper. The developmental history of an idea is visible at a glance — not just what the system believes, but how it got there.

### What v1.12 Represents

v1.0 proved memory-kernel could store and retrieve. v1.4 taught it what matters most. The versions in between taught it to read its own files, count its own citations, weigh its own edges, and measure its own complexity.

v1.12 is the point where it stopped being a library and started being infrastructure. Bolted to the floor, wired into the host, observable from the outside, and governed by a doctrine that says: *this is where knowledge lives.* (The same v1.12 release also introduced per-agent isolation — see the next chapter.)

The test suite at this release — 983 checks — was 983 promises that all of this, from the simplest atom creation to the most tangled closure metric, worked exactly as described. The filing cabinet was no longer in the workshop. It was in the office, and people were using it.

---

## Chapter 26: When Agents Need Their Own Filing Cabinets

The second big feature in v1.12 — shipping in the same release as the production infrastructure from the previous chapter — was per-agent isolation.

Imagine an office with one filing cabinet. Two agents — Alice and Bob — both use it. Alice files a card: "Use Redis for caching." Bob, working a different problem, files: "Use Memcached for caching." Neither knows the other filed anything. Next morning, both cards are in the same drawer, and whoever reads them sees a contradiction that neither agent intended.

This isn't a merge conflict. Merge conflicts happen when two agents deliberately work on the same atom. This is something simpler and more insidious: two agents who shouldn't be sharing a drawer at all, stepping on each other because nobody told the filing cabinet that they're separate people.

### Separate Drawers

The fix is structural. Instead of one shared filing cabinet, each agent gets their own section:

```
The Office Filing Cabinet
├── Alice's Section/          ← Only Alice can file and read here
│   ├── Facts, decisions, beliefs...
│   ├── Her event log
│   └── Her index
├── Bob's Section/            ← Only Bob can file and read here
│   ├── Facts, decisions, beliefs...
│   ├── His event log
│   └── His index
└── The Corkboard/            ← Shared — anyone can pin or read
    └── Explicitly shared cards
```

In the actual system, "Alice's Section" is `agents/alice/`, "Bob's Section" is `agents/bob/`, and "The Corkboard" is `shared/`. A `config.yaml` file at the top says `isolation: per-agent`, and that single setting changes how every command works.

This is all opt-in. If you don't create a config.yaml, if you don't pass an agent ID, everything works exactly as before. One cabinet, one drawer, shared by everyone. The default mode is called "shared" — backward compatible, no surprises.

### Sharing Is Deliberate

When Alice discovers something important that Bob should know, she doesn't give him access to her entire section. She takes a snapshot of that specific card and pins it to the corkboard.

That's what `mk share` does. It copies the card — not the original, a snapshot. If Alice updates her original later, the pinned copy doesn't change. It's frozen in time. If she wants the corkboard to reflect her update, she pins it again. The new pin replaces the old one.

This is intentional. Automatic synchronisation between private and shared would turn isolation into an illusion. The whole point is that sharing is a conscious decision: "I've verified this. Others should see it."

Unpinning is just as deliberate. `mk unshare` removes the card from the corkboard. Alice's original stays in her section untouched.

### Reading Is Inclusive

When Bob needs context — when he runs `mk recall` — the system doesn't just search his section. It searches his section *and* the corkboard, then merges the results. Bob sees his own cards plus anything that's been shared.

If there's a collision — Bob has a card with the same ID as one on the corkboard — Bob's version wins. His private knowledge takes precedence over the shared copy. This matters because Bob might have updated his version with information he hasn't shared yet.

The token budget is applied once, on the merged result. Both sources contribute to filling Bob's context window, and neither source is starved at the expense of the other.

This union recall works for everything: atoms, episodes, even graph walks. When Bob runs `mk wander`, spreading activation traverses his private atoms and shared atoms but never reaches into Alice's section. Alice's private beliefs, her personal preferences, her draft decisions — all invisible to Bob's graph walks.

### Each Agent's Preferences

Alice and Bob don't just have different knowledge — they have different needs. Alice is a research agent. She cares most about beliefs and open questions. Bob is an operations agent. He wants facts and procedures.

Each agent section has a `render.yaml` file that controls how CLAUDE.md is generated for that agent:

```yaml
mode: operational        # Alice might use 'constitutive' instead
max_tokens: 16000
include_shared: true     # Pull in the corkboard
type_weights:
  belief: 0.5
  fact: 1.5
  procedure: 2.0
```

When the system renders Bob's CLAUDE.md, it uses Bob's preferences: heavier weight on facts and procedures, lighter on beliefs. Alice gets the opposite. Same memory system, different lenses.

### Moving Day

You've been running with one shared drawer for months. Thirty agents' worth of knowledge, all mixed together. Now you want to split it up.

The `mk migrate` command offers three approaches:

**Fresh start.** Just flip the switch. Enable per-agent mode, create the shared namespace, and start adding agent sections from scratch. The old cards stay where they are — they don't move, and they're only accessible if you explicitly move them into an agent section or the shared namespace. Clean, but you lose easy access to existing knowledge.

**Partition.** The system reads the event log to figure out who created each card. Alice's events say she created card A, B, and C. Bob's events say he created D, E, and F. Cards G and H have no identifiable creator — they go to a fallback agent (by default, "main"). After partitioning, each agent's section contains exactly the cards they created.

Before moving anything, the system takes a backup — a timestamped copy of all atoms, just in case. The config is written first: if the process crashes mid-migration, the store is already marked as isolated, and re-running migrate will refuse (it's already done). Better to be half-migrated in a known state than to have an ambiguous mess.

**Clone to shared.** Instead of splitting cards between agents, copy everything to the corkboard. Every agent sees all existing knowledge through union recall. New knowledge goes to their private sections. This is the gentlest migration: nothing is lost, nothing is hidden, and agents diverge naturally over time as they accumulate private knowledge.

### Safety

Agent IDs aren't arbitrary strings. They must be alphanumeric, dashes, or underscores — nothing else. No dots. No slashes. No spaces.

This isn't pedantry. An agent ID becomes a directory name: `agents/{agentId}/`. If someone could pass `../../etc/passwd` as an agent ID, the system would try to create a directory outside the memory folder. The ID validation catches this. Every directory operation also checks that the resolved path stays within the base directory — a second layer of defence that catches anything the regex might miss.

### From Filing Cabinet to Office Building

Chapters 1 through 25 described a filing cabinet. One cabinet, one set of drawers, one index. Everything in one place.

Chapter 26 turns the filing cabinet into an office building. Each agent gets their own cabinet in their own room, with a bulletin board in the hallway for shared knowledge. The agents can see their own cabinets and the bulletin board, but not each other's rooms.

The mechanics are the same — atoms, events, typed knowledge, confidence scores, spreading activation. The structure is different — private stores with controlled sharing instead of one shared store.

This matters because agents aren't interchangeable. A research agent and a deployment agent have different jobs, different knowledge, and different priorities. Giving them separate memory isn't just about preventing collisions — it's about letting each agent develop its own understanding without being overwhelmed by knowledge that belongs to someone else.

The test suite grew to cover every new path through isolation: config loading, union recall, share and unshare, migration strategies, graph scoping, render preferences, and the security checks that keep agent sections truly separate. The office building is load-tested. The walls are solid.

---

## Chapter 27: Coda — What's Happened Since

v1.12 was the big-bang release. After the filing cabinet moved into the office, the next three releases sanded down real edges that showed up in daily use.

**v1.13 — Episodes That Earn Their Space.** Before v1.13, session summaries (episodes) were included in recall bulk-style — every candidate episode got added at roughly 800 tokens each, often crowding atoms out of tight budgets. v1.13 changed this: episodes are now ranked the same way atoms are (match + recency), zero-relevance episodes are dropped when you give a task, and episodes never exceed 20% of the token budget. You get fewer but better session memories, and the atom budget no longer gets silently eaten.

**v1.14 — Fixing a Subtle Ranking Bug.** Memory Kernel's search understands that "running" and "run" are the same word (this is called stemming — the same trick Google uses). But the ranking logic had a bug: it measured how "specific" a word was by looking for the exact word in the atom's body. If the search matched via stemming — "running" in the query, "run" in the body — the specificity check would silently fail and the atom would get a false penalty. v1.14 fixed this by making the specificity check go through the same stemming path as the search itself. Rankings now match intuition.

**v1.15 — Teaching the System to Extract and Consolidate.** The biggest question for users was always: *"how do I get my existing knowledge into Memory Kernel without filing everything by hand?"* v1.15 answered it with three new commands:

- **`mk extract`** reads a conversation log (or any piece of text) and asks a language model — either Claude Code running locally, or Ollama on your own machine — to pull out the facts, decisions, preferences, and beliefs worth remembering. It cross-checks against what's already in your store so you don't end up with duplicates. The atoms it creates are marked as *drafts*, not active — they need a second pass before they count.
- **`mk consolidate`** is that second pass. It reviews the draft atoms, shows you what's new, flags possible duplicates of existing active atoms, and lets you promote the ones worth keeping to active status. You can do the whole batch in a single command, or filter by type, or cap the size.
- **`mk lint`** is a health checker. It scans the whole store looking for six categories of trouble: atoms that contradict each other, facts that haven't been updated in months, orphan atoms that nobody links to, near-duplicates, beliefs whose confidence never changes despite repeated updates, and stale `open_question` atoms that should probably be resolved or archived. You get a report grouped by severity. The lint doesn't fix anything — it just tells you where to look.

The pattern across v1.13–v1.15 is clear: v1.12 built the infrastructure; the releases that followed have been about making the infrastructure *easier to live with*. Extract and consolidate close the hardest part of the onboarding loop — getting knowledge *into* the system in the first place. Lint closes the maintenance loop — finding knowledge that's turned stale or redundant. And the episode-ranking fix in v1.13 closes one of the last real-world rough edges in recall itself.

At v1.15, the test suite has grown to around a thousand automated checks across fifty-six test files. Every one of them is a promise: *this works, on every machine, after every change.*

**v1.16–v1.18 — Earning the right to be load-bearing.** What followed v1.15 was an arc of unglamorous but consequential work. v1.16's contribution was the public mirror itself: a separate `memory-kernel` repository on GitHub that external users could read and consume, with development staying in a private repo. The plumbing that kept the two in sync — `scripts/sync-to-public.sh` — became the quiet backbone of every release after. v1.18 then tightened the system itself in three directions at once: a sweep of security hardening (path traversal, store-file permissions tightened to `0o600`, transaction wrappers around every index operation), crash atomicity in the write path so partial writes never corrupt the event log, and the time-of-check / time-of-use race in concurrent supersession that two agents writing the same atom slug at the same moment used to expose. The "agent lifecycle as typed memory" pattern was formalized in v1.18.3 — the seven procedure atoms and one constraint that describe *how an agent should use Memory Kernel* now ship with the system itself, seeded into every new store, so the lifecycle becomes recallable from inside the memory it governs.

**v1.19–v1.21 — Performance and the breaking changes nobody loves.** v1.19 broke things on purpose: the public API surface had drifted, and version 1.19 cleaned it up with a single coordinated set of breaking changes — the kind that's painful once and right forever. v1.19.1 and v1.19.2 then squeezed real performance out of the index path: recall latency dropped sharply on stores in the hundreds-of-atoms range, the regime where Memory Kernel had started to feel its scale. v1.20 added explicit caching for the FTS query rewriter, and v1.21 turned attention to the CLI: agent ops tooling (`mk migrate`, `mk doctor --fix`, JSON error contracts downstream parsers can rely on) and the hardening that turned the CLI from "works on the happy path" into "predictable enough to script around." Boring on paper, transformative in practice.

**v1.22–v1.24 — Getting the queries right.** Three releases tightened recall and the operations around it. v1.22 changed the no-task ordering rule and made fill-mode type-aware (a long-standing rough edge: when recall has budget left after the matched atoms, what should it fill the rest *with*?). v1.23 introduced wrapper-drift detection so anyone who hand-edits an installed `mk` binary gets warned the next time the doctor runs. v1.24 was the cleanup release: a lost-write race between `compactLog` and `appendEvent`, an unbounded BFS frontier in tag-distance computation, the missing `--json` error contracts, packaging metadata hygiene. None of these were headlines; all of them were the kind of thing that bites at 2 AM if you let them. They're gone now.

**v1.25–v1.26 — Going public.** These two releases were preparation for actually showing the system to outsiders. The OpenClaw subpackage got its own publish policy. The public mirror's settings (rulesets, branch protection, social preview) were named explicitly in a docs commit so the operator handoff has a paper trail. The privacy redact-list was expanded to cover internal sync infrastructure and operator docs. The `qs` transitive dependency was force-pinned to clear a CVE. The work isn't visible from outside, but it's the work that *makes* visibility from outside possible.

**v1.27 — The recall-honesty fix.** This was the most consequential bugfix in the v1.x series. `mk recall` had a fallback path that, when no atom matched a query, returned the highest-priority atoms anyway — sorted by status and recency. The result: confidently-irrelevant atoms would surface to an agent that asked *"what do I know about pagination?"* with nothing actually about pagination, and the agent would treat them as scaffolding for an answer it couldn't actually support. The fix restricted the candidate pool to FTS or semantic hits when a `--task` was supplied, expanded one hop along graph relations to catch genuinely-related neighbours, and returned an empty result honestly when neither produced a match. The benchmark on LongMemEval-S (500 items) went from 41.4% to 49.2% overall — a +7.8 percentage-point jump — and the single-session-assistant category, the one that asks the agent to recall its own prior statements, climbed +39.3pp. The fix didn't make recall smarter; it made it honest.

**v1.28 — The vocabulary problem.** Per-layer diagnostics in v1.27's wake exposed something specific: preferences were the worst-performing category, with an 86.7% *"I don't know"* rate. The cause wasn't retrieval — it was extraction. Preferences competed with facts, decisions, and beliefs for the general extraction pass's atom budget, and when they did get extracted, their vocabulary was diluted into generic belief-flavored summaries (*"enjoys healthy food"* instead of *"prefers quinoa and roasted vegetables for meal prep"*). v1.28 added an opt-in `--preference-pass` flag that runs a second LLM call dedicated to preferences alone, enforcing specific vocabulary preservation and structured Subject / Preference / Context fields on every atom it produces. Atoms from both passes are merged before the reconcile loop. The trade-off is roughly a doubling of LLM cost on logs where the flag is on; the payoff is preferences that actually retrieve.

The pattern across v1.16–v1.28 is what infrastructure looks like in its second year. The big-bang releases are behind. What's been happening is the long tail of getting the system to behave well in *all* the cases — including the ones nobody asked about because nobody had hit them yet.

---

## Chapter 28: Where It's Heading — v2

Up to here the story has been about Memory Kernel as it exists. The last chapter — for now — is about what the team has been learning and where the next major version is being pointed.

v2 isn't a build plan. It's a design registry — a folder of decisions, hypotheses, and assumptions in [`docs/v2-design/`](docs/v2-design/) — collected from empirical work (benchmarks, judge experiments, real LongMemEval runs) and from architectural reasoning. Each entry has a status (*confirmed*, *hypothesis*, *rejected*, *assumed*, *superseded*) and links to the evidence behind it. The registry is what you'll see updated long before any v2 code lands.

A few threads from the registry hint at where v2 is being pointed:

**Write-heavy beats read-heavy.** The headline finding from the R12 → R15 experiment: an observer pipeline that compresses conversations into dated observations at *write* time scored 60.8% on LongMemEval, while atom retrieval over the same conversations scored 32.0%. Per-type the gap is starker — personal facts moved from roughly 40% (retrieval-only) to 94% (observer). The implication is that engineering effort should shift to ingestion quality, not retrieval sophistication. Better search cannot compensate for lossy ingestion. (Principle P1; evidence in OBS-001.)

**Two cognitive systems, not one.** The observer compresses meaning and erases time; a separate temporal index preserves time and erases meaning. v1 has one consolidated store. v2's direction is two parallel systems with complementary erasure profiles — modeled on how biological memory consolidation works (Winocur & Moscovitch, 2011). The 45% temporal-reasoning plateau in v1 isn't an engineering failure — it's the natural ceiling of semantic compression. Human memory hits the same wall and compensates with external aids; v2 will do the same.

**Competitive forgetting, not cleanup.** v1's `reflect` is a cleanup pass — it expires by TTL, deduplicates, promotes. v2 reframes this: every recall is a moment of competition between candidates, and atoms that don't get cited slowly lose ground rather than waiting for a TTL to remove them. Cleanup becomes an *emergent* property of use rather than a scheduled chore. (Principle P3; lifecycle entries LIF-005 and LIF-006.)

**Memory is perspectival.** A fact about a customer-facing decision belongs to the operations team's memory; the same fact about how an internal tool failed belongs to the engineering team's memory. v1's per-agent isolation is one ply of this — separate drawers with a shared corkboard. v2 generalizes: each agent has its own *view* of every atom, and contradicting views are negotiated, not silently averaged. (Principles P4 + P5; multi-agent entries MUL-001..004.)

**Three evolutionary stages of lifecycle.** Drawing on a 2026 ACL taxonomy and prior work from the literature (BeliefMem, MemQ, Memini, Benna-Fusi, Kumiho, GEM, MARS, CogniFold), the v2 lifecycle is a six-operation planner — *acquire, integrate, consolidate, reconcile, retire, transmit* — that schedules itself based on store state rather than running on cron. Each operation has a probabilistic confidence trajectory rather than a single confidence score. (Principles P7, P10, P12, P15, P16.)

The v2-design registry is honest about what isn't tested yet. Entries marked *hypothesis* are theoretically grounded but waiting for evidence. *Rejected* entries explain what didn't survive contact with reality. If you want to follow the thinking, [`docs/v2-design/README.md`](docs/v2-design/README.md) is the index.

The shape of the v2 release will depend on which hypotheses get confirmed first. What's certain is that the system's center of gravity is shifting — from a retrieval engine over typed atoms toward a paired write-heavy / temporal-index architecture with empirically-grounded lifecycle scheduling. v1 will keep getting maintained through the transition. v2 will arrive when there's enough confirmed evidence behind it to bet on; not before.

---

## What Next

If you want to **try it in 60 seconds:**

```bash
npx memory-kernel init ./my-memory
npx memory-kernel remember -d ./my-memory --type fact "Production runs Debian 13"
npx memory-kernel recall -d ./my-memory
```

Three commands. You now have a working filing cabinet.

If you're **deciding whether this fits your project,** read [`docs/when-to-choose-memory-kernel.md`](docs/when-to-choose-memory-kernel.md). It's honest about when Memory Kernel is the right tool — and when a plain markdown file or a vector database would serve you better.

If you're **connecting it to Claude, Cursor, or another AI assistant,** read [`docs/openclaw-mcp.md`](docs/openclaw-mcp.md). Five minutes from install to your first `mk_remember` call.

If you're **importing existing notes** (design docs, READMEs, meeting notes), read [`docs/migration.md`](docs/migration.md). Five different starting points, each with concrete commands.

Questions, ideas, or patches are welcome on the issue tracker. The filing cabinet is yours — open the drawer and start filing.
