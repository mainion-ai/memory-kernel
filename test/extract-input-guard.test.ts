import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initMemoryDir, closeAllIndexes, openIndex } from '../src/index.js';
import {
  extractFromLog,
  planExtractInput,
  buildExtractPrompt,
  ExtractInputTooLargeError,
  DEFAULT_MAX_INPUT_CHARS,
} from '../src/extract.js';

let testDir: string;
let logFile: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-extract-guard-'));
  initMemoryDir(testDir);
  openIndex(testDir);
  logFile = path.join(testDir, 'conversation.log');
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * Spy on the Ollama HTTP path so an extract run never reaches a real LLM.
 * Returns an empty-candidate array so extraction completes cleanly.
 */
function spyOllama(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({ response: '[]' }),
  } as unknown as Response);
}

describe('planExtractInput (pure)', () => {
  it('returns the prompt unchanged when the assembled input fits the budget', () => {
    const plan = planExtractInput('hello world', 100);
    expect(plan.truncation).toBeUndefined();
    expect(plan.userPrompt).toBe(buildExtractPrompt('hello world'));
  });

  it('throws a typed, actionable error when over budget and not truncating', () => {
    const content = 'x'.repeat(1000);
    let thrown: unknown;
    try {
      planExtractInput(content, 100, { maxInputChars: 200 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ExtractInputTooLargeError);
    const e = thrown as ExtractInputTooLargeError;
    expect(e.code).toBe('INPUT_TOO_LARGE');
    expect(e.limit).toBe(200);
    expect(e.inputChars).toBe(100 + buildExtractPrompt(content).length);
    // The message must tell the operator how to recover.
    expect(e.message).toContain('--skip-lines');
    expect(e.message).toContain('--truncate');
    expect(e.message).toContain('--max-input-chars');
  });

  it('applies DEFAULT_MAX_INPUT_CHARS when no explicit limit is given', () => {
    // Comfortably under the default → no throw.
    expect(() => planExtractInput('x'.repeat(1000), 100)).not.toThrow();
    // Past the default → throws, and reports the default as the limit.
    let thrown: unknown;
    try {
      planExtractInput('x'.repeat(DEFAULT_MAX_INPUT_CHARS + 10_000), 0);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ExtractInputTooLargeError);
    expect((thrown as ExtractInputTooLargeError).limit).toBe(DEFAULT_MAX_INPUT_CHARS);
  });

  it('keeps the newest (tail) content, drops the oldest (head), and respects the budget when truncating', () => {
    const head = 'HEADSENTINEL';
    const tail = 'TAILSENTINEL';
    const content = head + 'x'.repeat(10_000) + tail;
    const systemPromptChars = 100;
    const maxInputChars = 2000;
    const plan = planExtractInput(content, systemPromptChars, { maxInputChars, truncate: true });

    expect(plan.truncation).toBeDefined();
    const t = plan.truncation!;
    expect(t.original_chars).toBe(content.length);
    expect(t.sent_chars).toBeGreaterThan(0);
    expect(t.sent_chars).toBeLessThan(content.length);
    expect(t.omitted_chars).toBe(t.original_chars - t.sent_chars);

    // The assembled prompt actually fits the declared budget.
    expect(systemPromptChars + plan.userPrompt.length).toBeLessThanOrEqual(maxInputChars);
    // Newest content is preserved, oldest is dropped (keep-tail for session-end extraction).
    expect(plan.userPrompt).toContain(tail);
    expect(plan.userPrompt).not.toContain(head);
    // A visible marker tells the model the older content was dropped.
    expect(plan.userPrompt).toContain('truncated');
    expect(plan.userPrompt).toContain('omitted from the beginning');
    expect(plan.userPrompt).toContain(String(t.omitted_chars));
  });

  it('never splits a UTF-16 surrogate pair when truncating astral-plane content', () => {
    // Each 😀 is two UTF-16 code units; a naive code-unit cut can land mid-pair
    // and leave a lone surrogate that renders as mojibake. The keep-tail slice
    // must always start on a code-point boundary.
    const content = '😀'.repeat(5000); // 10_000 code units, all valid pairs
    const systemPromptChars = 100;
    const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

    // Scan a band of budgets so the internal cut hits both aligned and mis-aligned
    // seams (the per-iteration overflow alternates parity across consecutive budgets);
    // without the surrogate guard at least one odd budget yields a lone surrogate.
    for (let maxInputChars = 1200; maxInputChars <= 1260; maxInputChars++) {
      const plan = planExtractInput(content, systemPromptChars, { maxInputChars, truncate: true });
      expect(systemPromptChars + plan.userPrompt.length).toBeLessThanOrEqual(maxInputChars);
      expect(LONE_SURROGATE.test(plan.userPrompt)).toBe(false);
    }
  });

  it('still throws under --truncate when the budget cannot fit even the system prompt', () => {
    // systemPromptChars (5000) alone dwarfs the 100-char budget — truncation cannot rescue it.
    expect(() =>
      planExtractInput('x'.repeat(10_000), 5000, { maxInputChars: 100, truncate: true }),
    ).toThrow(ExtractInputTooLargeError);
  });
});

describe('extractFromLog input guard (integration)', () => {
  it('fails pre-flight before any LLM call when the input is too large', async () => {
    fs.writeFileSync(logFile, 'x'.repeat(50_000), 'utf-8');
    const fetchSpy = spyOllama();

    await expect(
      extractFromLog({
        logPath: logFile,
        memoryDir: testDir,
        model: 'test-model:latest',
        maxInputChars: 100,
      }),
    ).rejects.toBeInstanceOf(ExtractInputTooLargeError);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('proceeds and reports truncation when --truncate is set', async () => {
    fs.writeFileSync(logFile, 'x'.repeat(1_000_000), 'utf-8');
    const fetchSpy = spyOllama();

    const result = await extractFromLog({
      logPath: logFile,
      memoryDir: testDir,
      model: 'test-model:latest',
      maxInputChars: 100_000,
      truncate: true,
    });

    expect(fetchSpy).toHaveBeenCalled();
    expect(result.truncation).toBeDefined();
    expect(result.truncation!.original_chars).toBe(1_000_000);
    expect(result.truncation!.omitted_chars).toBeGreaterThan(0);
    expect(result.truncation!.sent_chars).toBeLessThan(1_000_000);
  });

  it('does not attach a truncation field for normally-sized input', async () => {
    fs.writeFileSync(logFile, 'A short conversation about the deploy pipeline.', 'utf-8');
    spyOllama();

    const result = await extractFromLog({
      logPath: logFile,
      memoryDir: testDir,
      model: 'test-model:latest',
      maxInputChars: 1_000_000,
    });

    expect(result.truncation).toBeUndefined();
  });
});
