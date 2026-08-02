/**
 * Share-image capture for replay and premiere viewing.
 *
 * The game draws to a plain 2D canvas, so the current frame is readable
 * directly with drawImage — no WebGL readback constraints, no headless browser,
 * no server round trip. One capture is a few milliseconds of work in the
 * viewer's own tab.
 *
 * This composes a purpose-built social image rather than a raw screenshot: the
 * frame is cover-cropped to a square, and the standings are re-drawn into the
 * canvas because the live leaderboard is a DOM element and therefore absent
 * from the captured pixels. Redrawing them also lets the layout target a square
 * social crop instead of inheriting whatever shape the viewer's window happens
 * to be.
 *
 * SPOILER SAFETY: this captures only pixels the viewer is already looking at
 * and standings passed in by the caller from the same frame. It cannot reach
 * ahead of the playhead, so it is safe during a sealed live premiere in a way
 * a server-side renderer (which holds the full record) is not.
 */

export interface ReplayShareStanding {
  name: string;
  /** Territory share of the live board, 0..1. */
  share: number;
  /** CSS color for the player's territory. */
  color: string;
  isAlive: boolean;
}

export interface ReplayShareImageInput {
  /** The live game canvas. Read-only; never mutated. */
  source: HTMLCanvasElement;
  standings: readonly ReplayShareStanding[];
  /** Match identity, e.g. "World · Round 814". */
  title: string;
  /** Playhead position, e.g. "Turn 8,004". */
  subtitle: string;
  size?: number;
}

export const SHARE_IMAGE_SIZE = 1080;
export const SHARE_IMAGE_STANDINGS_LIMIT = 5;

/** Canonical Proxy War amber (--pw-accent). */
const ACCENT = "#f4a64a";
const WORDMARK = "Proxy War";
const CTA = "proxywar.xyz/league";

export interface CoverCrop {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * Source rectangle that fills the target without distortion or letterboxing.
 *
 * The viewer's window is almost never square, so a naive full-canvas draw would
 * either squash the map or band it. Cover-cropping keeps the map's proportions
 * and discards the long axis, centered on what the viewer had framed.
 */
export function computeCoverCrop(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): CoverCrop {
  if (
    !(sourceWidth > 0) ||
    !(sourceHeight > 0) ||
    !(targetWidth > 0) ||
    !(targetHeight > 0)
  ) {
    throw new Error(
      `invalid cover crop geometry ${sourceWidth}x${sourceHeight} -> ${targetWidth}x${targetHeight}`,
    );
  }
  const scale = Math.max(
    targetWidth / sourceWidth,
    targetHeight / sourceHeight,
  );
  const sw = Math.min(sourceWidth, targetWidth / scale);
  const sh = Math.min(sourceHeight, targetHeight / scale);
  return { sx: (sourceWidth - sw) / 2, sy: (sourceHeight - sh) / 2, sw, sh };
}

/**
 * Rows to draw: living players by territory, strongest first.
 *
 * Eliminated players are dropped rather than shown at zero — a share image is a
 * snapshot of who is contesting the board right now, and dead rows spend scarce
 * vertical space saying nothing.
 */
export function selectShareStandings(
  standings: readonly ReplayShareStanding[],
  limit: number = SHARE_IMAGE_STANDINGS_LIMIT,
): ReplayShareStanding[] {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`invalid standings limit: ${limit}`);
  }
  return standings
    .filter((row) => row.isAlive)
    .slice()
    .sort((a, b) => b.share - a.share)
    .slice(0, limit);
}

export function formatSharePercent(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return "0%";
  const percent = share * 100;
  // A player holding a real foothold must never read as "0.0%". Early in a
  // 12-player match every share is a fraction of a percent, and rounding them
  // all to zero makes the image look broken rather than early.
  if (percent < 0.1) return "<0.1%";
  return percent < 10 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`;
}

/**
 * Compose the share image. Returns a detached canvas the caller can encode.
 */
export function composeReplayShareImage(
  input: ReplayShareImageInput,
): HTMLCanvasElement {
  const size = input.size ?? SHARE_IMAGE_SIZE;
  const out = document.createElement("canvas");
  out.width = size;
  out.height = size;
  const ctx = out.getContext("2d");
  if (ctx === null) throw new Error("2d context not supported");

  const crop = computeCoverCrop(
    input.source.width,
    input.source.height,
    size,
    size,
  );
  ctx.drawImage(
    input.source,
    crop.sx,
    crop.sy,
    crop.sw,
    crop.sh,
    0,
    0,
    size,
    size,
  );

  const rows = selectShareStandings(input.standings);
  const rowHeight = Math.round(size * 0.052);
  const scrimHeight = Math.round(
    size * 0.1 + rows.length * rowHeight + size * 0.085,
  );
  // Legibility scrim. Without it, light terrain under the standings makes white
  // text unreadable, which is the usual failure of raw gameplay screenshots.
  const scrim = ctx.createLinearGradient(0, size - scrimHeight, 0, size);
  scrim.addColorStop(0, "rgba(8, 10, 14, 0)");
  scrim.addColorStop(0.35, "rgba(8, 10, 14, 0.72)");
  scrim.addColorStop(1, "rgba(8, 10, 14, 0.94)");
  ctx.fillStyle = scrim;
  ctx.fillRect(0, size - scrimHeight, size, scrimHeight);

  const marginX = Math.round(size * 0.055);
  let cursorY = size - scrimHeight + Math.round(size * 0.085);

  ctx.textBaseline = "alphabetic";
  ctx.font = `600 ${Math.round(size * 0.03)}px Inter, ui-sans-serif, system-ui, -apple-system, sans-serif`;
  ctx.fillStyle = "rgba(255, 255, 255, 0.62)";
  ctx.fillText(`${input.title}  ·  ${input.subtitle}`, marginX, cursorY);
  cursorY += Math.round(size * 0.045);

  const dotRadius = Math.round(size * 0.011);
  const nameFontSize = Math.round(size * 0.034);
  for (const row of rows) {
    ctx.beginPath();
    ctx.arc(
      marginX + dotRadius,
      cursorY - nameFontSize * 0.32,
      dotRadius,
      0,
      Math.PI * 2,
    );
    ctx.fillStyle = row.color;
    ctx.fill();

    ctx.font = `500 ${nameFontSize}px Inter, ui-sans-serif, system-ui, -apple-system, sans-serif`;
    ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
    ctx.fillText(
      row.name,
      marginX + dotRadius * 2 + Math.round(size * 0.018),
      cursorY,
    );

    ctx.font = `600 ${nameFontSize}px Inter, ui-sans-serif, system-ui, -apple-system, sans-serif`;
    ctx.fillStyle = ACCENT;
    ctx.textAlign = "right";
    ctx.fillText(formatSharePercent(row.share), size - marginX, cursorY);
    ctx.textAlign = "left";

    cursorY += rowHeight;
  }

  const footerY = size - Math.round(size * 0.038);
  ctx.font = `800 ${Math.round(size * 0.034)}px Inter, ui-sans-serif, system-ui, -apple-system, sans-serif`;
  ctx.fillStyle = "rgba(255, 255, 255, 0.96)";
  ctx.fillText(WORDMARK, marginX, footerY);

  ctx.font = `600 ${Math.round(size * 0.028)}px Inter, ui-sans-serif, system-ui, -apple-system, sans-serif`;
  ctx.fillStyle = ACCENT;
  ctx.textAlign = "right";
  ctx.fillText(CTA, size - marginX, footerY);
  ctx.textAlign = "left";

  return out;
}

export async function replayShareImageBlob(
  canvas: HTMLCanvasElement,
): Promise<Blob> {
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(new Error("share image encoding failed"));
        return;
      }
      resolve(blob);
    }, "image/png");
  });
}

export type ReplayShareImageDelivery = "clipboard" | "download";

/**
 * Put the image where the viewer can use it.
 *
 * Clipboard first — the point is pasting straight into a post — but it needs a
 * secure context, a user gesture, and browser support, so a download fallback
 * always exists. The caller reports which one happened so the button can say so.
 */
export async function deliverReplayShareImage(
  blob: Blob,
  fileName: string,
): Promise<ReplayShareImageDelivery> {
  const clipboard = globalThis.navigator?.clipboard;
  const clipboardItem = (globalThis as { ClipboardItem?: typeof ClipboardItem })
    .ClipboardItem;
  if (clipboard?.write !== undefined && clipboardItem !== undefined) {
    try {
      await clipboard.write([new clipboardItem({ [blob.type]: blob })]);
      return "clipboard";
    } catch {
      // Denied permission or an unsupported type: fall through to download.
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    // Revoking synchronously can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  return "download";
}

export function replayShareImageFileName(runId: string, turn: number): string {
  const safeRun = runId.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 60);
  return `proxywar-${safeRun}-turn-${Math.max(0, Math.trunc(turn))}.png`;
}
