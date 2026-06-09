/**
 * observe — extract compressed observations from conversation logs.
 *
 * Reads a conversation log, calls an LLM to extract structured observations
 * (personal facts, preferences, temporal events, decisions, relationships),
 * and appends them to {memoryDir}/observations.md.
 *
 * LLM providers:
 *   - Default: claude -p subprocess (Claude Code CLI)
 *   - If --provider ollama or model contains ':': Ollama HTTP API
 *
 * Ported from mk-testbench/harness/mk_adapter.py (observer layer).
 */

import fs from 'fs';
import path from 'path';
import { assertWithinDir, escapeXmlBoundary } from './store.js';
import { callLLM, resolveProvider } from './llm.js';
import type { LLMProvider } from './llm.js';

export type { LLMProvider };

// ── Types ───────────────────────────────────────────────────────────────────

/** What kind of source `observe` is reading. */
export type ObserveMode = 'conversation' | 'document';

export interface ObserveOptions {
  /** Path to the source file (a conversation log, or a KNOWLEDGE/ document). */
  logPath: string;
  /** Memory directory to write observations into. */
  memoryDir: string;
  /**
   * Source kind (#244). 'conversation' (default) extracts what *happened* in a
   * session; 'document' extracts the decisions/conclusions a finished knowledge
   * doc *establishes*. Both append to observations.md — atom creation stays
   * downstream in reflect/remember.
   */
  mode?: ObserveMode;
  /** Session date label for the observations header. */
  sessionDate?: string;
  /** LLM provider: 'claude' (default) or 'ollama'. Auto-detected from model name if omitted. */
  provider?: LLMProvider;
  /** LLM model: omit for claude -p default, or Ollama model e.g. "qwen2.5:14b". */
  model?: string;
  /** Temperature for LLM generation (0.0–1.0). Default: 0.3. */
  temperature?: number;
  /** Max tokens for LLM response. Default: 2000. */
  maxTokens?: number;
  /** Preview without writing. */
  dryRun?: boolean;
  /** Skip first N lines (e.g. CLAUDE.md preamble). */
  skipLines?: number;
  /** Ollama API URL override (default: OLLAMA_URL env var or http://localhost:11434). */
  ollamaUrl?: string;
}

export interface ObserveResult {
  /** The extracted observations text. */
  observations: string;
  /** Session date used in the header. */
  sessionDate: string;
  /** Path to the observations file (even if dry-run). */
  observationsPath: string;
  /** Whether observations were actually written. */
  written: boolean;
}

// ── Prompt ──────────────────────────────────────────────────────────────────

const OBSERVER_SYSTEM_PROMPT = `You are a memory observer. Your job is to extract compressed observations from a conversation session between a user and an AI assistant.

Extract ALL key information that might be asked about later:
- Personal facts (name, job, location, family, education, health, allergies)
- Preferences and stated likes/dislikes (food, travel, tech, hobbies, music, brands, tools, styles)
- Temporal events (started a job, moved, bought something, planned a trip)
- Decisions made or opinions expressed
- Names of people, places, organizations mentioned
- Relationships between entities
- Changes or updates to previously known information
- Skills, knowledge areas, or interests demonstrated

PREFERENCE CAPTURE — pay special attention to stated preferences:
When the user expresses a preference, like, dislike, or comparative choice, capture it with a structured marker:
  PREFERENCE: [subject] — [preference statement] (context: [when/why/situation])
Examples:
  PREFERENCE: coffee — prefers oat milk lattes over regular coffee (context: mentioned during breakfast discussion)
  PREFERENCE: programming languages — prefers TypeScript over Python for backend work (context: discussing project stack choices)
  PREFERENCE: travel — dislikes crowded tourist spots, prefers off-the-beaten-path destinations (context: planning next vacation)
Capture ALL preferences, even seemingly minor ones (favorite colors, food preferences, brand loyalties, tool choices, aesthetic tastes).

Format as dated bullet points. Use priority markers:
- 🔴 Critical identity facts (name, job, family, health conditions)
- 🟡 Preferences and recurring patterns — use PREFERENCE: marker for explicit preferences
- Unmarked = general observations

Be concise but COMPLETE — capture everything that could be asked about later.
Include brief context of HOW things were mentioned (helps answer temporal questions).`;

const DOCUMENT_OBSERVER_SYSTEM_PROMPT = `You are a memory observer reading a finished knowledge document — a design doc, research note, report, or project write-up — NOT a conversation.

Your job is to extract the durable decisions, conclusions, and facts this document establishes, so they can be recalled later without re-reading the whole thing.

Extract:
- Decisions and their rationale ("chose X over Y because Z")
- Conclusions and findings (what was determined, measured, or resolved)
- Facts, constraints, and requirements stated as settled
- Definitions and named concepts the document introduces
- Open questions the document explicitly leaves unresolved
- Relationships and dependencies between the things it describes

Do NOT narrate the document's structure ("section 2 covers…") or summarize what
the author "discusses" — extract the substantive claims themselves, as
standalone statements that make sense out of context.

Format as bullet points. Use priority markers:
- 🔴 Decisions and hard constraints
- 🟡 Conclusions, findings, and definitions
- Unmarked = supporting facts and context

Be concise but COMPLETE — capture every decision or conclusion that could be asked about later.`;

/** System prompt for a given observe mode. */
function systemPromptFor(mode: ObserveMode): string {
  return mode === 'document' ? DOCUMENT_OBSERVER_SYSTEM_PROMPT : OBSERVER_SYSTEM_PROMPT;
}

/**
 * Build the LLM user prompt for observation extraction.
 *
 * Wraps user-controlled `content` in a `<document>` boundary and escapes
 * `<`/`>` in the body so a hostile source cannot close the boundary early and
 * inject model-level instructions. Mirrors the pattern used in `extract.ts`.
 * The lead-in noun follows `mode` ("conversation" vs "document"). Exported for
 * tests; called from `observeConversation`.
 */
export function buildObservePrompt(content: string, mode: ObserveMode = 'conversation'): string {
  const noun = mode === 'document' ? 'document' : 'conversation';
  return `Here is the ${noun} to extract observations from:\n\n<document>\n${escapeXmlBoundary(content)}\n</document>\n\nOutput observations as bullet points:`;
}

// ── Main ────────────────────────────────────────────────────────────────────

/**
 * Run the observer on a conversation log.
 *
 * Reads the conversation, calls an LLM to extract compressed observations,
 * and appends them to {memoryDir}/observations.md.
 */
export async function observeConversation(opts: ObserveOptions): Promise<ObserveResult> {
  const {
    logPath,
    memoryDir,
    mode = 'conversation',
    sessionDate = new Date().toISOString().slice(0, 10),
    provider,
    model,
    temperature = 0.3,
    maxTokens = 2000,
    dryRun = false,
    skipLines = 0,
    ollamaUrl,
  } = opts;

  // ── Read log ──────────────────────────────────────────────────────────
  if (!fs.existsSync(logPath)) {
    throw new Error(`Log file not found: ${logPath}`);
  }

  let conversation = fs.readFileSync(logPath, 'utf-8');

  if (skipLines > 0) {
    const lines = conversation.split('\n');
    conversation = lines.slice(skipLines).join('\n');
  }

  if (!conversation.trim() || conversation.trim().length < 50) {
    return {
      observations: '',
      sessionDate,
      observationsPath: path.join(memoryDir, 'observations.md'),
      written: false,
    };
  }

  // Truncate very long conversations to fit context window
  if (conversation.length > 60000) {
    conversation = conversation.slice(0, 60000) + '\n[... truncated]';
  }

  // ── Call LLM ──────────────────────────────────────────────────────────
  const userPrompt = buildObservePrompt(conversation, mode);
  let observations: string;
  try {
    observations = await callLLM(systemPromptFor(mode), userPrompt, {
      model, temperature, maxTokens, provider, ollamaUrl,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Observer LLM call failed: ${msg}`);
  }

  // ── Write to observations.md ──────────────────────────────────────────
  const obsPath = path.join(memoryDir, 'observations.md');

  // Guard: observations file must be inside memoryDir
  assertWithinDir(memoryDir, obsPath);

  let written = false;
  if (!dryRun && observations.trim()) {
    const result = appendObservationSection(obsPath, sessionDate, observations);
    written = result.written;
  }

  return {
    observations,
    sessionDate,
    observationsPath: obsPath,
    written,
  };
}

/**
 * Append a `## Session ${sessionDate}` block to `obsPath` with idempotency.
 *
 * If the file already contains the header `## Session ${sessionDate}`, the
 * append is skipped and a stderr warning is emitted — this guards against
 * double-appends when the LLM call retries after a crash mid-observation (the
 * observer wrote the section, then the process died before exit, and the user
 * re-ran the same command). The session-date string is the dedup key because
 * it is what's already encoded in the section header; a session-ID-based
 * approach would require changing the header format and breaking backward
 * compat for existing `observations.md` files (see #103).
 *
 * The header check is a substring `.includes()` match on the literal header
 * text — a full markdown re-parse would be overkill for a single-line marker.
 * If the existing file has the header AND the second-run `observations`
 * content differs (e.g. the original run partially completed, was killed,
 * then re-tried), the second-run content is still skipped — the conservative
 * idempotency choice is to miss the second-run content rather than risk
 * double-appending. Users can manually delete the partial section if they
 * want a clean re-run.
 *
 * On the successful-write path, the file is chmoded to 0o600 (best-effort,
 * no-op on Windows) per PR-12 / #138 — observations.md may contain
 * LLM-summarized text derived from any classification of source content, so
 * owner-only is defense-in-depth.
 *
 * @internal Exported for tests in `test/observe-dedup-session.test.ts`.
 */
export function appendObservationSection(
  obsPath: string,
  sessionDate: string,
  observations: string,
): { written: boolean; reason?: 'dedup' } {
  const headerLine = `## Session ${sessionDate}`;

  if (fs.existsSync(obsPath)) {
    const existing = fs.readFileSync(obsPath, 'utf-8');
    if (existing.includes(headerLine)) {
      process.stderr.write(
        `mk: warning: observations.md already contains "${headerLine}" — skipping append (idempotent retry)\n`,
      );
      return { written: false, reason: 'dedup' };
    }
  }

  const section = `\n${headerLine}\n${observations}\n`;
  fs.appendFileSync(obsPath, section, 'utf-8');
  // 0o600 — observations.md may contain LLM-summarized text derived from
  // any classification of source content. Owner-only is defense-in-depth.
  // Best-effort: no-op on Windows; matches the pattern in event-log.ts. See #138.
  try { fs.chmodSync(obsPath, 0o600); } catch { /* best-effort */ }
  return { written: true };
}
