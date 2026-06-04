/**
 * observe — dedup session block before append (#103).
 *
 * `observeConversation` appended a `## Session ${date}` block to
 * `observations.md` unconditionally. If the LLM call retries after a crash
 * (observer ran, wrote, but the process died before exit; the user re-runs the
 * same command), the same session block ends up appended twice.
 *
 * PR-18 adds an idempotency check: before appending, scan the existing file
 * for `## Session ${date}` and skip the append (with a stderr warning) if the
 * header already exists. PR-12's 0o600 chmod must still apply on the
 * successful-write path.
 *
 * Tests target the small extracted helper `appendObservationSection` so they
 * don't have to mock the LLM. The helper is `@internal` (exported only for
 * tests).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { appendObservationSection } from '../src/observe.js';

const isPosix = process.platform !== 'win32';
const itPosix = isPosix ? it : it.skip;

let testDir: string;
let obsPath: string;
let stderrSpy: ReturnType<typeof vi.spyOn>;

const SAMPLE_OBSERVATIONS = `- 🔴 User's name is Alex, works as a software engineer at TechCorp
- 🟡 Prefers TypeScript over JavaScript
- Started learning Rust in January 2026
- Has a dog named Max`;

const mode = (p: string) => fs.statSync(p).mode & 0o777;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-observe-dedup-'));
  obsPath = path.join(testDir, 'observations.md');
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('appendObservationSection — dedup session block (#103)', () => {
  it('first write: empty memoryDir → helper writes section and returns written: true', () => {
    const result = appendObservationSection(obsPath, '2026-05-20', SAMPLE_OBSERVATIONS);

    expect(result.written).toBe(true);
    expect(result.reason).toBeUndefined();

    const content = fs.readFileSync(obsPath, 'utf-8');
    expect(content).toContain('## Session 2026-05-20');
    expect(content).toContain('Alex');
    expect(content).toContain('Prefers TypeScript');
  });

  it('dedup hit: observations.md already has matching session header → skips append, emits stderr warning', () => {
    // Pre-seed observations.md with the exact session block we'd otherwise write
    const existing = `\n## Session 2026-05-20\n${SAMPLE_OBSERVATIONS}\n`;
    fs.writeFileSync(obsPath, existing, 'utf-8');
    const before = fs.readFileSync(obsPath, 'utf-8');

    const result = appendObservationSection(obsPath, '2026-05-20', 'NEW DIFFERENT OBSERVATIONS');

    expect(result.written).toBe(false);
    expect(result.reason).toBe('dedup');

    // File content is unchanged — the new content is NOT appended
    const after = fs.readFileSync(obsPath, 'utf-8');
    expect(after).toBe(before);
    expect(after).not.toContain('NEW DIFFERENT OBSERVATIONS');

    // Stderr warning fired with the project's `mk: warning:` prefix
    const stderrCalls = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrCalls).toMatch(/mk: warning:/);
    expect(stderrCalls).toContain('## Session 2026-05-20');
    expect(stderrCalls).toMatch(/skipping/i);
  });

  it('different date: existing 05-19 + new 05-20 → both blocks present in order', () => {
    fs.writeFileSync(obsPath, '\n## Session 2026-05-19\n- Yesterday observation\n', 'utf-8');

    const result = appendObservationSection(obsPath, '2026-05-20', SAMPLE_OBSERVATIONS);

    expect(result.written).toBe(true);
    expect(result.reason).toBeUndefined();

    const content = fs.readFileSync(obsPath, 'utf-8');
    expect(content).toContain('## Session 2026-05-19');
    expect(content).toContain('Yesterday observation');
    expect(content).toContain('## Session 2026-05-20');
    expect(content).toContain('Alex');

    // Order: 05-19 before 05-20
    const idx19 = content.indexOf('## Session 2026-05-19');
    const idx20 = content.indexOf('## Session 2026-05-20');
    expect(idx19).toBeLessThan(idx20);
  });

  itPosix('PR-12 regression guard: file mode is 0o600 after successful write', () => {
    appendObservationSection(obsPath, '2026-05-20', SAMPLE_OBSERVATIONS);
    expect(fs.existsSync(obsPath)).toBe(true);
    expect(mode(obsPath)).toBe(0o600);
  });

  itPosix('PR-12 regression guard: file mode is 0o600 on append to existing file', () => {
    // Pre-create with permissive mode to ensure we re-chmod
    fs.writeFileSync(obsPath, '\n## Session 2026-05-19\n- prior\n', 'utf-8');
    fs.chmodSync(obsPath, 0o644);
    expect(mode(obsPath)).toBe(0o644);

    appendObservationSection(obsPath, '2026-05-20', SAMPLE_OBSERVATIONS);
    expect(mode(obsPath)).toBe(0o600);
  });
});
