# Memory Kernel — Documentation Visuals (Draft)

Review these and let me know which ones work, what to change, what to add.

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────┐
│                   memory-kernel                 │
│                                                 │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐      │
│   │  retain  │  │  recall  │  │  reflect │      │
│   │          │  │          │  │          │      │
│   │ create   │  │ query    │  │ dedupe   │      │
│   │ update   │  │ filter   │  │ promote  │      │
│   │ archive  │  │ budget   │  │ archive  │      │
│   └────┬─────┘  └────┬─────┘  └────┬─────┘      │
│        │             │             │            │
│  ┌-────▼─────────────▼─────────────▼──-──┐      │
│  │              store                    │      │
│  │  read / write / list / init           │      │
│  └────────────────┬──────────────────────┘      │
│                   │                             │
│  ┌────────────────▼──────────────────────┐      │
│  │           File System                 │      │
│  │  atoms/   events/   views/   ARCHIVE/ │      │
│  └───────────────────────────────────────┘      │
│                   │                             │
│  ┌────────────────▼──────────────────────┐      │
│  │        SQLite Index (optional)        │      │
│  │  Derived cache — rebuild with reindex │      │
│  └───────────────────────────────────────┘      │
└─────────────────────────────────────────────────┘
```

---

## 2. Atom Lifecycle

```
                    ┌─────────┐
                    │  CREATE │
                    └────┬────┘
                         │
                         ▼
                  ┌──────────────┐
           ┌───-─ │    draft     │ ────┐
           │      └──────────────┘     │
           │                           │
     confidence                   confidence
       < 0.9                        ≥ 0.9
           │                           │
           ▼                           ▼
    ┌──────────────┐           ┌──────────────┐
    │    draft     │  reflect  │   active     │
    │  (stays)     │ ────────► │  (promoted)  │
    └──────────────┘           └──────┬───────┘
                                      │
                                      │  reflect finds
                                      │  contradiction or
                                      │  manual archive
                                      │
                                      ▼
                               ┌──────────────┐
                               │  archived    │
                               │  (moved to   │
                               │   ARCHIVE/)  │
                               └──────────────┘
```

---

## 3. The Three Operations

```
 ╔═══════════════════════════════════════════════════════════╗
 ║                     RETAIN                                ║
 ║  "Remember this"                                          ║
 ║                                                           ║
 ║  Input:  type, body, confidence, scope, TTL               ║
 ║  Output: atom file in atoms/                              ║
 ║  Event:  logged in events/                                ║
 ║                                                           ║
 ║  createAtom()  →  FACT, DECISION, BELIEF, PREFERENCE...   ║
 ║  updateAtom()  →  change confidence, add tags, edit body  ║
 ║  archiveAtom() →  move to ARCHIVE/, log event             ║
 ╚═══════════════════════════════════════════════════════════╝

 ╔═══════════════════════════════════════════════════════════╗
 ║                     RECALL                                ║
 ║  "What do I know about X?"                                ║
 ║                                                           ║
 ║  Input:  query (type, status, tags, paths, token budget)  ║
 ║  Output: filtered + sorted atom list                      ║
 ║                                                           ║
 ║  1. Try SQLite index (fast path)                          ║
 ║  2. Fall back to file scan if no index                    ║
 ║  3. Sort: active > draft > deprecated                     ║
 ║  4. Respect token budget (trim to fit)                    ║
 ╚═══════════════════════════════════════════════════════════╝

 ╔═══════════════════════════════════════════════════════════╗
 ║                     REFLECT                               ║
 ║  "Clean up and consolidate"                               ║
 ║                                                           ║
 ║  1. Deduplicate: same-type atoms with similar content     ║
 ║     → keep newer, archive older                           ║
 ║  2. Promote: drafts with confidence ≥ 0.9 → active        ║
 ║  3. Expire: atoms past their TTL → archived               ║
 ║  4. Regenerate views (INDEX.md, etc.)                     ║
 ║  5. Log all actions as events                             ║
 ╚═══════════════════════════════════════════════════════════╝
```

---

## 4. File Layout

```
~/repos/memory/kernel/
│
├── atoms/                          ← Source of truth
│   ├── FACT-2026-03-09-GITHUB-SETUP.md
│   ├── FACT-2026-03-09-IDENTITY.md
│   ├── DECI-2026-03-09-FILE-FIRST-ARCHITECTURE.md
│   ├── BELI-2026-03-09-BUILD-VS-USE-TENSION.md
│   ├── PREF-2026-03-09-COMMUNICATION-STYLE.md
│   └── OPEN-2026-03-09-PERSONAL-PROJECT-CHOICE.md
│
├── ARCHIVE/                        ← Soft-deleted atoms
│   └── (archived atoms moved here)
│
├── events/                         ← Append-only event log
│   └── 2026-03-09.jsonl
│
├── views/                          ← Generated (not edited)
│   └── INDEX.md
│
├── EPISODES/                       ← Session summaries
│   └── 2026-03-09-session-2.md
│
├── EVIDENCE/                       ← Supporting material
│
├── HANDOFF.md                      ← Cross-session context
│
└── .memory-index.db                ← SQLite cache (derived)
```

---

## 5. Atom Anatomy

```
┌──────────────────────────────────────────────┐
│  FACT-2026-03-09-IDENTITY.md                 │
├──────────────────────────────────────────────┤
│                                              │
│  ---                          ← YAML front   │
│  type: FACT                     matter       │
│  status: active                              │
│  confidence: 1.0                             │
│  created_at: 2026-03-09T...                  │
│  updated_at: 2026-03-09T...                  │
│  scope:                                      │
│    tags: [identity, infrastructure]          │
│    paths: [systems/pi, identity]             │
│  ttl: null                                   │
│  ---                                         │
│                                              │
│  ## Fact                        ← Markdown   │
│  I am AL-600, an AI agent         body       │
│  running on a Raspberry Pi 5.                │
│                                              │
│  ## Numbers                                  │
│  - IP: 192.168.1.2                           │
│  - OS: Debian 13 trixie                      │
│  - Born: 2026-03-07                          │
│                                              │
└──────────────────────────────────────────────┘
```

---

## 6. NanoClaw Integration

```
┌─────────────────┐     nightly cron     ┌──-────────────────┐
│  memory-kernel  │ ───────────────────► │    NanoClaw       │
│                 │                      │                   │
│  atoms/         │     mk reflect       │  groups/          │
│  events/        │ ────────────-----──► │   telegram_main/  │
│  views/         │                      │     CLAUDE.md     │
│                 │  render-claude-md.ts │                   │
│                 │ ────────────-----──► │  (loaded at       │
│                 │                      │   session start)  │
│                 │     git push         │                   │
│                 │ ────────────-----──► │                   │
└─────────────────┘                      └──-────────────────┘

                     Daily cycle:
                     23:00 → reflect → render → git push
                     Next session → NanoClaw loads CLAUDE.md
```

---

## 7. Query Flow (Recall)

```
                     recall({ type: "FACT", tags: ["identity"] })
                                      │
                                      ▼
                              ┌───────────────┐
                              │  SQLite index │
                              │   exists?     │
                              └───┬───────┬───┘
                                  │       │
                                yes       no
                                  │       │
                                  ▼       ▼
                           ┌─────────┐  ┌─────────────┐
                           │  SQL    │  │  File scan  │
                           │  query  │  │  listAtoms()│
                           │  (fast) │  │  + filter   │
                           └────┬────┘  └──────┬──────┘
                                │              │
                                ▼              ▼
                         ┌───────────────────────-──┐
                         │  Load atom files         │
                         │  Sort by status priority │
                         │  Trim to token budget    │
                         └────────────┬───────────-─┘
                                      │
                                      ▼
                              ┌───────────────┐
                              │  Atom[]       │
                              └───────────────┘
```

---

**Questions for review:**

1. Which diagrams are clear? Which need rework?
2. Should I add a diagram for the 9 atom types?
3. Want me to convert these to Mermaid (renders nicely on GitHub) or keep ASCII?
4. Any flow I'm missing?

