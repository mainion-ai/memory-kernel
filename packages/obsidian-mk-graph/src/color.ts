/** Convert a "#RRGGBB" / "#RGB" hex string + alpha into an "rgba(r,g,b,a)"
 *  CSS color string. Used by the renderer to bake the F2 confidence-as-edge-
 *  opacity encoding into force-graph's `linkColor` callback (force-graph
 *  1.x has no separate `linkOpacity` setter — see Task 10 review notes).
 *
 *  Returns the input unchanged when it doesn't match the hex pattern, so a
 *  caller passing an already-rgba string degrades gracefully.
 */
export function hexToRgba(hex: string, alpha: number): string {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return hex;
  const h = m[1];
  let r: number;
  let g: number;
  let b: number;
  if (h.length === 3) {
    r = parseInt(h[0] + h[0], 16);
    g = parseInt(h[1] + h[1], 16);
    b = parseInt(h[2] + h[2], 16);
  } else {
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
