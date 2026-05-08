import { promises as fsp, existsSync, watch as fsWatch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { parseEventLine, type PluginEvent } from './event-parser.js';

const EVENTS_FILENAME = 'events.ndjson';

/** Read the entire events.ndjson once. Skips malformed lines. Returns
 *  events in file order (mk-core writes append-only timestamp-ascending,
 *  so file order = chronological). Never throws — missing file returns []. */
export async function readEvents(memoryDir: string): Promise<PluginEvent[]> {
  const file = path.join(memoryDir, EVENTS_FILENAME);
  if (!existsSync(file)) return [];

  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf-8');
  } catch {
    return [];
  }

  const out: PluginEvent[] = [];
  for (const line of raw.split('\n')) {
    const ev = parseEventLine(line);
    if (ev) out.push(ev);
  }
  return out;
}

export interface EventsWatcher {
  close(): void;
}

/**
 * Watch events.ndjson for appends. Coalesces rapid changes via the
 * supplied debounceMs (default 150 — same window as `watchVault` in
 * data-loader.ts so a CLI write that touches both atom files and the
 * event log only triggers one reload).
 *
 * Returns a no-op watcher when the file is absent — callers should
 * also watch the directory if they need to react to file creation.
 * (The view re-resolves the watcher on every reload, so this is fine
 * in practice.)
 */
export function watchEvents(
  memoryDir: string,
  onChange: () => void,
  debounceMs = 150,
): EventsWatcher {
  const file = path.join(memoryDir, EVENTS_FILENAME);
  if (!existsSync(file)) {
    return { close: () => {} };
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;
  try {
    // Watch the parent directory (not the file directly) — more reliable on
    // macOS/kqueue where file-level watches may miss rapid appends. Filter
    // events to only the events.ndjson filename so unrelated writes are ignored.
    watcher = fsWatch(memoryDir, { persistent: false }, (_event, filename) => {
      if (filename && filename !== EVENTS_FILENAME) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        try { onChange(); } catch (e) { console.warn('mk-graph: watchEvents callback threw', e); }
      }, debounceMs);
    });
    watcher.on('error', (err) => {
      console.warn('mk-graph: events.ndjson watcher error, updates may not reflect new events', err);
    });
  } catch (e) {
    console.warn('mk-graph: watchEvents setup failed', e);
    return { close: () => {} };
  }

  return {
    close() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (watcher) { try { watcher.close(); } catch { /* ignore */ } watcher = null; }
    },
  };
}
