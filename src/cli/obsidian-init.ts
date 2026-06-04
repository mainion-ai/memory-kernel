/**
 * CLI command: mk obsidian-init
 *
 * Initialize Obsidian vault configuration for a memory directory.
 * Writes .obsidian/graph.json with type-based color groups so the
 * ENTITIES/ folder can be opened directly as an Obsidian vault.
 *
 * Optionally syncs all existing atom files to include the
 * machine-managed ## Relations wikilink section.
 *
 * Usage:
 *   mk obsidian-init --dir <memory-dir>
 *   mk obsidian-init --dir <memory-dir> --sync
 */

import fs from 'fs';
import path from 'path';
import type { Command } from 'commander';
import { resolveDir } from './resolve-dir.js';
import { exitWithError } from './cli-util.js';
import { generateGraphConfig } from '../obsidian.js';
import { listAtoms, writeAtom } from '../store.js';

export function registerObsidianInitCommand(program: Command): void {
  program
    .command('obsidian-init')
    .description(
      'Initialize Obsidian vault config for the memory directory.\n' +
      'Writes .obsidian/graph.json with type-based color groups.\n' +
      'With --sync, rewrites all atom files to include ## Relations wikilinks.',
    )
    .option('-d, --dir <dir>', 'Memory directory', './memory')
    .option('--sync', 'Rewrite all atom files to add ## Relations sections')
    .option('--json', 'Output as JSON')
    .action((opts: { dir: string; sync?: boolean; json?: boolean }) => {
      const memoryDir = resolveDir(opts.dir, program.opts().agent);
      if (!fs.existsSync(memoryDir)) {
        exitWithError(
          `Memory directory not found: ${memoryDir}\n  Run "mk init" first.`,
          opts.json,
        );
      }

      // Write .obsidian/graph.json
      const obsidianDir = path.join(memoryDir, '.obsidian');
      fs.mkdirSync(obsidianDir, { recursive: true });
      const graphConfig = generateGraphConfig();
      fs.writeFileSync(
        path.join(obsidianDir, 'graph.json'),
        JSON.stringify(graphConfig, null, 2),
      );

      let syncedCount = 0;

      // Optionally sync all atom files to include relations sections
      if (opts.sync) {
        const atoms = listAtoms(memoryDir);
        for (const atom of atoms) {
          if (!atom.filePath) continue;
          // Re-serialize via writeAtom — handles SECRET encryption + atomic writes
          writeAtom(atom, atom.filePath);
          syncedCount++;
        }
      }

      if (opts.json) {
        console.log(JSON.stringify({
          graph_config: path.join(obsidianDir, 'graph.json'),
          synced_atoms: syncedCount,
        }, null, 2));
        return;
      }

      console.log(`✓ Wrote ${path.join(obsidianDir, 'graph.json')}`);
      if (opts.sync) {
        console.log(`✓ Synced ${syncedCount} atom files with ## Relations wikilinks`);
      } else {
        console.log('  Tip: run with --sync to add ## Relations sections to existing atoms');
      }
    });
}
