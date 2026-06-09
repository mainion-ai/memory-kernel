import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Top-level mocks (Fix #4: hoisted before module imports) ────────────────

// vi.hoisted ensures these are available when vi.mock factories run
const { mockSpawn, mockFetch } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockFetch: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: mockSpawn,
}));

vi.stubGlobal('fetch', mockFetch);

import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import { observeConversation, buildObservePrompt } from '../src/observe.js';

let testDir: string;
let logFile: string;

/** Create a mock child process that emits stdout data and closes with code 0. */
function createMockProcess(stdoutData: string, code = 0) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
  };
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();

  // Schedule stdout data + close after spawn returns
  process.nextTick(() => {
    proc.stdout.emit('data', Buffer.from(stdoutData));
    proc.emit('close', code);
  });

  return proc;
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-observe-'));
  fs.mkdirSync(path.join(testDir, 'ENTITIES'), { recursive: true });
  logFile = path.join(testDir, 'conversation.log');
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

const SAMPLE_OBSERVATIONS = `- 🔴 User's name is Alex, works as a software engineer at TechCorp
- 🟡 Prefers TypeScript over JavaScript
- Started learning Rust in January 2026
- Has a dog named Max`;

/** Write a simple log file with given content. */
function writeLog(content: string) {
  fs.writeFileSync(logFile, content, 'utf-8');
}

/** Configure the Claude mock (spawn) to return given output. */
function mockClaudeResponse(output: string) {
  mockSpawn.mockImplementation(() => createMockProcess(output));
}

/** Configure the Ollama mock (fetch) to return given output. */
function mockOllamaResponse(response: string) {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ response }),
  });
}

const LONG_LOG = 'USER: My name is Alex and I work at TechCorp as a software engineer. I really love TypeScript and started learning Rust recently.';

describe('observeConversation', () => {
  it('returns empty result for empty log file', async () => {
    writeLog('');
    const result = await observeConversation({
      logPath: logFile,
      memoryDir: testDir,
    });
    expect(result.observations).toBe('');
    expect(result.written).toBe(false);
  });

  it('returns empty result for very short log', async () => {
    writeLog('Hi there');
    const result = await observeConversation({
      logPath: logFile,
      memoryDir: testDir,
    });
    expect(result.observations).toBe('');
    expect(result.written).toBe(false);
  });

  it('throws for non-existent log file', async () => {
    await expect(
      observeConversation({
        logPath: '/nonexistent/file.log',
        memoryDir: testDir,
      }),
    ).rejects.toThrow('Log file not found');
  });

  it('skips lines when --skip-lines is set', async () => {
    mockSpawn.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        stdin: PassThrough;
      };
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.stdin = new PassThrough();

      // Capture stdin to verify preamble was stripped
      let stdinData = '';
      proc.stdin.on('data', (chunk: Buffer) => { stdinData += chunk.toString(); });
      proc.stdin.on('end', () => {
        if (stdinData.includes('PREAMBLE LINE')) {
          proc.stderr.emit('data', Buffer.from('Preamble should have been skipped'));
          proc.emit('close', 1);
        } else {
          proc.stdout.emit('data', Buffer.from(SAMPLE_OBSERVATIONS));
          proc.emit('close', 0);
        }
      });

      return proc;
    });

    writeLog('PREAMBLE LINE 1\nPREAMBLE LINE 2\nPREAMBLE LINE 3\nUSER: My name is Alex and I work at TechCorp as a software engineer. I prefer TypeScript.');
    const result = await observeConversation({
      logPath: logFile,
      memoryDir: testDir,
      skipLines: 3,
    });
    expect(result.observations).toBe(SAMPLE_OBSERVATIONS);
  });

  it('appends to observations.md with session header', async () => {
    mockClaudeResponse(SAMPLE_OBSERVATIONS);

    writeLog(LONG_LOG);
    const result = await observeConversation({
      logPath: logFile,
      memoryDir: testDir,
      sessionDate: '2026-05-08',
    });

    expect(result.written).toBe(true);
    expect(result.sessionDate).toBe('2026-05-08');

    const obsContent = fs.readFileSync(result.observationsPath, 'utf-8');
    expect(obsContent).toContain('## Session 2026-05-08');
    expect(obsContent).toContain('Alex');
  });

  it('does not write in dry-run mode', async () => {
    mockClaudeResponse(SAMPLE_OBSERVATIONS);

    writeLog(LONG_LOG);
    const result = await observeConversation({
      logPath: logFile,
      memoryDir: testDir,
      dryRun: true,
    });

    expect(result.written).toBe(false);
    expect(result.observations).toBe(SAMPLE_OBSERVATIONS);
    expect(fs.existsSync(result.observationsPath)).toBe(false);
  });

  it('appends to existing observations.md', async () => {
    mockClaudeResponse(SAMPLE_OBSERVATIONS);

    // Pre-populate observations.md
    const obsPath = path.join(testDir, 'observations.md');
    fs.writeFileSync(obsPath, '## Session 2026-05-01\n- Existing observation\n', 'utf-8');

    writeLog(LONG_LOG);
    await observeConversation({
      logPath: logFile,
      memoryDir: testDir,
      sessionDate: '2026-05-08',
    });

    const obsContent = fs.readFileSync(obsPath, 'utf-8');
    expect(obsContent).toContain('## Session 2026-05-01');
    expect(obsContent).toContain('Existing observation');
    expect(obsContent).toContain('## Session 2026-05-08');
    expect(obsContent).toContain('Alex');
  });

  it('uses default session date (today) when not specified', async () => {
    mockClaudeResponse(SAMPLE_OBSERVATIONS);

    writeLog(LONG_LOG);
    const result = await observeConversation({
      logPath: logFile,
      memoryDir: testDir,
    });

    const today = new Date().toISOString().slice(0, 10);
    expect(result.sessionDate).toBe(today);
  });

  it('truncates very long conversations', async () => {
    mockSpawn.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        stdin: PassThrough;
      };
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.stdin = new PassThrough();

      let stdinData = '';
      proc.stdin.on('data', (chunk: Buffer) => { stdinData += chunk.toString(); });
      proc.stdin.on('end', () => {
        if (stdinData.includes('[... truncated]')) {
          proc.stdout.emit('data', Buffer.from('- Conversation was truncated'));
        } else {
          proc.stdout.emit('data', Buffer.from(SAMPLE_OBSERVATIONS));
        }
        proc.emit('close', 0);
      });

      return proc;
    });

    const longContent = 'USER: ' + 'x'.repeat(70000);
    writeLog(longContent);

    const result = await observeConversation({
      logPath: logFile,
      memoryDir: testDir,
    });

    expect(result.observations).toBeTruthy();
  });

  // ── Fix #2/#3: Provider detection and model/temperature forwarding ─────

  it('forwards model and temperature to Claude CLI', async () => {
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      // Verify model was passed in args
      expect(args).toContain('--model');
      expect(args).toContain('claude-sonnet-4-20250514');
      return createMockProcess(SAMPLE_OBSERVATIONS);
    });

    writeLog(LONG_LOG);
    await observeConversation({
      logPath: logFile,
      memoryDir: testDir,
      model: 'claude-sonnet-4-20250514',
      temperature: 0.5,
      dryRun: true,
    });

    expect(mockSpawn).toHaveBeenCalled();
  });

  it('auto-detects Ollama provider from model with colon', async () => {
    mockOllamaResponse(SAMPLE_OBSERVATIONS);

    writeLog(LONG_LOG);
    const result = await observeConversation({
      logPath: logFile,
      memoryDir: testDir,
      model: 'qwen2.5:14b',
      dryRun: true,
    });

    expect(result.observations).toBe(SAMPLE_OBSERVATIONS);
    // fetch was called (Ollama path), not execFile (Claude path)
    expect(mockFetch).toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('uses explicit provider override', async () => {
    mockOllamaResponse(SAMPLE_OBSERVATIONS);

    writeLog(LONG_LOG);
    const result = await observeConversation({
      logPath: logFile,
      memoryDir: testDir,
      provider: 'ollama',
      model: 'llama3',
      dryRun: true,
    });

    expect(result.observations).toBe(SAMPLE_OBSERVATIONS);
    expect(mockFetch).toHaveBeenCalled();
  });

  it('throws when Ollama provider is used without model', async () => {
    writeLog(LONG_LOG);
    await expect(
      observeConversation({
        logPath: logFile,
        memoryDir: testDir,
        provider: 'ollama',
        dryRun: true,
      }),
    ).rejects.toThrow('--model is required when using Ollama provider');
  });

  // ── Fix #8: Ollama fetch path coverage ─────────────────────────────────

  it('handles Ollama API error response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    writeLog(LONG_LOG);
    await expect(
      observeConversation({
        logPath: logFile,
        memoryDir: testDir,
        model: 'qwen2.5:14b',
        dryRun: true,
      }),
    ).rejects.toThrow('Ollama API error: 500');
  });

  it('handles Ollama empty response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    writeLog(LONG_LOG);
    await expect(
      observeConversation({
        logPath: logFile,
        memoryDir: testDir,
        model: 'qwen2.5:14b',
        dryRun: true,
      }),
    ).rejects.toThrow('Ollama returned no response');
  });

  it('passes correct options to Ollama API', async () => {
    mockFetch.mockImplementation(async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      expect(body.model).toBe('qwen2.5:14b');
      expect(body.options.temperature).toBe(0.5);
      expect(body.options.num_predict).toBe(1500);
      expect(body.stream).toBe(false);
      expect(url).toContain('/api/generate');
      return {
        ok: true,
        json: async () => ({ response: SAMPLE_OBSERVATIONS }),
      };
    });

    writeLog(LONG_LOG);
    await observeConversation({
      logPath: logFile,
      memoryDir: testDir,
      model: 'qwen2.5:14b',
      temperature: 0.5,
      maxTokens: 1500,
      dryRun: true,
    });

    expect(mockFetch).toHaveBeenCalled();
  });

  it('uses custom Ollama URL', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      expect(url).toContain('http://custom-ollama:11434');
      return {
        ok: true,
        json: async () => ({ response: SAMPLE_OBSERVATIONS }),
      };
    });

    writeLog(LONG_LOG);
    await observeConversation({
      logPath: logFile,
      memoryDir: testDir,
      model: 'qwen2.5:14b',
      ollamaUrl: 'http://custom-ollama:11434',
      dryRun: true,
    });

    expect(mockFetch).toHaveBeenCalled();
  });
});

describe('observeConversation — document mode (#244)', () => {
  // Long enough to clear the observer's 50-char minimum.
  const DOC =
    '# Design decision\n\nWe chose SQLite over Postgres for the index because the ' +
    'store is single-writer and embeds cleanly. This records the conclusion and rationale.';

  it('uses the document system prompt when mode=document', async () => {
    mockClaudeResponse(SAMPLE_OBSERVATIONS);
    writeLog(DOC);
    const result = await observeConversation({
      logPath: logFile,
      memoryDir: testDir,
      mode: 'document',
    });
    expect(result.written).toBe(true);
    // The system prompt is passed via argv: spawn(bin, [..., '--system-prompt', <prompt>, ...]).
    const args = mockSpawn.mock.calls[0][1] as string[];
    const sysIdx = args.indexOf('--system-prompt');
    expect(sysIdx).toBeGreaterThanOrEqual(0);
    expect(args[sysIdx + 1]).toContain('finished knowledge document');
    expect(args[sysIdx + 1]).not.toContain('conversation session between a user');
  });

  it('uses the conversation system prompt by default (backward compat)', async () => {
    mockClaudeResponse(SAMPLE_OBSERVATIONS);
    writeLog(DOC);
    await observeConversation({ logPath: logFile, memoryDir: testDir });
    const args = mockSpawn.mock.calls[0][1] as string[];
    const sysIdx = args.indexOf('--system-prompt');
    expect(args[sysIdx + 1]).toContain('conversation session between a user');
  });

  it('frames the user prompt noun by mode', () => {
    expect(buildObservePrompt('x', 'document')).toContain('Here is the document to extract');
    expect(buildObservePrompt('x')).toContain('Here is the conversation to extract');
  });
});
