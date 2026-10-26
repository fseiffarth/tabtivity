/**
 * What the desktop's workspace backend can do — whether a project switch
 * really hides the previous project's app windows (backend
 * `commands::workspace::workspace_capabilities`).
 *
 * The answer is fixed for a running session (the backend is picked once at
 * startup), so it is fetched once per session and shared by every reader:
 * Settings → Layout's parking note and the side panel's Apps view.
 *
 * `null` means "don't know, say nothing": the command is missing (a backend
 * older than this frontend — routine, `src/` hot-reloads ahead of
 * `src-tauri/`), it failed, or the answer lacks the fields — the browser
 * client answers `{}` (`transport/clientAdapters.ts`), since it has no
 * windows of its own to park.
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface WorkspaceCaps {
  /** The backend's name (`x11`, `null`, `kde-wayland`, `windows`, …). */
  backend: string;
  /** A project switch hides the previous project's windows (`can_park`). */
  canPark: boolean;
  /** A Wayland session: only XWayland windows get a window id there, so a
   *  windowless row stays on screen even where `canPark` is true. A backend
   *  older than the field answers without it → `false` (claim nothing). */
  waylandSession: boolean;
}

/** The backend's answer → `WorkspaceCaps`, or `null` when it lacks the
 *  fields (`{}`, `null`, an unmocked test `invoke`). */
export function parseWorkspaceCaps(raw: unknown): WorkspaceCaps | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.can_park !== "boolean") return null;
  return {
    backend: typeof r.backend === "string" ? r.backend : "",
    canPark: r.can_park,
    waylandSession: r.wayland_session === true,
  };
}

/** `undefined` until the one fetch has answered. */
let cached: WorkspaceCaps | null | undefined;
let probe: Promise<WorkspaceCaps | null> | null = null;

/** The one fetch per session; later calls await the same answer. */
export function loadWorkspaceCaps(): Promise<WorkspaceCaps | null> {
  probe ??= Promise.resolve()
    .then(() => invoke<unknown>("workspace_capabilities"))
    .then(parseWorkspaceCaps, () => null)
    .then((caps) => (cached = caps));
  return probe;
}

/** Test seam: forget the cached answer so the next reader fetches again. */
export function resetWorkspaceCaps(): void {
  cached = undefined;
  probe = null;
}

/** The session's workspace capabilities; `null` until (and unless) the
 *  backend gives a usable answer. */
export function useWorkspaceCaps(): WorkspaceCaps | null {
  const [caps, setCaps] = useState<WorkspaceCaps | null>(() => cached ?? null);
  useEffect(() => {
    let live = true;
    void loadWorkspaceCaps().then((c) => {
      if (live) setCaps(c);
    });
    return () => {
      live = false;
    };
  }, []);
  return caps;
}

/** Whether a project switch hides app windows here; `null` = unknown. */
export function useCanPark(): boolean | null {
  return useWorkspaceCaps()?.canPark ?? null;
}

/**
 * Why one Apps-view row stays on screen on a project switch although this
 * desktop parks windows, or `null` when it is parked (or nothing is known).
 * `"wayland"`: a Wayland session where the row has no window id — only
 * XWayland windows can be moved to the hidden workspace, a native Wayland
 * window cannot. (A desktop that parks nothing is said once for the whole
 * list, not per row.)
 */
export function rowStaysVisible(
  caps: WorkspaceCaps | null,
  windowId: number | null | undefined,
): "wayland" | null {
  if (!caps || !caps.canPark || !caps.waylandSession) return null;
  return windowId == null ? "wayland" : null;
}
