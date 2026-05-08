import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initMemoryDir, closeAllIndexes, openIndex, listAtoms } from '../src/index.js';
import { extractFromLog } from '../src/extract.js';

let testDir: string;
let logFile: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-extract-'));
  initMemoryDir(testDir);
  openIndex(testDir);
  logFile = path.join(testDir, 'conversation.log');
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Mock execFileSync to return a fixed JSON response. */
function mockClaude(candidates: object[]) {
  return vi.mock('child_process', () => ({
    execFileSync: () => JSON.stringify(candidates),
    execFile: vi.fn(),
  }));
}

/** Write a simple log file with given content. */
function writeLog(content: string) {
  fs.writeFileSync(logFile, content, 'utf-8');
}

const SAMPLE_CANDIDATES = [
  {
    type: 'fact',
    slug: 'api-rate-limit',
    title: 'API rate limit is 1000 RPM',
    body: '## Fact\nThe API rate limit is 1000 requests per minute.',
    tags: ['api', 'limits'],
    confidence: 1.0,
    rationale: 'This is a concrete operational fact worth remembering.',
  },
  {
    type: 'decision',
    slug: 'use-typescript',
    title: 'Use TypeScript for the project',
    body: '## Decision\nWe decided to use TypeScript because of strong typing and npm ecosystem.',
    tags: ['typescript', 'architecture'],
    confidence: 1.0,
    rationale: 'A key architectural decision made during the session.',
  },
];

describe('extractFromLog', () => {
  it('returns empty result for empty log file', async () => {
    writeLog('');

    const result = await extractFromLog({
      logPath: logFile,
      memoryDir: testDir,
      dryRun: true,
    });

    expect(result.extracted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.atoms).toHaveLength(0);
  });

  it('returns empty result for whitespace-only log file', async () => {
    writeLog('   \n\n   ');

    const result = await extractFromLog({
      logPath: logFile,
      memoryDir: testDir,
      dryRun: true,
    });

    expect(result.extracted).toBe(0);
    expect(result.atoms).toHaveLength(0);
  });

  it('dry-run does not write atoms to disk', async () => {
    writeLog('Some conversation content here.');

    // Use Ollama path so we can mock fetch
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ response: JSON.stringify(SAMPLE_CANDIDATES) }),
    } as Response);

    const result = await extractFromLog({
      logPath: logFile,
      memoryDir: testDir,
      model: 'test-model:latest', // Ollama path
      dryRun: true,
    });

    expect(result.extracted).toBe(2);
    // No atoms written to disk
    const atoms = listAtoms(testDir);
    expect(atoms).toHaveLength(0);
  });

  it('writes atoms as draft status when not dry-run', async () => {
    writeLog('User: What is the API rate limit?\nAssistant: The API rate limit is 1000 RPM.');

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ response: JSON.stringify(SAMPLE_CANDIDATES) }),
    } as Response);

    const result = await extractFromLog({
      logPath: logFile,
      memoryDir: testDir,
      model: 'test-model:latest',
      dryRun: false,
      agentId: 'test-agent',
      sessionId: 'test-session',
    });

    expect(result.extracted).toBe(2);

    // All atoms should be written as draft
    const atoms = listAtoms(testDir);
    expect(atoms).toHaveLength(2);
    for (const atom of atoms) {
      expect(atom.frontmatter.status).toBe('draft');
      expect(atom.frontmatter.scope?.tags).toContain('auto-extracted');
    }
  });

  it('skips atoms with invalid types', async () => {
    const candidates = [
      {
        type: 'invalid_type',
        slug: 'test-slug',
        title: 'Test',
        body: '## Test\nSome content.',
        confidence: 0.9,
        rationale: 'Test.',
      },
      ...SAMPLE_CANDIDATES,
    ];

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ response: JSON.stringify(candidates) }),
    } as Response);

    writeLog('Some conversation.');

    const result = await extractFromLog({
      logPath: logFile,
      memoryDir: testDir,
      model: 'test-model:latest',
      dryRun: true,
    });

    expect(result.skipped).toBe(1);
    expect(result.extracted).toBe(2);

    const skipped = result.atoms.filter((a) => a.status === 'skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toMatch(/invalid atom type/i);
  });

  it('skips atoms with duplicate slugs', async () => {
    writeLog('User: Remember this fact.\nAssistant: Noted.');

    // First extraction — writes atoms
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ response: JSON.stringify([SAMPLE_CANDIDATES[0]]) }),
    } as Response);

    await extractFromLog({
      logPath: logFile,
      memoryDir: testDir,
      model: 'test-model:latest',
      dryRun: false,
    });

    // Second extraction — same slug should be skipped
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ response: JSON.stringify([SAMPLE_CANDIDATES[0]]) }),
    } as Response);

    const result2 = await extractFromLog({
      logPath: logFile,
      memoryDir: testDir,
      model: 'test-model:latest',
      dryRun: false,
    });

    expect(result2.skipped).toBe(1);
    const skipped = result2.atoms.filter((a) => a.status === 'skipped');
    expect(skipped[0].reason).toBe('slug exists');
  });

  it('respects --skip-lines option', async () => {
    // Log with 3 lines of preamble then actual content
    writeLog('PREAMBLE LINE 1\nPREAMBLE LINE 2\nPREAMBLE LINE 3\nActual content starts here.');

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ response: '[]' }),
    } as Response);

    let capturedPrompt = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, opts) => {
      const body = JSON.parse((opts?.body as string) ?? '{}');
      capturedPrompt = body.prompt ?? '';
      return {
        ok: true,
        json: async () => ({ response: '[]' }),
      } as Response;
    });

    await extractFromLog({
      logPath: logFile,
      memoryDir: testDir,
      model: 'test-model:latest',
      skipLines: 3,
      dryRun: true,
    });

    expect(capturedPrompt).not.toContain('PREAMBLE LINE 1');
    expect(capturedPrompt).toContain('Actual content starts here.');
  });

  it('throws on missing log file', async () => {
    await expect(
      extractFromLog({
        logPath: '/nonexistent/path/conversation.log',
        memoryDir: testDir,
        model: 'test-model:latest',
        dryRun: true,
      }),
    ).rejects.toThrow(/log file not found/i);
  });

  it('extraction prompt includes assistant-content capture instructions', async () => {
    writeLog('User: What should I use?\nAssistant: I recommend TypeScript for type safety.');

    let capturedPrompt = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, opts) => {
      const body = JSON.parse((opts?.body as string) ?? '{}');
      capturedPrompt = body.prompt ?? '';
      return {
        ok: true,
        json: async () => ({ response: '[]' }),
      } as Response;
    });

    await extractFromLog({
      logPath: logFile,
      memoryDir: testDir,
      model: 'test-model:latest',
      dryRun: true,
    });

    // Verify the prompt instructs the LLM to capture assistant-generated content
    expect(capturedPrompt).toContain('assistant-generated content');
    expect(capturedPrompt).toContain('role:assistant');
    expect(capturedPrompt).toContain('Recommendations and suggestions the assistant made');
    expect(capturedPrompt).toContain('Advice or explanations the assistant provided');
    expect(capturedPrompt).toContain('For assistant responses');
    expect(capturedPrompt).toContain('Tag assistant-generated atoms with "role:assistant"');
  });
});
