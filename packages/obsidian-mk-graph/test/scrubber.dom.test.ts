// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createScrubber } from '../src/scrubber.js';
import type { Histogram } from '../src/density-histogram.js';

const sampleHist: Histogram = {
  unit: 'day',
  buckets: [
    { start: '2026-04-01T00:00:00Z', count: 0 },
    { start: '2026-04-02T00:00:00Z', count: 3 },
    { start: '2026-04-03T00:00:00Z', count: 1 },
  ],
};

describe('createScrubber', () => {
  it('mounts a scrubber DOM tree with the three mode buttons', () => {
    const root = document.createElement('div');
    const s = createScrubber(root, {
      fromIso: '2026-04-01T00:00:00Z',
      toIso: '2026-04-03T23:59:59Z',
      onModeChange: () => {},
      onPlayheadChange: () => {},
    });
    expect(root.querySelectorAll('.mk-graph-scrubber-mode-btn').length).toBe(3);
    expect(root.querySelector('.mk-graph-scrubber-playhead')).not.toBeNull();
    expect(root.querySelector('.mk-graph-scrubber-time')).not.toBeNull();
    s.destroy();
  });

  it('fires onModeChange with the chosen mode when a mode button is clicked', () => {
    const root = document.createElement('div');
    const onModeChange = vi.fn();
    const s = createScrubber(root, {
      fromIso: '2026-04-01T00:00:00Z',
      toIso: '2026-04-03T23:59:59Z',
      onModeChange,
      onPlayheadChange: () => {},
    });
    const buttons = root.querySelectorAll<HTMLButtonElement>('.mk-graph-scrubber-mode-btn');
    const scrubbed = Array.from(buttons).find((b) => b.dataset.mode === 'scrubbed')!;
    scrubbed.click();
    expect(onModeChange).toHaveBeenCalledWith('scrubbed');
    s.destroy();
  });

  it('renders one bar per histogram bucket on setHistogram', () => {
    const root = document.createElement('div');
    const s = createScrubber(root, {
      fromIso: '2026-04-01T00:00:00Z',
      toIso: '2026-04-03T23:59:59Z',
      onModeChange: () => {},
      onPlayheadChange: () => {},
    });
    s.setHistogram(sampleHist);
    expect(root.querySelectorAll('.mk-graph-scrubber-bar').length).toBe(3);
    s.destroy();
  });

  it('updates the time readout via setPlayhead', () => {
    const root = document.createElement('div');
    const s = createScrubber(root, {
      fromIso: '2026-04-01T00:00:00Z',
      toIso: '2026-04-03T23:59:59Z',
      onModeChange: () => {},
      onPlayheadChange: () => {},
    });
    s.setPlayhead('2026-04-02T12:00:00Z');
    const readout = root.querySelector<HTMLElement>('.mk-graph-scrubber-time');
    expect(readout!.textContent).toContain('2026-04-02');
    s.destroy();
  });

  it('destroy() removes the scrubber tree from the parent', () => {
    const root = document.createElement('div');
    const s = createScrubber(root, {
      fromIso: '2026-04-01T00:00:00Z',
      toIso: '2026-04-03T23:59:59Z',
      onModeChange: () => {},
      onPlayheadChange: () => {},
    });
    expect(root.children.length).toBeGreaterThan(0);
    s.destroy();
    expect(root.children.length).toBe(0);
  });

  it('disables the slider and snaps to far right when Live mode is set', () => {
    const root = document.createElement('div');
    const s = createScrubber(root, {
      fromIso: '2026-04-01T00:00:00Z',
      toIso: '2026-04-30T00:00:00Z',
      onModeChange: () => {},
      onPlayheadChange: () => {},
      initialMode: 'scrubbed',
    });
    const slider = root.querySelector<HTMLInputElement>('.mk-graph-scrubber-playhead')!;
    // Set knob somewhere in the middle while in Scrubbed mode
    slider.value = '500';
    expect(slider.disabled).toBe(false);
    s.setMode('live');
    expect(slider.disabled).toBe(true);
    expect(slider.value).toBe('1000');
    s.destroy();
  });

  it('renders a Play button + Loop checkbox in the header', () => {
    const root = document.createElement('div');
    const s = createScrubber(root, {
      fromIso: '2026-04-01T00:00:00Z',
      toIso: '2026-04-03T23:59:59Z',
      onModeChange: () => {},
      onPlayheadChange: () => {},
    });
    expect(root.querySelector('.mk-graph-scrubber-play-btn')).not.toBeNull();
    expect(root.querySelector<HTMLInputElement>('.mk-graph-scrubber-loop-checkbox')).not.toBeNull();
    expect(root.querySelector<HTMLInputElement>('.mk-graph-scrubber-loop-checkbox')!.type).toBe('checkbox');
    s.destroy();
  });

  it('Play button is disabled in Live mode', () => {
    const root = document.createElement('div');
    const s = createScrubber(root, {
      fromIso: '2026-04-01T00:00:00Z',
      toIso: '2026-04-30T00:00:00Z',
      onModeChange: () => {},
      onPlayheadChange: () => {},
      initialMode: 'live',
    });
    const playBtn = root.querySelector<HTMLButtonElement>('.mk-graph-scrubber-play-btn')!;
    expect(playBtn.disabled).toBe(true);
    s.setMode('scrubbed');
    expect(playBtn.disabled).toBe(false);
    s.destroy();
  });

  it('setRange remaps the slider so a drag emits ISO inside the new range', () => {
    const root = document.createElement('div');
    const onPlayheadChange = vi.fn();
    const s = createScrubber(root, {
      // Initial range is the 1970-to-now dead zone — the very thing that
      // prompted setRange's existence. Without setRange, dragging would emit
      // 1980-ish timestamps regardless of the actual data.
      fromIso: '1970-01-01T00:00:00Z',
      toIso: new Date().toISOString(),
      onModeChange: () => {},
      onPlayheadChange,
    });
    s.setRange('2026-04-01T00:00:00Z', '2026-04-30T00:00:00Z');
    const slider = root.querySelector<HTMLInputElement>('.mk-graph-scrubber-playhead')!;
    slider.value = '500'; // midpoint
    slider.dispatchEvent(new Event('input'));
    expect(onPlayheadChange).toHaveBeenCalledOnce();
    const emitted = onPlayheadChange.mock.calls[0][0];
    expect(emitted >= '2026-04-01T00:00:00Z').toBe(true);
    expect(emitted <= '2026-04-30T00:00:00Z').toBe(true);
    s.destroy();
  });
});
