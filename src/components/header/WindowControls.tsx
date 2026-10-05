import {
  getCurrentWindow,
  currentMonitor,
  LogicalSize,
  LogicalPosition,
} from "@tauri-apps/api/window";
import { IS_MAC, IS_LINUX } from "../../lib/platform";
import { useT } from "../../lib/i18n";
import { toggleWindowFullscreen, useFullscreenMode } from "../../lib/window/fullscreenMode";

// Toggle maximize with a clean restore geometry on Linux.
//
// The window opens maximized (tauri.conf.json `maximized: true`), so it never had
// a smaller "normal" size — KWin's saved restore geometry is the full monitor.
// A plain `unmaximize()` therefore "restores" to the same full size: the window
// looks unchanged AND it stays in a maximized/tiled internal state, so dragging it
// to the top edge has nothing to snap (KWin's electric-border snap is suppressed).
// On restore we assign an explicit centered, default-sized geometry so KWin sees a
// genuine floating window and re-arms edge-snapping. Windows' Aero Snap handles
// `toggleMaximize` natively, so it keeps the simple path.
async function toggleMaximize() {
  const win = getCurrentWindow();
  if (!IS_LINUX) {
    await win.toggleMaximize();
    return;
  }
  if (!(await win.isMaximized())) {
    await win.maximize();
    return;
  }
  await win.unmaximize();
  const monitor = await currentMonitor();
  if (!monitor) return;
  const scale = monitor.scaleFactor || 1;
  const monW = monitor.size.width / scale;
  const monH = monitor.size.height / scale;
  const w = Math.min(1400, Math.round(monW * 0.9));
  const h = Math.min(900, Math.round(monH * 0.9));
  const x = Math.round(monitor.position.x / scale + (monW - w) / 2);
  const y = Math.round(monitor.position.y / scale + (monH - h) / 2);
  await win.setSize(new LogicalSize(w, h));
  await win.setPosition(new LogicalPosition(x, y));
}

export function WindowControls() {
  const t = useT();
  const fullscreen = useFullscreenMode((s) => s.on);
  // macOS draws native traffic-light buttons (top-left) via the Overlay title-bar
  // style configured in tauri.macos.conf.json, so Tabtivity's own controls would be
  // redundant — and on the wrong side. Render nothing there.
  if (IS_MAC) return null;

  // Run a window op and surface failures. On Windows a rejected IPC call (e.g. a
  // missing `core:window:*` capability) would otherwise leave the button looking
  // dead with no clue why; log it so it shows up in the webview console.
  const run = (label: string, op: () => Promise<unknown>) => {
    op().catch((err) => console.error(`window ${label} failed`, err));
  };

  // The header runs an `onMouseDown` drag handler (`startDragging`). On WebView2
  // that native move-loop can swallow the press that should fire the button's
  // click, so stop the event before it reaches the header — the `closest()` gate
  // there already excludes us, but isolating the press makes the controls
  // reliable on Windows regardless.
  const isolate = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div className="wm-controls no-drag" onMouseDown={isolate}>
      {/* Shared by the main window and every popout; F11 is the same toggle. */}
      <button
        className="wm-btn wm-fullscreen"
        onMouseDown={isolate}
        onClick={() => run("toggle-fullscreen", toggleWindowFullscreen)}
        title={t(fullscreen ? "windowControls.exitFullscreen" : "windowControls.fullscreen")}
        aria-label={t(fullscreen ? "windowControls.exitFullscreen" : "windowControls.fullscreen")}
        aria-pressed={fullscreen}
      />
      <button
        className="wm-btn wm-minimize"
        onMouseDown={isolate}
        onClick={() => run("minimize", () => getCurrentWindow().minimize())}
        title={t("windowControls.minimize")}
        aria-label={t("windowControls.minimize")}
      />
      <button
        className="wm-btn wm-maximize"
        onMouseDown={isolate}
        onClick={() => run("toggle-maximize", toggleMaximize)}
        title={t("windowControls.maximize")}
        aria-label={t("windowControls.maximize")}
      />
      <button
        className="wm-btn wm-close"
        onMouseDown={isolate}
        onClick={() => run("close", () => getCurrentWindow().close())}
        title={t("common.close")}
        aria-label={t("common.close")}
      />
    </div>
  );
}
