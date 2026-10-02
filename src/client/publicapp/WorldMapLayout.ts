/**
 * Fitting the pixel world to the page, shared by the front page and
 * `/world`: the map's width, and its labels kept apart and on screen.
 */

/**
 * The map's drawn width for the space available: a whole multiple of the
 * grid when the space is within 5% of one (1440 px snaps to 1500, cropping
 * a little ocean), so every tile is the same size and siege hatching never
 * shimmers; otherwise the space itself.
 */
export function pixelMapWidth(available: number, gridWidth: number): number {
  const scale = available / gridWidth;
  const whole = Math.round(scale);
  return whole >= 2 && Math.abs(whole - scale) / scale <= 0.05
    ? whole * gridWidth
    : available;
}

/**
 * Keeps labels apart and inside `bounds`. In order, each label moves inside
 * the bounds, then down past any label already placed that it would cover,
 * or up when that would push it past the bottom edge. Offsets are written as
 * margins, so a label's own transform still applies. Hidden labels (zero
 * width) are skipped.
 */
export function separateLabels(
  labels: readonly HTMLElement[],
  bounds: DOMRect,
  pad = 8,
): void {
  for (const label of labels) {
    label.style.marginLeft = "0px";
    label.style.marginTop = "0px";
  }
  const placed: DOMRect[] = [];
  for (const label of labels) {
    const rect = label.getBoundingClientRect();
    if (rect.width === 0) continue;
    let dx = 0;
    if (rect.right > bounds.right - pad) dx = bounds.right - pad - rect.right;
    if (rect.left + dx < bounds.left + pad) dx = bounds.left + pad - rect.left;
    let dy = 0;
    for (let pass = 0; pass < 4; pass++) {
      const top = rect.top + dy;
      const left = rect.left + dx;
      const hit = placed.find(
        (other) =>
          left < other.right + 4 &&
          left + rect.width > other.left - 4 &&
          top < other.bottom + 4 &&
          top + rect.height > other.top - 4,
      );
      if (hit === undefined) break;
      const below = hit.bottom + 4 - top;
      dy +=
        rect.bottom + dy + below > bounds.bottom - pad
          ? hit.top - 4 - (rect.bottom + dy)
          : below;
    }
    if (dx !== 0) label.style.marginLeft = `${Math.round(dx)}px`;
    if (dy !== 0) label.style.marginTop = `${Math.round(dy)}px`;
    placed.push(label.getBoundingClientRect());
  }
}
