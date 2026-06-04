/**
 * Tests for src/doctor/discover-wrappers.ts (#140).
 *
 * Drives discovery against a fake $HOME and MK_CRONTAB_FILE override so we
 * never touch the real crontab or system paths.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  discoverWrappers,
  extractScriptPaths,
  isShellScript,
} from '../src/doctor/discover-wrappers.js';

let homeDir: string;
let crontabFile: string;
let scriptDir: string;

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-doctor-home-'));
  crontabFile = path.join(homeDir, 'crontab.txt');
  scriptDir = path.join(homeDir, '.local', 'bin');
  fs.mkdirSync(scriptDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe('discoverWrappers — user crontab via MK_CRONTAB_FILE', () => {
  it('returns no results when the crontab does not exist', () => {
    const out = discoverWrappers({
      home: homeDir,
      userCrontabFile: crontabFile,
      skipSystem: true,
    });
    expect(out).toEqual([]);
  });

  it('ignores crontab content that does not mention mk', () => {
    fs.writeFileSync(crontabFile, '0 * * * * /usr/bin/something-else\n');
    const out = discoverWrappers({
      home: homeDir,
      userCrontabFile: crontabFile,
      skipSystem: true,
    });
    expect(out).toEqual([]);
  });

  it('returns the crontab itself plus any referenced mk-generated scripts', () => {
    const scriptPath = path.join(scriptDir, 'memory-sync.sh');
    fs.writeFileSync(scriptPath, [
      '#!/usr/bin/env bash',
      '# mk:generator-version=1.18.7',
      '# mk:memory-dir=/foo',
      '# mk:claude-md=/bar',
      'mk reflect -d /foo',
    ].join('\n'));
    fs.chmodSync(scriptPath, 0o755);

    fs.writeFileSync(crontabFile, `0 23 * * * ${scriptPath}\n`);

    const out = discoverWrappers({
      home: homeDir,
      userCrontabFile: crontabFile,
      skipSystem: true,
    });

    // First result is the crontab itself (mentions "mk " via the script
    // path's content not being inspected here — but we kept the crontab in
    // out because its discovered content looksLikeMkInvocation when the
    // referenced script also matches). The second is the referenced script.
    const sources = out.map((w) => w.source);
    expect(sources).toContain(scriptPath);
    const scriptResult = out.find((w) => w.source === scriptPath)!;
    expect(scriptResult.isMkGenerated).toBe(true);
    expect(scriptResult.kind).toBe('cron-user');
  });

  it('does not duplicate when the same script is referenced multiple times', () => {
    const scriptPath = path.join(scriptDir, 'memory-sync.sh');
    fs.writeFileSync(scriptPath, '#!/usr/bin/env bash\n# mk:generator-version=1.18.7\nmk render\n');
    fs.writeFileSync(
      crontabFile,
      [
        `0 23 * * * ${scriptPath}`,
        `# also referenced here:`,
        `30 9 * * * ${scriptPath}`,
        '',
      ].join('\n'),
    );

    const out = discoverWrappers({
      home: homeDir,
      userCrontabFile: crontabFile,
      skipSystem: true,
    });
    const scriptHits = out.filter((w) => w.source === scriptPath);
    expect(scriptHits).toHaveLength(1);
  });
});

describe('discoverWrappers — skip flags', () => {
  it('skipUserCrontab=true means the crontab file is not read', () => {
    fs.writeFileSync(crontabFile, '0 * * * * mk render\n');
    const out = discoverWrappers({
      home: homeDir,
      userCrontabFile: crontabFile,
      skipSystem: true,
      skipUserCrontab: true,
    });
    expect(out).toEqual([]);
  });
});

describe('extractScriptPaths', () => {
  it('extracts absolute paths ending in .sh', () => {
    const out = extractScriptPaths('0 23 * * * /home/agent/memory-sync.sh\n');
    expect(out).toEqual(['/home/agent/memory-sync.sh']);
  });

  it('extracts absolute paths under bin/', () => {
    const out = extractScriptPaths('0 23 * * * /usr/local/bin/mk-wrapper arg1\n');
    expect(out).toEqual(['/usr/local/bin/mk-wrapper']);
  });

  it('ignores comment lines', () => {
    const out = extractScriptPaths('# /home/agent/memory-sync.sh — old line\n');
    expect(out).toEqual([]);
  });

  it('ignores relative paths', () => {
    const out = extractScriptPaths('0 23 * * * ./memory-sync.sh\n');
    expect(out).toEqual([]);
  });

  it('deduplicates repeated paths', () => {
    const out = extractScriptPaths(
      '0 23 * * * /a.sh\n30 9 * * * /a.sh\n',
    );
    expect(out).toEqual(['/a.sh']);
  });

  it('extracts double-quoted paths that contain spaces', () => {
    // Common on macOS, where wrappers often live under
    // ~/Library/Application Support/...
    const out = extractScriptPaths(
      '0 23 * * * "/Users/x/Library/Application Support/mk/sync.sh"\n',
    );
    expect(out).toEqual([
      '/Users/x/Library/Application Support/mk/sync.sh',
    ]);
  });

  it('extracts single-quoted paths that contain spaces', () => {
    const out = extractScriptPaths(
      "0 23 * * * '/Users/x/My Project/sync.sh'\n",
    );
    expect(out).toEqual(['/Users/x/My Project/sync.sh']);
  });

  it('extracts paths from LaunchAgent plist <string> elements (handles spaces)', () => {
    // LaunchAgent plists embed the executable path inside <string>...</string>
    // tags, often under ProgramArguments. Real-world plist paths frequently
    // contain spaces (`~/Library/Application Support/...`).
    const plist = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      '  <key>ProgramArguments</key>',
      '  <array>',
      '    <string>/bin/bash</string>',
      '    <string>/Users/x/Library/Application Support/mk/sync.sh</string>',
      '  </array>',
      '</dict></plist>',
    ].join('\n');
    const out = extractScriptPaths(plist);
    expect(out).toContain(
      '/Users/x/Library/Application Support/mk/sync.sh',
    );
  });

  it('still extracts plain unquoted paths without spaces (regression)', () => {
    const out = extractScriptPaths('0 23 * * * /usr/local/bin/mk-wrapper\n');
    expect(out).toEqual(['/usr/local/bin/mk-wrapper']);
  });
});

describe('isShellScript', () => {
  it('recognizes #!/bin/bash', () => {
    expect(isShellScript('#!/bin/bash\necho hi\n')).toBe(true);
  });

  it('recognizes #!/usr/bin/env bash', () => {
    expect(isShellScript('#!/usr/bin/env bash\necho hi\n')).toBe(true);
  });

  it('recognizes #!/bin/sh', () => {
    expect(isShellScript('#!/bin/sh\necho hi\n')).toBe(true);
  });

  it('recognizes #!/usr/bin/env zsh / dash / fish', () => {
    expect(isShellScript('#!/usr/bin/env zsh\n')).toBe(true);
    expect(isShellScript('#!/usr/bin/env dash\n')).toBe(true);
    expect(isShellScript('#!/usr/bin/env fish\n')).toBe(true);
  });

  it('REJECTS #!/usr/bin/env node (mk binary, caught during 1.23.0 dogfood)', () => {
    expect(isShellScript('#!/usr/bin/env node\nconsole.log("mk render")\n')).toBe(false);
  });

  it('REJECTS #!/usr/bin/env python3', () => {
    expect(isShellScript('#!/usr/bin/env python3\n')).toBe(false);
  });

  it('REJECTS content with no shebang at all', () => {
    expect(isShellScript('echo hi\n')).toBe(false);
    expect(isShellScript('')).toBe(false);
  });

  it('REJECTS shebangs that name a binary whose basename only resembles a shell', () => {
    // /usr/local/bin/bash-completion is not bash; basename != 'bash'.
    expect(isShellScript('#!/usr/local/bin/bash-completion\n')).toBe(false);
  });
});

describe('discoverWrappers — phase 5 isShellScript filter (1.23.0 regression guard)', () => {
  it('does NOT include /usr/bin/env-node binaries even when their body mentions mk render', () => {
    // Simulate Taj's /home/taj/.npm-global/bin/mk pointing at dist/cli/mk.js.
    const mkBinaryPath = path.join(scriptDir, 'mk');
    fs.writeFileSync(
      mkBinaryPath,
      [
        '#!/usr/bin/env node',
        '// mk — Memory Kernel CLI',
        '// help text mentions: "mk render <dir>", "mk reflect", etc.',
      ].join('\n'),
    );
    fs.writeFileSync(crontabFile, `0 23 * * * ${mkBinaryPath} reflect -d /foo\n`);
    const out = discoverWrappers({
      home: homeDir,
      userCrontabFile: crontabFile,
      skipSystem: true,
    });
    // The mk binary itself should NOT appear as a wrapper.
    expect(out.find((w) => w.source === mkBinaryPath)).toBeUndefined();
  });
});
