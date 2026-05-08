import { Plugin, WorkspaceLeaf } from 'obsidian';
import { MkGraphView, MK_GRAPH_VIEW_TYPE } from './view.js';
import { DEFAULT_SETTINGS, MkGraphSettingTab, type MkGraphSettings } from './settings.js';

export default class MkGraphPlugin extends Plugin {
  settings: MkGraphSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(MK_GRAPH_VIEW_TYPE, (leaf) => new MkGraphView(leaf, this));

    this.addRibbonIcon('git-branch', 'Open Memory Kernel Graph', () => {
      void this.activateView();
    });

    this.addCommand({
      id: 'open-mk-graph',
      name: 'Open Memory Kernel Graph',
      callback: () => {
        void this.activateView();
      },
    });

    this.addCommand({
      id: 'reload-mk-graph',
      name: 'Reload Memory Kernel Graph from disk',
      checkCallback: (checking) => {
        const view = this.getActiveGraphView();
        if (!view) return false;
        if (!checking) void view.reloadFromDisk();
        return true;
      },
    });

    this.addCommand({
      id: 'mk-graph-toggle-live-scrubbed',
      name: 'Toggle Live / Scrubbed mode',
      checkCallback: (checking) => {
        const view = this.getActiveGraphView();
        if (!view) return false;
        if (!checking) view.toggleLiveScrubbed();
        return true;
      },
    });

    this.addCommand({
      id: 'mk-graph-toggle-filter-panel',
      name: 'Toggle filter panel',
      checkCallback: (checking) => {
        const view = this.getActiveGraphView();
        if (!view) return false;
        if (!checking) {
          this.settings.showFilterPanel = !this.settings.showFilterPanel;
          view.setFilterPanelVisible(this.settings.showFilterPanel);
          void this.saveSettings();
        }
        return true;
      },
    });

    this.addSettingTab(new MkGraphSettingTab(this.app, this));
  }

  async onunload(): Promise<void> {
    // Obsidian unloads registered views automatically; nothing else to clean up.
  }

  async loadSettings(): Promise<void> {
    let stored: Partial<MkGraphSettings> | null = null;
    try {
      stored = (await this.loadData()) as Partial<MkGraphSettings> | null;
    } catch (e) {
      console.warn('mk-graph: loadSettings failed, using defaults', e);
    }
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(stored ?? {}),
      nodeChannels: {
        ...DEFAULT_SETTINGS.nodeChannels,
        ...(stored?.nodeChannels ?? {}),
      },
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(MK_GRAPH_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: MK_GRAPH_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  private getActiveGraphView(): MkGraphView | null {
    const leaves = this.app.workspace.getLeavesOfType(MK_GRAPH_VIEW_TYPE);
    if (leaves.length === 0) return null;
    const view = leaves[0].view;
    return view instanceof MkGraphView ? view : null;
  }
}
