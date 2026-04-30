import { Plugin } from 'obsidian';

export default class MkGraphPlugin extends Plugin {
  async onload(): Promise<void> {
    console.log('mk-graph: onload (Phase 2 stub)');
  }

  async onunload(): Promise<void> {
    console.log('mk-graph: onunload');
  }
}
