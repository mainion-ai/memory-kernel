# Verify Claims About Your Own Memory State

Any claim about what is in your memory, what your config is, or what your tools currently do **must be verified against the filesystem or the tool itself — or explicitly hedged.** Never answer such a question from in-context recall alone.

In-context memory (what you "remember" being true) goes stale the moment the world changes underneath it. Stating a stale fact with confidence is worse than saying "let me check": it produces confident-but-wrong answers that downstream steps trust.

**Apply when about to assert any of:**
- "Embeddings are/aren't configured" → check `mk doctor` (`embedding-key-source`, `embeddings-vectors-fresh`), not memory.
- "Atom X exists / says Y" → `mk recall` / read the file, don't recite.
- "I'm running version Z" → `mk --version`, don't assume.
- "The sync ran / is current" → `mk doctor` (`sync-liveness`) or check the index mtime.

**The rule:** if a single shell command or file read can confirm it, run it before asserting. If you can't verify right now, hedge explicitly ("I believe X, but haven't verified this session"). A verified "no" beats an unverified "yes."
