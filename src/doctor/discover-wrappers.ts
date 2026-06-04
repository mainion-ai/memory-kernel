/**
 * discoverWrappers — scan the host for cron/launchd/systemd wrappers that
 * might be calling `mk` (#140, foundation for #142).
 *
 * Used by the doctor's wrapper-drift check to flag any mk-generated wrapper
 * whose version is older than the current binary, and reusable by #142 (CI
 * fleet upgrade) when it needs to know what wrappers exist on a host.
 *
 * Discovery is best-effort and never throws — if we can't read a directory
 * (permission denied) or `crontab -l` doesn't exist, we just return fewer
 * results. The caller can audit empty results and decide.
 *
 * Limitations:
 *   - Current user only. Probing other users' crontabs would need sudo.
 *   - Heuristic content match (looks for `mk ` invocations or the
 *     `# mk:generator-version=` header). Catches false positives in scripts
 *     that mention mk in comments.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

export type WrapperKind = 'cron-user' | 'cron-system' | 'launchd' | 'systemd';

export interface DiscoveredWrapper {
  kind: WrapperKind;
  /** Human-readable source path (file on disk or the literal "crontab -l"). */
  source: string;
  /** File contents. */
  content: string;
  /** True if the content carries the # mk:generator-version= header (#143). */
  isMkGenerated: boolean;
}

export interface DiscoverOptions {
  /** Override $HOME for tests. Defaults to os.homedir(). */
  home?: string;
  /** Skip system-wide locations (/etc/cron.*, /etc/systemd/system/). */
  skipSystem?: boolean;
  /** Skip the `crontab -l` shell-out (e.g. in CI / headless tests). */
  skipUserCrontab?: boolean;
  /**
   * Test override: read the current user's "crontab" from this file path
   * instead of shelling out. Honors `MK_CRONTAB_FILE` env var by default —
   * the same override used by `mk init --cron --install-cron`.
   */
  userCrontabFile?: string;
}

const MK_HEADER_RE = /^# mk:generator-version=/m;

const SHELL_NAMES = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'ash',
  'fish',
]);

function looksLikeMkInvocation(content: string): boolean {
  return MK_HEADER_RE.test(content) || /\bmk\s+(render|reflect|init|recall|gc)\b/.test(content);
}

/**
 * True if `content`'s first line is a shebang naming a known shell
 * interpreter. Used to keep the mk binary itself (`#!/usr/bin/env node`)
 * out of phase-5 wrapper resolution — the binary's own source contains
 * `mk render`/`mk reflect` strings in help text and would otherwise match
 * `looksLikeMkInvocation`.
 *
 * Handles both forms:
 *   - `#!/bin/bash`                → basename of last path component
 *   - `#!/usr/bin/env bash`        → last whitespace-separated token
 *
 * Exported for unit testing.
 */
export function isShellScript(content: string): boolean {
  const firstLine = content.split('\n', 1)[0];
  if (!firstLine.startsWith('#!')) return false;
  const rest = firstLine.slice(2).trim();
  if (rest.length === 0) return false;
  const tokens = rest.split(/\s+/);
  const finalToken = tokens[tokens.length - 1];
  const binaryName = path.basename(finalToken);
  return SHELL_NAMES.has(binaryName);
}

/** Try to read a file; return null if we can't (e.g. permission denied). */
function tryRead(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/** Iterate over files in a dir; silently skip dirs we can't read. */
function listDir(dirPath: string): string[] {
  try {
    return fs.readdirSync(dirPath);
  } catch {
    return [];
  }
}

function readUserCrontab(opts: DiscoverOptions): string | null {
  if (opts.skipUserCrontab) return null;
  const override = opts.userCrontabFile ?? process.env.MK_CRONTAB_FILE;
  if (override) {
    return tryRead(override);
  }
  try {
    return execFileSync('crontab', ['-l'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/**
 * Scan the host. Order: user crontab → system cron dirs → launchd (macOS) →
 * systemd user units → systemd system units. Each source contributes 0 or
 * more wrappers.
 */
export function discoverWrappers(opts: DiscoverOptions = {}): DiscoveredWrapper[] {
  const home = opts.home ?? os.homedir();
  const out: DiscoveredWrapper[] = [];

  // --- 1. user crontab ---
  //
  // We track the crontab text for phase 5 (script-ref resolution) even when
  // its own text doesn't match the mk-invocation heuristic — typical cron
  // lines just reference a wrapper script by path, and the actual `mk`
  // commands live inside that script.
  //
  // We only include the crontab itself in `out` when its content directly
  // invokes mk (e.g. inline `0 23 * * * mk reflect …`), to keep the result
  // set focused.
  const userCron = readUserCrontab(opts);
  const userCrontabSource =
    opts.userCrontabFile ?? process.env.MK_CRONTAB_FILE ?? 'crontab -l';
  const phase5Sources: Array<{ kind: WrapperKind; content: string }> = [];
  if (userCron) {
    if (looksLikeMkInvocation(userCron)) {
      out.push({
        kind: 'cron-user',
        source: userCrontabSource,
        content: userCron,
        isMkGenerated: MK_HEADER_RE.test(userCron),
      });
    }
    phase5Sources.push({ kind: 'cron-user', content: userCron });
  }

  // --- 2. system cron dirs (best-effort, may be unreadable) ---
  if (!opts.skipSystem) {
    for (const dir of ['/etc/cron.d', '/etc/cron.daily', '/etc/cron.hourly']) {
      for (const name of listDir(dir)) {
        const full = path.join(dir, name);
        const content = tryRead(full);
        if (content && looksLikeMkInvocation(content)) {
          out.push({
            kind: 'cron-system',
            source: full,
            content,
            isMkGenerated: MK_HEADER_RE.test(content),
          });
        }
      }
    }
  }

  // --- 3. launchd plists (macOS) ---
  if (process.platform === 'darwin') {
    const launchAgents = path.join(home, 'Library', 'LaunchAgents');
    for (const name of listDir(launchAgents)) {
      if (!name.endsWith('.plist')) continue;
      const full = path.join(launchAgents, name);
      const content = tryRead(full);
      if (content && looksLikeMkInvocation(content)) {
        out.push({
          kind: 'launchd',
          source: full,
          content,
          isMkGenerated: MK_HEADER_RE.test(content),
        });
      }
    }
  }

  // --- 4. systemd user + system units (Linux) ---
  if (process.platform === 'linux') {
    const systemdLocations = [path.join(home, '.config', 'systemd', 'user')];
    if (!opts.skipSystem) systemdLocations.push('/etc/systemd/system');
    for (const dir of systemdLocations) {
      for (const name of listDir(dir)) {
        if (!name.endsWith('.service') && !name.endsWith('.timer')) continue;
        const full = path.join(dir, name);
        const content = tryRead(full);
        if (content && looksLikeMkInvocation(content)) {
          out.push({
            kind: 'systemd',
            source: full,
            content,
            isMkGenerated: MK_HEADER_RE.test(content),
          });
        }
      }
    }
  }

  // --- 5. mk-generated scripts referenced from any scheduler entry ---
  //
  // `out` so far contains only schedulers whose own text matched the
  // mk-invocation heuristic. `phase5Sources` already has the user crontab.
  // Add the entries from `out` (system cron files, launchd plists, systemd
  // units) so we follow script refs from those too.
  for (const w of out) {
    if (w.kind === 'cron-user' && phase5Sources.some((p) => p.content === w.content)) continue;
    phase5Sources.push({ kind: w.kind, content: w.content });
  }

  const seenPaths = new Set<string>();
  for (const src of phase5Sources) {
    for (const candidate of extractScriptPaths(src.content)) {
      if (seenPaths.has(candidate)) continue;
      seenPaths.add(candidate);
      const scriptContent = tryRead(candidate);
      if (!scriptContent) continue;
      // Phase-5 candidates must be SHELL scripts. The mk binary itself
      // (`#!/usr/bin/env node`, mentioned from PATH inside crontab lines
      // like `/home/taj/.npm-global/bin/mk reflect …`) would otherwise
      // match `looksLikeMkInvocation` via the help strings + self-calls
      // in its own source — false positive caught during the 1.23.0
      // dogfood. Real wrappers are bash/sh; the mk binary is node.
      if (!isShellScript(scriptContent)) continue;
      // Include the script if it carries the mk-generated header OR its
      // body looks like an mk invocation (a hand-rolled wrapper that
      // calls `mk render` / `mk reflect` / etc.). The `isMkGenerated`
      // flag distinguishes the two — the wrapper-drift check uses both:
      // it flags out-of-date mk-generated wrappers AND hand-rolled ones
      // that should probably be regenerated via `mk init --cron`.
      const headerPresent = MK_HEADER_RE.test(scriptContent);
      if (headerPresent || looksLikeMkInvocation(scriptContent)) {
        out.push({
          kind: src.kind,
          source: candidate,
          content: scriptContent,
          isMkGenerated: headerPresent,
        });
      }
    }
  }

  return out;
}

/**
 * Pull out script-looking absolute paths from a scheduler entry. We only
 * follow absolute paths to avoid false-positive resolution against the
 * doctor's CWD. Whitelisted suffixes: .sh, .bash, no-extension scripts
 * under a bin/ directory.
 *
 * Handles three encodings the schedulers use in practice:
 *   1. Bare unquoted paths (`* * * * * /usr/local/bin/mk-wrapper`)
 *   2. Quoted paths — single or double — which can contain spaces
 *      (`* * * * * "/Users/x/Library/Application Support/mk/sync.sh"`)
 *   3. LaunchAgent plist `<string>` elements, common on macOS, also often
 *      contain paths with spaces.
 *
 * Exported for testability.
 */
export function extractScriptPaths(content: string): string[] {
  const found = new Set<string>();
  const accept = (raw: string): void => {
    const candidate = raw.trim();
    if (!candidate.startsWith('/')) return;
    if (
      candidate.endsWith('.sh')
      || candidate.endsWith('.bash')
      || /\/bin\/[^/]+$/.test(candidate)
    ) {
      found.add(candidate);
    }
  };

  // (3) LaunchAgent plist <string>...</string> bodies — run globally over the
  // full content so the path is captured intact even when it contains spaces.
  // Non-greedy match stops at the first `</string>`.
  for (const m of content.matchAll(/<string>\s*(\/[^<\n]+?)\s*<\/string>/g)) {
    accept(m[1]);
  }

  // (1) + (2) line-by-line for cron / systemd files. Skip comment lines —
  // tests pin that a `# /path/sync.sh` line must not produce a path.
  const doubleQuoted = /"(\/[^"\n]+)"/g;
  const singleQuoted = /'(\/[^'\n]+)'/g;
  // Lookbehind enforces "no letter/digit/dot/slash directly precedes the
  // leading `/`" so `./memory-sync.sh` and `https://example/foo.sh` don't
  // produce spurious absolute paths.
  const unquoted = /(?<![A-Za-z0-9./])(\/[A-Za-z0-9._\/-]+)/g;

  for (const raw of content.split('\n')) {
    if (raw.trim().startsWith('#')) continue;
    for (const m of raw.matchAll(doubleQuoted)) accept(m[1]);
    for (const m of raw.matchAll(singleQuoted)) accept(m[1]);
    for (const m of raw.matchAll(unquoted)) accept(m[1]);
  }

  return Array.from(found);
}
