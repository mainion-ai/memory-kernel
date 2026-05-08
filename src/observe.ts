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
import { execFile } from 'child_process';
import { promisify } from 'util';
import { assertWithinDir } from './store.js';

const execFileAsync = promisify(execFile);

// ── Types ───────────────────────────────────────────────────────────────────

export type LLMProvider = 'claude' | 'ollama';

export interface ObserveOptions {
  /** Path to the conversation log file. */
  logPath: string;
  /** Memory directory to write observations into. */
  memoryDir: string;
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
- Preferences (food, travel, tech, hobbies, music, brands)
- Temporal events (started a job, moved, bought something, planned a trip)
- Decisions made or opinions expressed
- Names of people, places, organizations mentioned
- Relationships between entities
- Changes or updates to previously known information
- Skills, knowledge areas, or interests demonstrated

Format as dated bullet points. Use priority markers:
- 🔴 Critical identity facts (name, job, family, health conditions)
- 🟡 Preferences and recurring patterns
- Unmarked = general observations

Be concise but COMPLETE — capture everything that could be asked about later.
Include brief context of HOW things were mentioned (helps answer temporal questions).`;

// ── LLM Providers ───────────────────────────────────────────────────────────

/**
 * Detect provider from model string.
 * Ollama models typically have "name:tag" form (e.g. "qwen2.5:14b").
 * Explicit provider option takes precedence.
 */
function resolveProvider(provider?: LLMProvider, model?: string): LLMProvider {
  if (provider) return provider;
  if (model && model.includes(':')) return 'ollama';
  return 'claude';
}

async function callClaude(
  conversation: string,
  opts: { model?: string; temperature: number; maxTokens: number },
): Promise<string> {
  const claudeBin = process.env.CLAUDE_PATH ?? 'claude';
  const userPrompt = `Here is the conversation to extract observations from:\n\n${conversation}\n\nOutput observations as bullet points:`;

  const args = [
    '-p',
    '--system-prompt', OBSERVER_SYSTEM_PROMPT,
    '--max-tokens', String(opts.maxTokens),
  ];

  // Forward model if explicitly specified (e.g. "claude-sonnet-4-20250514")
  if (opts.model) {
    args.push('--model', opts.model);
  }

  const { stdout } = await execFileAsync(
    claudeBin,
    args,
    {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
      input: userPrompt,
    },
  );

  return stdout.trim();
}

async function callOllama(
  conversation: string,
  opts: { model: string; temperature: number; maxTokens: number; ollamaUrl?: string },
): Promise<string> {
  const prompt = `${OBSERVER_SYSTEM_PROMPT}\n\nHere is the conversation to extract observations from:\n\n${conversation}\n\nOutput observations as bullet points:`;
  const ollamaUrl = opts.ollamaUrl ?? process.env.OLLAMA_URL ?? 'http://localhost:11434';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);

  let resp: Response;
  try {
    resp = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        prompt,
        stream: false,
        options: {
          temperature: opts.temperature,
          num_predict: opts.maxTokens,
        },
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!resp.ok) {
    throw new Error(`Ollama API error: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as { response?: string };
  if (!data.response) {
    throw new Error('Ollama returned no response');
  }

  return data.response.trim();
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
  const resolvedProvider = resolveProvider(provider, model);
  let observations: string;
  try {
    if (resolvedProvider === 'ollama') {
      if (!model) {
        throw new Error('--model is required when using Ollama provider');
      }
      observations = await callOllama(conversation, { model, temperature, maxTokens, ollamaUrl });
    } else {
      observations = await callClaude(conversation, { model, temperature, maxTokens });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Observer LLM call failed: ${msg}`);
  }

  // ── Write to observations.md ──────────────────────────────────────────
  const obsPath = path.join(memoryDir, 'observations.md');

  // Guard: observations file must be inside memoryDir
  assertWithinDir(memoryDir, obsPath);

  if (!dryRun && observations.trim()) {
    const section = `\n## Session ${sessionDate}\n${observations}\n`;
    fs.appendFileSync(obsPath, section, 'utf-8');
  }

  return {
    observations,
    sessionDate,
    observationsPath: obsPath,
    written: !dryRun && observations.trim().length > 0,
  };
}
