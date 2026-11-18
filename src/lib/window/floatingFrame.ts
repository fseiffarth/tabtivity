/**
 * The pure frame math of the floating windows: the root console and the header
 * overlays (mail, calendar, to-do, machines, models) all move, resize and fill
 * through it (`common/useFloatingFrame`), and the persisted `{frame, filled}` row
 * of each is read back through the same clamp.
 */

/**
 * Where the console floats and how big it is — the frame a move or a resize
 * writes. `null` means "as it opens": the size the stylesheet gives it, centred
 * by the backdrop, which is what everyone who never drags it keeps.
 */
export interface RootOverlayFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Below this the console stops being a terminal and becomes a sliver. */
export const MIN_ROOT_OVERLAY_WIDTH = 420;
export const MIN_ROOT_OVERLAY_HEIGHT = 240;
/** What a filled console leaves of the window on each side. */
export const ROOT_OVERLAY_FILL_MARGIN = 16;

/** Which edge (or the whole thing) a frame drag is moving. */
export type RootOverlayDragMode = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/**
 * Keep a frame inside the window and above the minimum. Applied on every write
 * AND on every read: the frame is remembered across relaunches, so the monitor
 * it was sized on is regularly not the one it opens on.
 */
export function clampRootOverlayFrame(
  frame: RootOverlayFrame,
  viewportWidth: number,
  viewportHeight: number,
): RootOverlayFrame {
  const width = Math.round(
    Math.min(Math.max(frame.width, MIN_ROOT_OVERLAY_WIDTH), Math.max(viewportWidth, MIN_ROOT_OVERLAY_WIDTH)),
  );
  const height = Math.round(
    Math.min(Math.max(frame.height, MIN_ROOT_OVERLAY_HEIGHT), Math.max(viewportHeight, MIN_ROOT_OVERLAY_HEIGHT)),
  );
  return {
    width,
    height,
    x: Math.round(Math.min(Math.max(frame.x, 0), Math.max(viewportWidth - width, 0))),
    y: Math.round(Math.min(Math.max(frame.y, 0), Math.max(viewportHeight - height, 0))),
  };
}

/** The frame a filled console takes: the window, less one margin all round. */
export function filledRootOverlayFrame(
  viewportWidth: number,
  viewportHeight: number,
): RootOverlayFrame {
  const m = ROOT_OVERLAY_FILL_MARGIN;
  return clampRootOverlayFrame(
    { x: m, y: m, width: viewportWidth - 2 * m, height: viewportHeight - 2 * m },
    viewportWidth,
    viewportHeight,
  );
}

/**
 * The frame a drag of `mode` produces, pure so the whole gesture is testable.
 *
 * The one rule that is not arithmetic: an edge dragged PAST the minimum pins
 * the opposite edge rather than sliding it — dragging the left edge right past
 * the minimum width must stop the console shrinking, not start pushing it
 * across the screen.
 */
export function rootOverlayFrameDrag(
  start: RootOverlayFrame,
  mode: RootOverlayDragMode,
  dx: number,
  dy: number,
  viewportWidth: number,
  viewportHeight: number,
): RootOverlayFrame {
  if (mode === "move") {
    return clampRootOverlayFrame(
      { ...start, x: start.x + dx, y: start.y + dy },
      viewportWidth,
      viewportHeight,
    );
  }
  let { x, y, width, height } = start;
  if (mode.includes("e")) width = start.width + dx;
  if (mode.includes("s")) height = start.height + dy;
  if (mode.includes("w")) {
    width = start.width - dx;
    x = start.x + dx;
  }
  if (mode.includes("n")) {
    height = start.height - dy;
    y = start.y + dy;
  }
  if (width < MIN_ROOT_OVERLAY_WIDTH) {
    if (mode.includes("w")) x = start.x + start.width - MIN_ROOT_OVERLAY_WIDTH;
    width = MIN_ROOT_OVERLAY_WIDTH;
  }
  if (height < MIN_ROOT_OVERLAY_HEIGHT) {
    if (mode.includes("n")) y = start.y + start.height - MIN_ROOT_OVERLAY_HEIGHT;
    height = MIN_ROOT_OVERLAY_HEIGHT;
  }
  return clampRootOverlayFrame({ x, y, width, height }, viewportWidth, viewportHeight);
}
