import { ItemView, Notice, WorkspaceLeaf, normalizePath, type App } from 'obsidian';
import path from 'node:path';
import { GraphState } from './graph-state.js';
import { readVault, watchVault, resolveMemoryDir, type Watcher } from './data-loader.js';
import { createRenderer, type RendererHandle } from './renderer.js';
import type { MkGraphSettings } from './settings.js';
import type { ParsedAtom } from './atom-parser.js';

export const MK_GRAPH_VIEW_TYPE = 'mk-graph-view';

export interface ViewHost {
  app: App;
  settings: MkGraphSettings;
}

export class MkGraphView extends ItemView {
  private state: GraphState = new GraphState();
  private renderer: RendererHandle | null = null;
  private watcher: Watcher | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly host: ViewHost,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return MK_GRAPH_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Memory Kernel Graph';
  }

  getIcon(): string {
    return 'git-branch';
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.classList.add('mk-graph-view-container');

    this.renderer = createRenderer(container, {
      state: this.state,
      settings: this.host.settings,
      onNodeClick: (atom) => this.openAtom(atom),
    });

    await this.reloadFromDisk();

    const memDir = this.resolveMemoryDirAbsolute();
    if (memDir) {
      this.watcher = watchVault(memDir, () => {
        // Coalesce + reload; errors land in the console rather than crash the view.
        void this.reloadFromDisk();
      });
    }
  }

  async onClose(): Promise<void> {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.renderer) {
      this.renderer.destroy();
      this.renderer = null;
    }
  }

  /** Public so the plugin entry can call it from the "Reload" command.
   *  Catches directory-level read errors so a watcher-fired reload after
   *  the user deletes the memory dir doesn't surface as an unhandled
   *  promise rejection. Per-file errors are already swallowed by readVault. */
  async reloadFromDisk(): Promise<void> {
    try {
      const memDir = this.resolveMemoryDirAbsolute();
      if (!memDir) {
        this.state.replace([]);
        return;
      }
      const atoms = await readVault(memDir);
      this.state.replace(atoms);
    } catch (err) {
      console.warn('mk-graph: reloadFromDisk failed', err);
      this.state.replace([]);
    }
  }

  private resolveMemoryDirAbsolute(): string | null {
    const { memoryDir, memoryDirOutsideVault, agentId } = this.host.settings;
    if (!memoryDir) return null;

    let base: string;
    if (path.isAbsolute(memoryDir)) {
      if (!memoryDirOutsideVault) {
        console.warn(
          `mk-graph: memoryDir "${memoryDir}" is absolute but "memoryDirOutsideVault" is off. Skipping load.`,
        );
        return null;
      }
      base = memoryDir;
    } else {
      const vaultRoot = (this.host.app.vault.adapter as { basePath?: string }).basePath;
      if (!vaultRoot) {
        console.warn('mk-graph: cannot resolve vault root; skipping load.');
        return null;
      }
      base = path.join(vaultRoot, normalizePath(memoryDir));
    }

    return resolveMemoryDir(base, agentId || undefined);
  }

  private async openAtom(atom: ParsedAtom): Promise<void> {
    if (!atom.filePath) return;
    const vaultRoot = (this.host.app.vault.adapter as { basePath?: string }).basePath;
    if (!vaultRoot) return;
    let rel = atom.filePath;
    if (rel.startsWith(vaultRoot)) {
      rel = rel.slice(vaultRoot.length).replace(/^[/\\]+/, '');
    } else {
      // Atom lives outside the vault (likely memoryDirOutsideVault=true).
      // Obsidian can't open files it doesn't know about — surface a Notice
      // so the click doesn't silently fail.
      new Notice(
        `mk-graph: atom is outside the vault (${atom.filePath}); Obsidian can only open files inside the vault.`,
      );
      return;
    }
    // Open in a new tab so the graph view stays visible alongside the atom.
    await this.host.app.workspace.openLinkText(normalizePath(rel), '', 'tab');
  }
}
