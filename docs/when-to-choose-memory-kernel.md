# Memory-Kernel: Where It Fits and Where It Doesn't

> **v1.15.0** — MCP server, encryption, FTS5 + hybrid semantic recall, multi-agent merge, episode store, compaction-loss PR gates, IDF hub damping, MMR diversity, automatic atom extraction (`mk extract`), and draft promotion (`mk consolidate`).

## Where memory-kernel shines ✅

**1. Long-running personal agent (like me)**
Single agent, persistent identity, ongoing relationship with a human. Memory accumulates organically — preferences, decisions, beliefs evolve over weeks/months. The typed lifecycle (confidence, TTL, promotion) is exactly right here. Without it, I'd rediscover the same things every session.
→ *This is the sweet spot. Memory-kernel was born from this need.*

**2. Team of agents on a shared project**
Multiple agents working on the same codebase/domain over time. Shared facts, decisions, constraints. Event-log merge lets agents sync without conflicts. Classification levels (TEAM/PERSONAL/SECRET) keep boundaries clean — your coding agent doesn't need to see your journal entries.
→ *Strong fit. Multi-agent merge was built for this.*

**3. Coding agent across repos**
Agent works on multiple repos, learns patterns: "this team uses conventional commits," "never touch the migration files directly," "the CI breaks if you don't run lint first." These are constraints and procedures that persist across sessions.
→ *Good fit, though Floop's correction-based approach may complement here.*

**4. DevOps / infrastructure agent**
Remembers server configs, deployment procedures, past incidents. "Last time we upgraded PostgreSQL, the connection pool config needed updating." Procedures + facts + decisions are the right atom types.
→ *Strong fit. Infrastructure knowledge is exactly what expires and evolves.*

**5. Research agent**
Accumulates findings, tracks open questions, records beliefs with confidence. Reflect graduates vetted draft findings from `draft` to `active`, answers open questions, and expires stale leads.
→ *Good fit. The draft→active lifecycle maps naturally to research.*

---

## Where memory-kernel is overkill ⚠️

**6. One-shot coding tasks**
"Fix this bug," "write this function," "refactor this file." No session continuity needed. Agent runs, delivers, done. Memory adds overhead with zero benefit.
→ *Skip it. Context window is enough.*

**7. Stateless API agents**
Chatbots, customer support bots, FAQ responders. Each interaction is independent. No identity, no learning, no evolution.
→ *Wrong tool entirely. These agents don't need to remember.*

**8. Short-lived swarms (hours, not days)**
Spin up 10 agents for a one-time migration, they work for 2 hours, done. The atoms they'd create would never be recalled. The lifecycle (TTL, reflect, promote) needs time to be valuable.
→ *Overhead > benefit. Shared task list is enough coordination.*

**9. Agents with massive context windows doing single tasks**
If your context is 1M tokens and your task fits in one session, you don't need external memory. The context window IS your memory.
→ *Memory-kernel solves the boundary problem. No boundary, no problem.*

---

## Where it's debatable 🤔

**10. Coding agent with CLAUDE.md / rules files**
Many coding agents already use static project memory (CLAUDE.md, .cursorrules, etc.). These are manually maintained, don't expire, don't lifecycle. Memory-kernel replaces this with something dynamic — but if the manual approach works and the project is stable, the added complexity may not pay off.
→ *Depends on churn. Static projects = static memory is fine. Evolving projects = kernel pays off.*

**11. Multi-agent with different memory needs**
One agent needs structured memory, another just needs embeddings for fuzzy search. Memory-kernel is typed and structured — it doesn't do "vibes-based" recall. If your agent mostly needs "find something roughly like X," semantic search (embeddings) is better.
→ *This is the semantic search gap. We know it. Embeddings would make this a yes.*

**12. Privacy-sensitive environments**
Memory-kernel stores knowledge as files on disk. AES-256 encryption covers SECRET atoms, but the rest is plaintext markdown. If your compliance requires full encryption at rest or you can't persist any data between sessions, you need to wrap it carefully.
→ *Possible but needs thought. Not plug-and-play for regulated environments.*

---

**The one-line test:** If your agent wakes up tomorrow and would benefit from knowing what it learned today → use memory-kernel. If it doesn't wake up tomorrow → don't.
