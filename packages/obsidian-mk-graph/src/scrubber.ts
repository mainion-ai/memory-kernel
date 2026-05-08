import type { Histogram } from './density-histogram.js';

export type ReplayMode = 'live' | 'scrubbed' | 'diff';

export interface ScrubberOptions {
  fromIso: string;
  toIso: string;
  onModeChange: (mode: ReplayMode) => void;
  /** Fired with an ISO8601 timestamp as the user drags. Throttle on the
   *  callback side if needed — the slider fires on every input event. */
  onPlayheadChange: (iso: string) => void;
  initialMode?: ReplayMode;
  initialPlayheadIso?: string;
}

export interface ScrubberHandle {
  setHistogram(h: Histogram): void;
  setPlayhead(iso: string): void;
  setMode(mode: ReplayMode): void;
  /** Update the time range the slider maps over. Without this, the slider
   *  is stuck at whatever range was passed at construction time — and a
   *  range like [1970, now] makes the useful-event portion a microscopic
   *  fraction of the slider's interaction width. */
  setRange(fromIso: string, toIso: string): void;
  destroy(): void;
}

const MODES: ReplayMode[] = ['live', 'scrubbed', 'diff'];

/**
 * Mount the scrubber overlay into `parent`. The scrubber draws:
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ [Live] [Scrubbed] [Diff]   2026-04-15T10:30:00Z              │
 *   │ ▁▁▃▅▂▁▁▃▇▅▃▁▁▁  ← density histogram                          │
 *   │ ━━━━━━●━━━━━━━━━━━━━━━━━━  ← playhead range slider           │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Returns a handle for setting state from the controller. `destroy()`
 * removes every DOM node it created and detaches its listeners.
 */
export function createScrubber(parent: HTMLElement, opts: ScrubberOptions): ScrubberHandle {
  // Mutable so setRange() can update them; the slider input handler closes
  // over these and reads the current values on each event.
  let fromMs = Date.parse(opts.fromIso);
  let toMs = Date.parse(opts.toIso);

  const root = parent.ownerDocument.createElement('div');
  root.classList.add('mk-graph-scrubber');

  // Header row: mode buttons + time readout
  const header = root.ownerDocument.createElement('div');
  header.classList.add('mk-graph-scrubber-header');
  root.appendChild(header);

  const modeGroup = root.ownerDocument.createElement('div');
  modeGroup.classList.add('mk-graph-scrubber-modes');
  header.appendChild(modeGroup);

  const buttons = new Map<ReplayMode, HTMLButtonElement>();
  for (const mode of MODES) {
    const btn = root.ownerDocument.createElement('button');
    btn.classList.add('mk-graph-scrubber-mode-btn');
    btn.dataset.mode = mode;
    btn.textContent = mode[0].toUpperCase() + mode.slice(1);
    btn.addEventListener('click', () => {
      setActiveMode(mode);
      opts.onModeChange(mode);
    });
    modeGroup.appendChild(btn);
    buttons.set(mode, btn);
  }

  const time = root.ownerDocument.createElement('div');
  time.classList.add('mk-graph-scrubber-time');
  header.appendChild(time);

  // Body row: a flex container with two columns —
  //   * timeline (flex: 1): histogram + slider stacked, both share width
  //   * controls (flex: 0 0 auto): Play + Loop, vertically aligned to the
  //     slider's row via align-self: flex-end on the controls.
  // This keeps the histogram and slider visually identical in width while
  // putting Play/Loop to the right of the slider on the same horizontal
  // line.
  const body = root.ownerDocument.createElement('div');
  body.classList.add('mk-graph-scrubber-body');
  root.appendChild(body);

  const timeline = root.ownerDocument.createElement('div');
  timeline.classList.add('mk-graph-scrubber-timeline');
  body.appendChild(timeline);

  // Histogram row
  const histRow = root.ownerDocument.createElement('div');
  histRow.classList.add('mk-graph-scrubber-histogram');
  timeline.appendChild(histRow);

  // Playhead slider — hybrid custom-visual + native-interaction.
  //
  // Earlier versions (v0.2.4 / v0.2.5 / v0.2.6) styled the native <input
  // type="range"> directly. WebKit's runnable-track is full-width on paper
  // but its thumb-aware layout introduced ~7px insets on each side that
  // made the visible track noticeably shorter than the histogram. v0.2.7
  // swaps to a hybrid: the visible track / fill / thumb are absolutely-
  // positioned divs inside a wrapper (so they are PROVABLY full width via
  // `left: 0; right: 0`), and a transparent native input layered on top
  // handles all interaction (click-to-position, drag, focus, keyboard).
  // Tests that read `slider.value` / `slider.disabled` keep working
  // because the native input is still there.
  const playheadWrapper = root.ownerDocument.createElement('div');
  playheadWrapper.classList.add('mk-graph-scrubber-playhead-wrapper');
  timeline.appendChild(playheadWrapper);

  const playheadTrack = root.ownerDocument.createElement('div');
  playheadTrack.classList.add('mk-graph-scrubber-playhead-track');
  playheadWrapper.appendChild(playheadTrack);

  const playheadFill = root.ownerDocument.createElement('div');
  playheadFill.classList.add('mk-graph-scrubber-playhead-fill');
  playheadTrack.appendChild(playheadFill);

  const playheadThumb = root.ownerDocument.createElement('div');
  playheadThumb.classList.add('mk-graph-scrubber-playhead-thumb');
  playheadWrapper.appendChild(playheadThumb);

  const slider = root.ownerDocument.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '1000';
  slider.step = '1';
  slider.value = '1000';
  slider.classList.add('mk-graph-scrubber-playhead');
  // Allow keyboard navigation: native <input type="range"> handles ←/→ /
  // Page Up/Down / Home / End out of the box once focused.
  slider.tabIndex = 0;
  playheadWrapper.appendChild(slider);

  function updatePlayheadVisual(): void {
    const fracPct = parseInt(slider.value, 10) / 10; // 0..1000 → 0..100
    playheadWrapper.style.setProperty('--mk-frac', `${fracPct}%`);
  }
  updatePlayheadVisual();

  /** Single source of truth for value updates. Routes from both the
   *  wrapper-level pointer handlers and the hidden input's native `input`
   *  event (fired by keyboard arrows + by tests via dispatchEvent). */
  function applySliderValue(v: number, fireChange: boolean): void {
    const clamped = Math.max(0, Math.min(1000, Math.round(v)));
    if (parseInt(slider.value, 10) !== clamped) {
      slider.value = String(clamped);
    }
    updatePlayheadVisual();
    if (fireChange) {
      const frac = clamped / 1000;
      const ms = fromMs + frac * Math.max(1, toMs - fromMs);
      const iso = new Date(ms).toISOString();
      setReadout(iso);
      opts.onPlayheadChange(iso);
    }
  }

  // Hidden-input path: native keyboard navigation + test-friendly value
  // setter. The input itself has `pointer-events: none` so it doesn't
  // intercept clicks (the wrapper handles those instead).
  slider.addEventListener('input', () => {
    applySliderValue(parseInt(slider.value, 10), true);
  });
  slider.addEventListener('keydown', (ev) => {
    if (ev.key.startsWith('Arrow') || ev.key === 'PageUp' || ev.key === 'PageDown' || ev.key === 'Home' || ev.key === 'End') {
      stopPlay();
    }
  });

  // Wrapper-level pointer handling: click anywhere on the slider area to
  // jump there; drag to scrub. Pointer capture lets the drag continue
  // even if the cursor leaves the wrapper.
  let dragPointerId: number | null = null;
  function fractionFromEvent(ev: PointerEvent): number {
    const rect = playheadWrapper.getBoundingClientRect();
    if (rect.width === 0) return 0;
    const x = Math.max(0, Math.min(rect.width, ev.clientX - rect.left));
    return x / rect.width;
  }
  playheadWrapper.addEventListener('pointerdown', (ev) => {
    if (slider.disabled) return;
    if (ev.button !== 0) return;
    dragPointerId = ev.pointerId;
    try { playheadWrapper.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
    slider.focus(); // route subsequent keyboard arrows to the input
    stopPlay();
    applySliderValue(fractionFromEvent(ev) * 1000, true);
    ev.preventDefault();
  });
  playheadWrapper.addEventListener('pointermove', (ev) => {
    if (dragPointerId !== ev.pointerId) return;
    applySliderValue(fractionFromEvent(ev) * 1000, true);
  });
  function endDrag(ev: PointerEvent): void {
    if (dragPointerId === ev.pointerId) {
      dragPointerId = null;
      try { playheadWrapper.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
    }
  }
  playheadWrapper.addEventListener('pointerup', endDrag);
  playheadWrapper.addEventListener('pointercancel', endDrag);

  // Controls (right of slider, on the same row).
  const controls = root.ownerDocument.createElement('div');
  controls.classList.add('mk-graph-scrubber-controls');
  body.appendChild(controls);

  const playBtn = root.ownerDocument.createElement('button');
  playBtn.classList.add('mk-graph-scrubber-play-btn');
  playBtn.type = 'button';
  playBtn.textContent = '▶';
  playBtn.title = 'Play history (animates the playhead from start to end)';
  playBtn.setAttribute('aria-label', 'Play');
  controls.appendChild(playBtn);

  const loopLabel = root.ownerDocument.createElement('label');
  loopLabel.classList.add('mk-graph-scrubber-loop-label');
  loopLabel.title = 'Loop playback when reaching the end';
  const loopCheckbox = root.ownerDocument.createElement('input');
  loopCheckbox.type = 'checkbox';
  loopCheckbox.classList.add('mk-graph-scrubber-loop-checkbox');
  loopLabel.appendChild(loopCheckbox);
  loopLabel.appendChild(root.ownerDocument.createTextNode('Loop'));
  controls.appendChild(loopLabel);

  parent.appendChild(root);

  function setActiveMode(mode: ReplayMode): void {
    for (const [m, btn] of buttons) {
      btn.classList.toggle('is-active', m === mode);
    }
    // Live mode is read-only: disable the slider and Play button, snap the
    // knob to the far right so it visually reflects "now", and halt any
    // ongoing auto-playback. Both the user-driven click path AND the
    // external setMode() path go through this function.
    const live = mode === 'live';
    slider.disabled = live;
    playBtn.disabled = live;
    playheadWrapper.classList.toggle('is-disabled', live);
    if (live) {
      stopPlay();
      slider.value = '1000';
      updatePlayheadVisual();
    }
  }

  function setReadout(iso: string): void {
    time.textContent = iso;
  }

  function setHistogram(h: Histogram): void {
    histRow.replaceChildren();
    const max = h.buckets.reduce((m, b) => Math.max(m, b.count), 1);
    for (const b of h.buckets) {
      const bar = root.ownerDocument.createElement('div');
      bar.classList.add('mk-graph-scrubber-bar');
      // Accent-color bars that have events; CSS min-height keeps empty
      // buckets visible as a faint baseline so the histogram reads as a
      // continuous timeline rather than a sparse set of bars.
      if (b.count > 0) bar.classList.add('has-events');
      const heightPct = (b.count / max) * 100;
      bar.style.height = `${heightPct}%`;
      bar.title = `${b.start}: ${b.count}`;
      histRow.appendChild(bar);
    }
  }

  function setPlayhead(iso: string): void {
    // Skip the knob move while the slider is disabled (Live mode) — Live is
    // read-only and the knob stays pinned to the far right by setActiveMode.
    // The readout still updates so the user sees the current asOf.
    if (!slider.disabled) {
      const ms = Date.parse(iso);
      if (Number.isFinite(ms) && toMs > fromMs) {
        const frac = Math.min(1, Math.max(0, (ms - fromMs) / (toMs - fromMs)));
        slider.value = String(Math.round(frac * 1000));
        updatePlayheadVisual();
      }
    }
    setReadout(iso);
  }

  function setMode(mode: ReplayMode): void {
    setActiveMode(mode);
  }

  // --- Playback (Play / Pause + Loop) ---
  // Animates the slider from its current position to the right end over
  // PLAY_DURATION_MS. Each tick fires the slider's `input` event so the
  // controller pipeline (setPlayhead → state.replace → renderer) runs as if
  // the user were dragging. Mode determines the visual outcome — Scrubbed
  // shows historical state, Diff shows cumulative diff, Live ignores it
  // (and the button is disabled there anyway).
  const PLAY_DURATION_MS = 15000; // full sweep over 15 seconds
  let isPlaying = false;
  let rafId: number | null = null;
  let playStartTs = 0;
  let playStartFrac = 0;

  function startPlay(): void {
    if (isPlaying || slider.disabled) return;
    isPlaying = true;
    playBtn.textContent = '⏸';
    playBtn.title = 'Pause';
    playBtn.setAttribute('aria-label', 'Pause');
    playStartTs = performance.now();
    playStartFrac = parseInt(slider.value, 10) / 1000;
    if (playStartFrac >= 0.999) playStartFrac = 0; // restart from the beginning if at end
    tickPlay();
  }

  function stopPlay(): void {
    if (!isPlaying) return;
    isPlaying = false;
    playBtn.textContent = '▶';
    playBtn.title = 'Play history (animates the playhead from start to end)';
    playBtn.setAttribute('aria-label', 'Play');
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  function tickPlay(): void {
    if (!isPlaying) return;
    const elapsed = performance.now() - playStartTs;
    let frac = playStartFrac + elapsed / PLAY_DURATION_MS;
    if (frac >= 1) {
      if (loopCheckbox.checked) {
        playStartTs = performance.now();
        playStartFrac = 0;
        frac = 0;
      } else {
        frac = 1;
        slider.value = String(Math.round(frac * 1000));
        slider.dispatchEvent(new Event('input'));
        stopPlay();
        return;
      }
    }
    slider.value = String(Math.round(frac * 1000));
    slider.dispatchEvent(new Event('input'));
    rafId = requestAnimationFrame(tickPlay);
  }

  playBtn.addEventListener('click', () => {
    if (isPlaying) stopPlay();
    else startPlay();
  });

  function setRange(newFromIso: string, newToIso: string): void {
    const newFromMs = Date.parse(newFromIso);
    const newToMs = Date.parse(newToIso);
    if (!Number.isFinite(newFromMs) || !Number.isFinite(newToMs)) return;
    if (newToMs <= newFromMs) return;
    fromMs = newFromMs;
    toMs = newToMs;
    // Re-anchor the slider knob to the current readout's iso so the visual
    // position stays consistent with the displayed timestamp after a range
    // change. If the previous readout falls outside the new range, setPlayhead
    // clamps it to the nearest end.
    const currentReadout = time.textContent ?? '';
    if (currentReadout) setPlayhead(currentReadout);
  }

  // Initial state
  setActiveMode(opts.initialMode ?? 'live');
  setReadout(opts.initialPlayheadIso ?? opts.toIso);

  function destroy(): void {
    if (root.parentNode === parent) parent.removeChild(root);
  }

  return { setHistogram, setPlayhead, setMode, setRange, destroy };
}
