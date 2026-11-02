import { useEffect } from "react";
import { useSettingsStore } from "../../stores/settings";
import { IS_LINUX } from "../platform";
import { isConnectWindow, isServerClient } from "../transport/linkState";

/**
 * Whether this window paints on the CPU, the default on Linux: the backend sets
 * `WEBKIT_DISABLE_DMABUF_RENDERER=1` unless `gpu_compositing` is on
 * (`services::webkit_gpu`), and then one renderer thread rasterizes every frame.
 *
 * Read from the same setting rather than asked of the backend. An exported
 * WebKit variable or a switch not yet restarted into can make this wrong, and
 * wrong only costs or restores a little motion.
 */
export function paintsInSoftware(webkitGtk: boolean, gpuCompositing: boolean | undefined): boolean {
  return webkitGtk && gpuCompositing !== true;
}

/** A Linux app window, the Connect window included. A browser client paints with
 *  that browser's own GPU, whatever OS it runs on. */
function isWebkitGtkWindow(): boolean {
  return IS_LINUX && (!isServerClient() || isConnectWindow());
}

/** Publish the paint path as `data-software-paint`, where `base.css` zeroes the
 *  surface motion and `onboarding.css` stills the hints. Call it from each window
 *  root (`AppShell`, `DetachedApp`): every window is its own document. */
export function useSoftwarePaintAttribute(): void {
  const gpuCompositing = useSettingsStore((s) => s.settings?.gpu_compositing);
  useEffect(() => {
    const root = document.documentElement;
    if (paintsInSoftware(isWebkitGtkWindow(), gpuCompositing)) root.dataset.softwarePaint = "on";
    else delete root.dataset.softwarePaint;
  }, [gpuCompositing]);
}
