import { App, Notice, PluginSettingTab, Setting, type Plugin } from 'obsidian';

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
  /** Phase 2 always force; Phase 3 adds `timeline`, Phase 4 adds `radial-wander`. */
  defaultLayout: 'force';
  /** F2 channel toggles — fill (color by type) is always on. */
  nodeChannels: NodeChannels;
  /** Hard cap on nodes rendered before graceful degrade kicks in. */
  maxNodesShown: number;
}

export const DEFAULT_SETTINGS: MkGraphSettings = {
  memoryDir: '.mk',
  memoryDirOutsideVault: false,
  agentId: '',
  defaultLayout: 'force',
  nodeChannels: { border: true, opacity: true, size: true },
  maxNodesShown: 5000,
};

/**
 * Subset of `Plugin` we depend on — keeps this file decoupled from the
 * concrete plugin class so it can be imported without circular deps.
 */
export interface SettingsHost extends Plugin {
  settings: MkGraphSettings;
  saveSettings(): Promise<void>;
}

/** Mirrors data-loader.ts:isSafeAgentId. Duplicated here so the SettingTab
 *  can warn inline without coupling to the loader module. */
function isUnsafeAgentId(agentId: string): boolean {
  if (agentId.length === 0) return false; // empty = shared mode, not unsafe
  if (agentId.includes('/') || agentId.includes('\\')) return true;
  if (agentId === '.' || agentId === '..') return true;
  return false;
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
