import { cursorPosition, getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
import { PLATFORM } from "./dragPlatform";
import { trackWindowMove } from "../../stores/drag/windowMove";
import { leaveWindowFullscreen, useFullscreenMode } from "./fullscreenMode";

/** How long a fullscreen exit may take to report its resize before the move
 *  starts anyway. */
const UNFULLSCREEN_WAIT_MS = 400;

/** Hand the pressed pointer to the OS window-move loop. Shared by the header's
 *  empty-bar drag and the logo chip, which starts it once the press travels.
 *
 *  `travelled` is the pointer's client position (CSS px) for a press that has
 *  already moved past a click's slop — only the logo passes it. Such a press in
 *  the user's fullscreen mode leaves fullscreen first: a fullscreen window has no
 *  `_NET_WM_ACTION_MOVE` (Windows strips the move styles too), so the WM refuses
 *  the move and the drag used to no-op. A bare press (the empty-bar drag starts
 *  on mousedown) never leaves it — a click must not throw the user out of a
 *  fullscreen they asked for. macOS keeps its own fullscreen Space. */
export function startWindowDrag(travelled?: { x: number; y: number }) {
  if (travelled && PLATFORM !== "macos" && useFullscreenMode.getState().on) {
    void dragOutOfFullscreen(travelled);
    return;
  }
  beginOsMove();
}

function beginOsMove() {
  // Windows: hide the heavy terminal panes for the duration of the OS move loop
  // so WebView2 only composites the cheap frame and keeps up with the cursor
  // (otherwise the canvases lag/swim behind the dragged window). Other engines
  // drag the live content smoothly, so they skip the hide.
  if (PLATFORM === "windows") trackWindowMove();
  getCurrentWindow().startDragging().catch(() => {});
}

/** Leave fullscreen, put the restored window back under the pointer, then move
 *  it. The move starts only while the button is still down: a
 *  `_NET_WM_MOVERESIZE` sent after the release glues the window to the cursor. */
async function dragOutOfFullscreen(at: { x: number; y: number }) {
  const win = getCurrentWindow();
  let released = false;
  const onUp = () => {
    released = true;
  };
  window.addEventListener("mouseup", onUp);
  const wideCss = window.innerWidth;
  let unResized: (() => void) | undefined;
  try {
    // Listen before asking, so the exit's own resize can't slip past.
    let resizedTo: number | undefined;
    const resized = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, UNFULLSCREEN_WAIT_MS);
      win
        .onResized(({ payload }) => {
          resizedTo = payload.width;
          clearTimeout(timer);
          resolve();
        })
        .then((fn) => (unResized = fn))
        .catch(() => {});
    });
    await leaveWindowFullscreen();
    await resized;
    if (released) return;
    await placeUnderPointer(at, wideCss, resizedTo).catch(() => {});
    if (released) return;
    beginOsMove();
  } catch {
    /* the window stays where it is; the next press tries again */
  } finally {
    unResized?.();
    window.removeEventListener("mouseup", onUp);
  }
}

/** The restored window comes back at its old place, often nowhere near the
 *  pointer, and the WM would then drag it at that distance. Move it so the
 *  grabbed point sits under the pointer again — the same x when the narrower
 *  window still reaches it, else the same fraction of the width. A no-op on
 *  Wayland, where the compositor places windows itself. */
async function placeUnderPointer(
  at: { x: number; y: number },
  wideCss: number,
  restoredPhysicalWidth: number | undefined,
) {
  const win = getCurrentWindow();
  const [cursor, scale, inner, outer] = await Promise.all([
    cursorPosition(),
    win.scaleFactor(),
    win.innerPosition(),
    win.outerPosition(),
  ]);
  const narrowCss =
    restoredPhysicalWidth !== undefined ? restoredPhysicalWidth / scale : window.innerWidth;
  const x = at.x < narrowCss || wideCss <= 0 ? at.x : (at.x * narrowCss) / wideCss;
  await win.setPosition(
    new PhysicalPosition(
      Math.round(cursor.x - x * scale - (inner.x - outer.x)),
      Math.round(cursor.y - at.y * scale - (inner.y - outer.y)),
    ),
  );
}
