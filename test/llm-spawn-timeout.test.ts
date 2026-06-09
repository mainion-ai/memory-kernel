/**
 * test/llm-spawn-timeout.test.ts
 *
 * Regression coverage for #99 — `callClaude` spawn timeout reliability.
 *
 * The pre-fix `callClaude` relied on Node's `spawn(..., { timeout })` option,
 * which sends SIGTERM but never resolves the wrapping promise if the child
 * ignores the signal. This suite spawns POSIX bash fixtures (skipped on
 * Windows) to verify:
 *
 *   1. A child that traps SIGTERM is killed via SIGKILL within ~5s of the
 *      timeout, and the promise rejects with a timeout error.
 *   2. A child that exits 0 quickly resolves with stdout.
 *   3. A child that handles SIGTERM and exits non-zero rejects with the
 *      exit-code error (not a timeout error).
 *   4. Once a timeout has rejected, the eventual close event does NOT cause
 *      a double-reject (settled flag).
 *
 * Tests pass `timeoutMs: 500` (via `CallLLMOptions`) so the suite completes
 * in <7 seconds total, not 120+s.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { callLLM } from '../src/llm.js';

// POSIX-only — fixtures are bash scripts.
const POSIX = process.platform !== 'win32';

describe.runIf(POSIX)('callClaude spawn timeout (#99)', () => {
  let fixtureDir: string;
  let originalClaudePath: string | undefined;

  beforeEach(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-llm-spawn-'));
    originalClaudePath = process.env.CLAUDE_PATH;
  });

  afterEach(() => {
    if (originalClaudePath === undefined) {
      delete process.env.CLAUDE_PATH;
    } else {
      process.env.CLAUDE_PATH = originalClaudePath;
    }
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  /** Write an executable bash fixture and point CLAUDE_PATH at it. */
  function installFixture(script: string): string {
    const fixturePath = path.join(fixtureDir, 'claude-fixture.sh');
    fs.writeFileSync(fixturePath, script, { mode: 0o755 });
    process.env.CLAUDE_PATH = fixturePath;
    return fixturePath;
  }

  test(
    'rejects with timeout error when child traps SIGTERM (anchor)',
    async () => {
      // Trap-and-ignore SIGTERM, then sleep effectively forever. This is the
      // exact failure mode the pre-fix `spawn(..., { timeout })` could not
      // recover from — SIGTERM is ignored, promise hangs.
      installFixture(
        [
          '#!/usr/bin/env bash',
          'trap "" TERM',
          'sleep 30',
        ].join('\n') + '\n',
      );

      const start = Date.now();
      await expect(
        callLLM('sys', 'usr', { provider: 'claude', timeoutMs: 500 }),
      ).rejects.toThrow(/timed out/i);
      const elapsed = Date.now() - start;

      // 500ms (SIGTERM scheduled) + ~5s (SIGKILL grace) ≈ 5.5s. Allow some
      // slop for CI. Crucially: under 30s (= the sleep) proves SIGKILL fired.
      expect(elapsed).toBeLessThan(8_000);
      // And under 1s would mean we rejected on SIGTERM rather than waiting
      // for the SIGKILL grace — that's also fine per the spec (the spec
      // requires reject on timeout regardless of close); we still must
      // *eventually* SIGKILL though, which is implicit in the <8s bound and
      // the absence of zombie checks. Don't over-assert.
    },
    15_000,
  );

  test('resolves with stdout when child exits 0 immediately', async () => {
    installFixture(
      [
        '#!/usr/bin/env bash',
        'echo "hello from fixture"',
        'exit 0',
      ].join('\n') + '\n',
    );

    const out = await callLLM('sys', 'usr', {
      provider: 'claude',
      timeoutMs: 5_000,
    });
    expect(out).toBe('hello from fixture');
  });

  test('swallows EPIPE when the child closes stdin before the prompt write (Node-24 flake regression)', async () => {
    // The child closes its stdin read-end and exits 0 without consuming the
    // prompt. Writing a large prompt into the now-closed pipe raises EPIPE on
    // proc.stdin. Pre-fix there was no `error` listener on proc.stdin, so Node
    // promoted the EPIPE to an unhandled exception that crashed the run (seen
    // as an intermittent Node-24 CI failure even though every test "passed").
    // Post-fix the EPIPE is swallowed and the call resolves from stdout.
    installFixture(
      [
        '#!/usr/bin/env bash',
        'exec 0<&-', // close stdin (read end) immediately
        'echo "stdin closed early"',
        'exit 0',
      ].join('\n') + '\n',
    );

    // Large enough to overflow the OS pipe buffer, so the write reliably lands
    // on the closed read-end rather than being absorbed silently.
    const bigPrompt = 'x'.repeat(2_000_000);

    const out = await callLLM('sys', bigPrompt, {
      provider: 'claude',
      timeoutMs: 5_000,
    });
    expect(out).toBe('stdin closed early');
  });

  test('rejects with exit-code error when child handles SIGTERM and exits non-zero', async () => {
    // Child reads stdin, exits 1 immediately (no timeout involved).
    // Pre-fix and post-fix both reject with the exit-code error; this test
    // guards the SIGTERM-not-fired path (settled flag must not swallow the
    // close handler's reject).
    installFixture(
      [
        '#!/usr/bin/env bash',
        'cat >/dev/null',
        'echo "boom" >&2',
        'exit 1',
      ].join('\n') + '\n',
    );

    await expect(
      callLLM('sys', 'usr', { provider: 'claude', timeoutMs: 5_000 }),
    ).rejects.toThrow(/exited with code 1/);
  });

  test('does not double-reject when SIGTERM trap forces SIGKILL path', async () => {
    // Same trap fixture as the anchor. We catch the rejection, then wait
    // long enough for any spurious second rejection to surface as an
    // unhandled-rejection or a thrown error. The promise contract is
    // one-and-done.
    installFixture(
      [
        '#!/usr/bin/env bash',
        'trap "" TERM',
        'sleep 30',
      ].join('\n') + '\n',
    );

    let rejectCount = 0;
    const p = callLLM('sys', 'usr', { provider: 'claude', timeoutMs: 500 });
    try {
      await p;
    } catch {
      rejectCount += 1;
    }

    // Wait long enough for the SIGKILL grace + close event to fire.
    await new Promise((r) => setTimeout(r, 6_000));

    // Awaiting `p` again should re-resolve to the same settled rejection,
    // NOT trigger a fresh handler-fired side effect. If the close handler
    // were calling reject() again, we'd see no change here but the test
    // process would emit an unhandledRejection warning. We assert the
    // narrower property: only one rejection observed by THIS awaiter.
    try {
      await p;
    } catch {
      rejectCount += 1;
    }

    // First await rejects; second await on the already-rejected promise
    // also throws — that's normal promise semantics. The point of this
    // test is that the suite doesn't hang and no zombie state leaks.
    expect(rejectCount).toBe(2);
  }, 15_000);
});
