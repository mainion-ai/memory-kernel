import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { observeConversation } from '../src/observe.js';

let testDir: string;
let logFile: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-observe-'));
  // Create a minimal memory dir structure
  fs.mkdirSync(path.join(testDir, 'ENTITIES'), { recursive: true });
  logFile = path.join(testDir, 'conversation.log');
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const SAMPLE_OBSERVATIONS = `- 🔴 User's name is Alex, works as a software engineer at TechCorp
- 🟡 Prefers TypeScript over JavaScript
- Started learning Rust in January 2026
- Has a dog named Max`;

/** Write a simple log file with given content. */
function writeLog(content: string) {
  fs.writeFileSync(logFile, content, 'utf-8');
}

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
    // Mock the LLM call
    vi.mock('child_process', () => ({
      execFileSync: (_cmd: string, _args: string[], opts: { input?: string }) => {
        // Verify that the first 3 lines were skipped
        const input = opts.input ?? '';
        if (input.includes('PREAMBLE LINE')) {
          throw new Error('Preamble should have been skipped');
        }
        return SAMPLE_OBSERVATIONS;
      },
    }));

    writeLog('PREAMBLE LINE 1\nPREAMBLE LINE 2\nPREAMBLE LINE 3\nUSER: My name is Alex and I work at TechCorp as a software engineer. I prefer TypeScript.');
    const result = await observeConversation({
      logPath: logFile,
      memoryDir: testDir,
      skipLines: 3,
    });
    expect(result.observations).toBe(SAMPLE_OBSERVATIONS);
  });

  it('appends to observations.md with session header', async () => {
    vi.mock('child_process', () => ({
      execFileSync: () => SAMPLE_OBSERVATIONS,
    }));

    writeLog('USER: My name is Alex and I work at TechCorp as a software engineer. I really love TypeScript and started learning Rust recently.');
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
    vi.mock('child_process', () => ({
      execFileSync: () => SAMPLE_OBSERVATIONS,
    }));

    writeLog('USER: My name is Alex and I work at TechCorp as a software engineer. I really love TypeScript and started learning Rust recently.');
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
    vi.mock('child_process', () => ({
      execFileSync: () => SAMPLE_OBSERVATIONS,
    }));

    // Pre-populate observations.md
    const obsPath = path.join(testDir, 'observations.md');
    fs.writeFileSync(obsPath, '## Session 2026-05-01\n- Existing observation\n', 'utf-8');

    writeLog('USER: My name is Alex and I work at TechCorp as a software engineer. I really love TypeScript and started learning Rust recently.');
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
    vi.mock('child_process', () => ({
      execFileSync: () => SAMPLE_OBSERVATIONS,
    }));

    writeLog('USER: My name is Alex and I work at TechCorp as a software engineer. I really love TypeScript and started learning Rust recently.');
    const result = await observeConversation({
      logPath: logFile,
      memoryDir: testDir,
    });

    const today = new Date().toISOString().slice(0, 10);
    expect(result.sessionDate).toBe(today);
  });

  it('truncates very long conversations', async () => {
    vi.mock('child_process', () => ({
      execFileSync: (_cmd: string, _args: string[], opts: { input?: string }) => {
        const input = opts.input ?? '';
        if (input.includes('[... truncated]')) {
          return '- Conversation was truncated';
        }
        return SAMPLE_OBSERVATIONS;
      },
    }));

    // Write a log that exceeds 60k chars
    const longContent = 'USER: ' + 'x'.repeat(70000);
    writeLog(longContent);

    const result = await observeConversation({
      logPath: logFile,
      memoryDir: testDir,
    });

    expect(result.observations).toBeTruthy();
  });
});
