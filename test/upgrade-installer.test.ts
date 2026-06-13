import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { resolveInstallPlan, defaultInstaller } from '../src/upgrade.js';

describe('resolveInstallPlan (#340)', () => {
  it('local-dep layout (node_modules/.bin/mk) → local install in the package root, no -g', () => {
    const plan = resolveInstallPlan('/home/u/nanoclaw-v2/groups/g/npm/node_modules/.bin/mk', '1.33.1');
    expect(plan.layout).toBe('local-dep');
    expect(plan.args).toEqual(['install', 'memory-kernel@1.33.1']);
    expect(plan.cwd).toBe('/home/u/nanoclaw-v2/groups/g/npm'); // owner of node_modules/
    expect(plan.args).not.toContain('-g');
    expect(plan.env?.npm_config_prefix).toBeUndefined();
  });

  it('global layout (<prefix>/bin/mk) → -g install with npm_config_prefix=<prefix>', () => {
    const plan = resolveInstallPlan('/usr/local/bin/mk', '1.33.1');
    expect(plan.layout).toBe('global');
    expect(plan.args).toEqual(['install', '-g', 'memory-kernel@1.33.1']);
    expect(plan.cwd).toBeUndefined();
    expect(plan.env?.npm_config_prefix).toBe('/usr/local');
  });
});

describe('defaultInstaller actually upgrades the local-dep binary (#340)', () => {
  let root: string;
  let savedPath: string | undefined;

  // Build a fake `npm` that models the real semantics relevant to the bug:
  //   - local `install memory-kernel@X` (cwd has node_modules) rewrites
  //     <cwd>/node_modules/memory-kernel to X — the package .bin/mk resolves to.
  //   - `-g --prefix P` install writes to P/lib/node_modules/memory-kernel — the
  //     WRONG place for a local-dep layout (this is exactly what the bug did).
  function writeFakeNpm(binDir: string): void {
    const shim = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
if (!args.includes('install')) process.exit(0);
const spec = args.find(a => a.startsWith('memory-kernel@'));
if (!spec) process.exit(0);
const ver = spec.split('@')[1];
let pkgDir;
if (args.includes('-g')) {
  pkgDir = path.join(process.env.npm_config_prefix || '', 'lib', 'node_modules', 'memory-kernel');
} else {
  pkgDir = path.join(process.cwd(), 'node_modules', 'memory-kernel');
}
fs.mkdirSync(path.join(pkgDir, 'dist', 'cli'), { recursive: true });
fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'memory-kernel', version: ver, bin: { mk: 'dist/cli/mk.js' } }));
fs.writeFileSync(path.join(pkgDir, 'dist', 'cli', 'mk.js'), 'console.log(' + JSON.stringify(ver) + ');\\n');
`;
    const npmPath = path.join(binDir, 'npm');
    fs.writeFileSync(npmPath, shim);
    fs.chmodSync(npmPath, 0o755);
  }

  // Lay down <pkgroot>/node_modules/memory-kernel@<ver> + node_modules/.bin/mk symlink.
  function seedPackage(pkgRoot: string, ver: string): string {
    const pkgDir = path.join(pkgRoot, 'node_modules', 'memory-kernel', 'dist', 'cli');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgRoot, 'node_modules', 'memory-kernel', 'package.json'),
      JSON.stringify({ name: 'memory-kernel', version: ver, bin: { mk: 'dist/cli/mk.js' } }),
    );
    fs.writeFileSync(path.join(pkgDir, 'mk.js'), `console.log(${JSON.stringify(ver)});\n`);
    const binDir = path.join(pkgRoot, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    const link = path.join(binDir, 'mk');
    fs.symlinkSync(path.join('..', 'memory-kernel', 'dist', 'cli', 'mk.js'), link); // relative, like real npm
    return link;
  }

  const mkVersion = (binPath: string) => execFileSync('node', [binPath], { encoding: 'utf8' }).trim();

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-upgrade-localdep-'));
    savedPath = process.env.PATH;
  });
  afterEach(() => {
    process.env.PATH = savedPath;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('upgrades the package that node_modules/.bin/mk resolves to (group-npm layout)', () => {
    const pkgRoot = path.join(root, 'npm'); // the group's npm/ dir (owns node_modules)
    const binLink = seedPackage(pkgRoot, '0.0.1');
    expect(mkVersion(binLink)).toBe('0.0.1'); // baseline: symlink resolves to the old version

    // Fake npm first on PATH so defaultInstaller's execFileSync('npm', …) hits it.
    const fakeBin = path.join(root, 'fakebin');
    fs.mkdirSync(fakeBin, { recursive: true });
    writeFakeNpm(fakeBin);
    process.env.PATH = `${fakeBin}${path.delimiter}${savedPath}`;

    defaultInstaller(binLink, '9.9.9');

    // The binary the agent runs (the symlink) now resolves to the upgraded package.
    expect(mkVersion(binLink)).toBe('9.9.9');
    expect(
      JSON.parse(fs.readFileSync(path.join(pkgRoot, 'node_modules', 'memory-kernel', 'package.json'), 'utf8')).version,
    ).toBe('9.9.9');
  });
});
