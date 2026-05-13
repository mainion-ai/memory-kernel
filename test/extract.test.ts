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

/** Mock Claude CLI (execFile async) to return a fixed JSON response. */
function mockClaude(candidates: object[]) {
  return vi.mock('child_process', () => ({
    execFile: (_cmd: string, _args: string[], _opts: unknown, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
      callback(null, JSON.stringify(candidates), '');
    },
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

  it('writes preference atoms with structured body and subject tag', async () => {
    const prefCandidate = {
      type: 'preference',
      slug: 'prefers-oat-milk',
      title: 'Prefers oat milk in coffee',
      body: '## Preference\nPrefers oat milk.',
      subject: 'coffee',
      preference: 'prefers oat milk lattes',
      context: 'mentioned during morning routine discussion',
      tags: ['food'],
      confidence: 1.0,
      rationale: 'Personal preference worth remembering.',
    };

    writeLog('User: I always get oat milk in my lattes.\nAssistant: Noted, you prefer oat milk.');

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ response: JSON.stringify([prefCandidate]) }),
    } as Response);

    const result = await extractFromLog({
      logPath: logFile,
      memoryDir: testDir,
      model: 'test-model:latest',
      dryRun: false,
      agentId: 'test-agent',
      sessionId: 'test-session',
    });

    expect(result.extracted).toBe(1);
    const atoms = listAtoms(testDir);
    expect(atoms).toHaveLength(1);

    const atom = atoms[0];
    expect(atom.frontmatter.type).toBe('preference');
    expect(atom.frontmatter.status).toBe('draft');

    // Structured body with template
    expect(atom.body).toContain('## Preference');
    expect(atom.body).toContain('**Subject:** coffee');
    expect(atom.body).toContain('**Preference:** prefers oat milk lattes');
    expect(atom.body).toContain('**Context:** mentioned during morning routine discussion');

    // Subject tag added
    expect(atom.frontmatter.scope?.tags).toContain('subject:coffee');
    expect(atom.frontmatter.scope?.tags).toContain('auto-extracted');
    expect(atom.frontmatter.scope?.tags).toContain('food');
  });

  it('does not enrich non-preference atoms with preference template', async () => {
    writeLog('User: The API rate limit is 1000 RPM.');

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ response: JSON.stringify([SAMPLE_CANDIDATES[0]]) }),
    } as Response);

    const result = await extractFromLog({
      logPath: logFile,
      memoryDir: testDir,
      model: 'test-model:latest',
      dryRun: false,
    });

    expect(result.extracted).toBe(1);
    const atoms = listAtoms(testDir);
    const atom = atoms[0];
    expect(atom.frontmatter.type).toBe('fact');
    // Body should be unchanged — no preference template
    expect(atom.body).toContain('The API rate limit is 1000 requests per minute.');
    expect(atom.body).not.toContain('**Subject:**');
    // No subject tag
    const subjectTags = (atom.frontmatter.scope?.tags ?? []).filter((t: string) => t.startsWith('subject:'));
    expect(subjectTags).toHaveLength(0);
  });

  it('falls back to original body when preference atom lacks subject/preference fields', async () => {
    const partialPrefCandidate = {
      type: 'preference',
      slug: 'likes-dark-mode',
      title: 'Likes dark mode',
      body: '## Preference\nUser likes dark mode in all editors.',
      tags: ['ui'],
      confidence: 1.0,
      rationale: 'UI preference.',
      // no subject, preference, or context fields
    };

    writeLog('User: I like dark mode in all my editors.');

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ response: JSON.stringify([partialPrefCandidate]) }),
    } as Response);

    const result = await extractFromLog({
      logPath: logFile,
      memoryDir: testDir,
      model: 'test-model:latest',
      dryRun: false,
    });

    expect(result.extracted).toBe(1);
    const atoms = listAtoms(testDir);
    const atom = atoms[0];
    expect(atom.frontmatter.type).toBe('preference');
    // Body should be the original, not the structured template
    expect(atom.body).toContain('User likes dark mode in all editors.');
    expect(atom.body).not.toContain('**Subject:**');
  });

  it('extraction prompt includes preference-capture instructions', async () => {
    writeLog('User: I prefer TypeScript over Python.');

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

    // Verify the prompt instructs the LLM to capture preferences
    expect(capturedPrompt).toContain('For PREFERENCE atoms specifically');
    expect(capturedPrompt).toContain('"subject", "preference", and "context"');
    expect(capturedPrompt).toContain('subject:<topic>');
    expect(capturedPrompt).toContain('I prefer');
    expect(capturedPrompt).toContain('my favorite');
    expect(capturedPrompt).toContain('PREFERENCE: markers');
  });

  it('normalizes subject tag to lowercase kebab-case', async () => {
    const prefCandidate = {
      type: 'preference',
      slug: 'prefers-typescript',
      title: 'Prefers TypeScript',
      body: '## Preference\nPrefers TypeScript.',
      subject: 'Programming Languages',
      preference: 'favors TypeScript over Python',
      context: 'discussion about tech stack',
      tags: [],
      confidence: 1.0,
      rationale: 'Tech preference.',
    };

    writeLog('User: I favor TypeScript over Python.');

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ response: JSON.stringify([prefCandidate]) }),
    } as Response);

    const result = await extractFromLog({
      logPath: logFile,
      memoryDir: testDir,
      model: 'test-model:latest',
      dryRun: false,
    });

    expect(result.extracted).toBe(1);
    const atoms = listAtoms(testDir);
    const atom = atoms[0];
    expect(atom.frontmatter.scope?.tags).toContain('subject:programming-languages');
  });

  it('strips special characters from subject when building the tag', async () => {
    const prefCandidate = {
      type: 'preference',
      slug: 'prefers-cpp-over-rust',
      title: 'Prefers C++ over Rust',
      body: '## Preference\nPrefers C++.',
      subject: 'C++ / Rust (systems)',
      preference: 'favors C++',
      context: 'systems-programming chat',
      tags: [],
      confidence: 1.0,
      rationale: 'Language preference.',
    };

    writeLog('User: I prefer C++ over Rust for systems work.');

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ response: JSON.stringify([prefCandidate]) }),
    } as Response);

    const result = await extractFromLog({
      logPath: logFile,
      memoryDir: testDir,
      model: 'test-model:latest',
      dryRun: false,
    });

    expect(result.extracted).toBe(1);
    const atom = listAtoms(testDir)[0];
    const subjectTags = (atom.frontmatter.scope?.tags ?? []).filter((t: string) => t.startsWith('subject:'));
    expect(subjectTags).toEqual(['subject:c-rust-systems']);
  });

  it('sanitizes control characters in preference fields before interpolation', async () => {
    const prefCandidate = {
      type: 'preference',
      slug: 'prefers-coffee',
      title: 'Prefers coffee',
      body: '## Preference\nPrefers coffee.',
      subject: 'coffee\n**Injected:** bad',
      preference: 'oat milk\nlattes',
      context: 'morning\trant',
      tags: [],
      confidence: 1.0,
      rationale: 'Coffee preference.',
    };

    writeLog('User: I like oat milk lattes.');

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ response: JSON.stringify([prefCandidate]) }),
    } as Response);

    const result = await extractFromLog({
      logPath: logFile,
      memoryDir: testDir,
      model: 'test-model:latest',
      dryRun: false,
    });

    expect(result.extracted).toBe(1);
    const atom = listAtoms(testDir)[0];
    // The sanitizer collapses control chars to a single space so the LLM cannot
    // inject extra Markdown structure: the body still has exactly 3 marker lines.
    const markerLines = atom.body.split('\n').filter((l) => l.startsWith('**'));
    expect(markerLines).toHaveLength(3);
    expect(atom.body).toContain('**Subject:** coffee **Injected:** bad');
    expect(atom.body).toContain('**Preference:** oat milk lattes');
    expect(atom.body).toContain('**Context:** morning rant');
  });
});
