import { App, Notice, PluginSettingTab, Setting, type Plugin } from 'obsidian';
import type { SerializedFilterState } from './filter-state.js';

export interface NodeChannels {
  /** Toggle the F2 border-by-classification ring. */
  border: boolean;
  /** Toggle the F2 status-driven opacity. */
  opacity: boolean;
  /** Toggle the F2 log-citations sizing. */
  size: boolean;
}

export interface MkGraphSettings {
  /** Path to memory-kernel root dir. Relative paths resolve under the vault. */
  memoryDir: string;
  /** When true, memoryDir may be an absolute path outside the vault. */
  memoryDirOutsideVault: boolean;
  /** Empty string = shared mode (intentional and meaningful). Otherwise
   *  routed via agents/<id>/. The data loader rejects path-separator and
   *  dot-segment IDs at read time; the SettingTab also warns the user
   *  inline so they see why their agent isn't loading. */
  agentId: string;
  /** Phase 3 widens this from `'force'` to include `'timeline'`. Phase 4
   *  will add `'radial-wander'`. */
  defaultLayout: 'force' | 'timeline';
  /** F2 channel toggles — fill (color by type) is always on. */
  nodeChannels: NodeChannels;
  /** Hard cap on nodes rendered before graceful degrade kicks in. */
  maxNodesShown: number;
  /** Show the F2-encoding legend overlay in the graph view. */
  showLegend: boolean;
  /** Show the scrubber overlay (mode buttons + histogram + playhead). */
  showScrubber: boolean;
  /** Default replay mode on view-open. Spec §H1: true until the user
   *  scrubs once; thereafter `false` so we restore `lastScrubbedAt`. */
  liveModeOnStartup: boolean;
  /** ISO8601 last scrubbed-to timestamp. Restored on view-open when
   *  `liveModeOnStartup === false`. Null until the user scrubs once. */
  lastScrubbedAt: string | null;
  /** Show the filter side overlay (atom-type / status / classification
   *  toggles, search, tags, orphans). Default true. */
  showFilterPanel: boolean;
  /** Persisted filter state. JSON-friendly shape (Sets serialised as
   *  arrays). Empty / missing → default state matches every atom. */
  filters: SerializedFilterState;
}

export const DEFAULT_SETTINGS: MkGraphSettings = {
  memoryDir: '.mk',
  memoryDirOutsideVault: false,
  agentId: '',
  defaultLayout: 'force',
  nodeChannels: { border: true, opacity: true, size: true },
  maxNodesShown: 5000,
  showLegend: true,
  showScrubber: true,
  liveModeOnStartup: true,
  lastScrubbedAt: null,
  showFilterPanel: true,
  filters: {
    search: '',
    hiddenTypes: [],
    hiddenStatuses: [],
    hiddenClassifications: [],
    selectedTags: [],
    orphansOnly: false,
  },
};

/**
 * Subset of `Plugin` we depend on — keeps this file decoupled from the
 * concrete plugin class so it can be imported without circular deps.
 */
export interface SettingsHost extends Plugin {
  settings: MkGraphSettings;
  saveSettings(): Promise<void>;
}

const AGENT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Mirrors data-loader.ts:isSafeAgentId. Duplicated here so the SettingTab
 *  can warn the user inline before the watcher binds. */
function isUnsafeAgentId(agentId: string): boolean {
  if (agentId.length === 0) return false; // empty = shared mode (intentional)
  return !AGENT_ID_PATTERN.test(agentId);
}

export class MkGraphSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly host: SettingsHost,
  ) {
    super(app, host);
  }

  /** Save with error-toast on failure so disk-write errors don't disappear. */
  private async safeSave(): Promise<void> {
    try {
      await this.host.saveSettings();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('mk-graph: settings save failed', e);
      new Notice(`mk-graph: settings save failed — ${msg}`);
    }
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Memory Kernel Graph — Settings' });

    new Setting(containerEl)
      .setName('Memory directory')
      .setDesc('Path to the memory-kernel store. Relative paths resolve under the vault root.')
      .addText((t) =>
        t
          .setPlaceholder('.mk')
          .setValue(this.host.settings.memoryDir)
          .onChange(async (value) => {
            this.host.settings.memoryDir = value.trim() || '.mk';
            await this.safeSave();
          }),
      );

    new Setting(containerEl)
      .setName('Memory dir outside vault')
      .setDesc('Allow an absolute path outside the current Obsidian vault.')
      .addToggle((t) =>
        t.setValue(this.host.settings.memoryDirOutsideVault).onChange(async (value) => {
          this.host.settings.memoryDirOutsideVault = value;
          await this.safeSave();
        }),
      );

    new Setting(containerEl)
      .setName('Agent ID')
      .setDesc(
        'Per-agent isolation. Leave empty for shared mode. When set and agents/<id>/ exists, the plugin reads from that subdirectory. IDs containing path separators or `..` will fall back to shared mode.',
      )
      .addText((t) =>
        t
          .setPlaceholder('(shared)')
          .setValue(this.host.settings.agentId)
          .onChange(async (value) => {
            const trimmed = value.trim();
            if (isUnsafeAgentId(trimmed)) {
              new Notice(
                `mk-graph: agent ID "${trimmed}" rejected — path separators and \`..\` aren't allowed. The loader will fall back to shared mode.`,
              );
            }
            this.host.settings.agentId = trimmed;
            await this.safeSave();
          }),
      );

    containerEl.createEl('h3', { text: 'F2 visual encoding' });

    new Setting(containerEl)
      .setName('Border = classification')
      .setDesc('Show the classification ring (PUBLIC=green, TEAM=blue, PERSONAL=orange, SECRET=red).')
      .addToggle((t) =>
        t.setValue(this.host.settings.nodeChannels.border).onChange(async (value) => {
          this.host.settings.nodeChannels.border = value;
          await this.safeSave();
        }),
      );

    new Setting(containerEl)
      .setName('Opacity = status')
      .setDesc('Dim non-active atoms (rejected, archived, superseded).')
      .addToggle((t) =>
        t.setValue(this.host.settings.nodeChannels.opacity).onChange(async (value) => {
          this.host.settings.nodeChannels.opacity = value;
          await this.safeSave();
        }),
      );

    new Setting(containerEl)
      .setName('Size = log(citations)')
      .setDesc('Scale node radius by inbound citation count.')
      .addToggle((t) =>
        t.setValue(this.host.settings.nodeChannels.size).onChange(async (value) => {
          this.host.settings.nodeChannels.size = value;
          await this.safeSave();
        }),
      );

    containerEl.createEl('h3', { text: 'View' });

    new Setting(containerEl)
      .setName('Show legend')
      .setDesc('Display the F2-encoding legend in the bottom-left of the graph view.')
      .addToggle((t) =>
        t.setValue(this.host.settings.showLegend).onChange(async (value) => {
          this.host.settings.showLegend = value;
          await this.safeSave();
        }),
      );

    new Setting(containerEl)
      .setName('Show scrubber')
      .setDesc('Display the bottom-of-view scrubber with mode buttons and event-density histogram.')
      .addToggle((t) =>
        t.setValue(this.host.settings.showScrubber).onChange(async (v) => {
          this.host.settings.showScrubber = v;
          await this.safeSave();
        }),
      );

    new Setting(containerEl)
      .setName('Show filter panel')
      .setDesc('Display the side overlay with atom-type / status / classification toggles, search, tag chips, and orphans-only filter.')
      .addToggle((t) =>
        t.setValue(this.host.settings.showFilterPanel).onChange(async (v) => {
          this.host.settings.showFilterPanel = v;
          await this.safeSave();
        }),
      );

    new Setting(containerEl)
      .setName('Default layout')
      .setDesc('Graph layout used when the view opens. Force-directed packs nodes by relation; timeline maps the X axis to created_at, Y to atom type.')
      .addDropdown((dd) =>
        dd
          .addOption('force', 'Force-directed')
          .addOption('timeline', 'Timeline')
          .setValue(this.host.settings.defaultLayout)
          .onChange(async (v) => {
            this.host.settings.defaultLayout = (v as MkGraphSettings['defaultLayout']);
            await this.safeSave();
          }),
      );

    new Setting(containerEl)
      .setName('Live mode on startup')
      .setDesc('Open the view in Live mode. When off, the view restores your last-scrubbed timestamp instead.')
      .addToggle((t) =>
        t.setValue(this.host.settings.liveModeOnStartup).onChange(async (v) => {
          this.host.settings.liveModeOnStartup = v;
          await this.safeSave();
        }),
      );

    containerEl.createEl('h3', { text: 'Performance' });

    new Setting(containerEl)
      .setName('Max nodes shown')
      .setDesc('Cap to keep the graph responsive. Default 5000; raise carefully.')
      .addText((t) =>
        t
          .setPlaceholder('5000')
          .setValue(String(this.host.settings.maxNodesShown))
          .onChange(async (value) => {
            const trimmed = value.trim();
            if (trimmed === '') return; // mid-edit empty input — silent no-op
            const n = Number(trimmed);
            if (Number.isFinite(n) && n > 0) {
              this.host.settings.maxNodesShown = Math.floor(n);
              await this.safeSave();
            } else {
              new Notice(
                `mk-graph: "${trimmed}" is not a valid node cap. Keeping ${this.host.settings.maxNodesShown}.`,
              );
            }
          }),
      );
  }
}
