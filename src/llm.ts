/**
 * llm — shared LLM abstraction layer.
 *
 * Provides a unified interface for calling LLMs via:
 *   - Claude CLI subprocess (`claude -p`)
 *   - Ollama HTTP API (`/api/generate`)
 *
 * Both observe.ts and extract.ts use this module instead of
 * maintaining their own provider implementations.
 */

import { spawn } from 'child_process';

// ── Types ───────────────────────────────────────────────────────────────────

export type LLMProvider = 'claude' | 'ollama';

export interface CallLLMOptions {
  /** LLM model identifier. Required for Ollama, optional for Claude. */
  model?: string;
  /** Explicit provider override. Auto-detected from model name if omitted. */
  provider?: LLMProvider;
  /** Temperature for generation (0.0–2.0). */
  temperature?: number;
  /** Max tokens for response. */
  maxTokens?: number;
  /** Ollama API URL override. Falls back to OLLAMA_URL env or http://localhost:11434. */
  ollamaUrl?: string;
}

// ── Provider Detection ──────────────────────────────────────────────────────

/**
 * Detect provider from explicit option or model string.
 * Ollama models typically have "name:tag" form (e.g. "qwen2.5:14b").
 * Explicit provider option takes precedence.
 */
export function resolveProvider(provider?: LLMProvider, model?: string): LLMProvider {
  if (provider) return provider;
  if (model && model.includes(':')) return 'ollama';
  return 'claude';
}

// ── LLM Call ────────────────────────────────────────────────────────────────

/**
 * Call an LLM with a system prompt and user prompt.
 * Returns the raw text response.
 *
 * Provider is auto-detected from model name (colon → Ollama) unless
 * explicitly set via opts.provider.
 */
export async function callLLM(
  systemPrompt: string,
  userPrompt: string,
  opts: CallLLMOptions = {},
): Promise<string> {
  const resolved = resolveProvider(opts.provider, opts.model);

  if (resolved === 'ollama') {
    return callOllama(systemPrompt, userPrompt, opts);
  }
  return callClaude(systemPrompt, userPrompt, opts);
}

// ── Claude CLI ──────────────────────────────────────────────────────────────

async function callClaude(
  systemPrompt: string,
  userPrompt: string,
  opts: CallLLMOptions,
): Promise<string> {
  const claudeBin = process.env.CLAUDE_PATH ?? 'claude';

  const args = [
    '-p',
    '--output-format', 'text',
    '--system-prompt', systemPrompt,
  ];

  // Note: Claude CLI does not support --max-tokens; only Ollama uses it.

  if (opts.model) {
    args.push('--model', opts.model);
  }

  // User prompt is piped via stdin (not as a positional arg) because
  // extract.ts sends full conversation logs that can exceed the ~128KB
  // ARG_MAX limit on Linux/macOS. See commit f3afa4186c.
  return new Promise<string>((resolve, reject) => {
    const proc = spawn(claudeBin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120_000,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`claude -p exited with code ${code}: ${stderr}`));
      }
      resolve(stdout.trim());
    });

    // Write user prompt to stdin and close.
    proc.stdin.write(userPrompt);
    proc.stdin.end();
  });
}

// ── Ollama HTTP API ─────────────────────────────────────────────────────────

async function callOllama(
  systemPrompt: string,
  userPrompt: string,
  opts: CallLLMOptions,
): Promise<string> {
  if (!opts.model) {
    throw new Error('--model is required when using Ollama provider');
  }

  const prompt = `${systemPrompt}\n\n${userPrompt}`;
  const ollamaUrl = opts.ollamaUrl ?? process.env.OLLAMA_URL ?? 'http://localhost:11434';

  const body: Record<string, unknown> = {
    model: opts.model,
    prompt,
    stream: false,
  };

  // Pass options only when explicitly set
  const ollamaOpts: Record<string, unknown> = {};
  if (opts.temperature !== undefined) ollamaOpts.temperature = opts.temperature;
  if (opts.maxTokens !== undefined) ollamaOpts.num_predict = opts.maxTokens;
  if (Object.keys(ollamaOpts).length > 0) body.options = ollamaOpts;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);

  let resp: Response;
  try {
    resp = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
