import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { confirmOsOpen, isLauncherRefusal, showLauncherRefusal } from "../lib/openExternal";

export interface TrackedWindow {
  id: string;
  exec: string;
  file: string | null;
  pid: number;
  project_id: string | null;
  role: string | null;
  opened_at: number;
  window_id: number | null;
  origin: string;
}

interface WindowsStore {
  windows: TrackedWindow[];
  refresh: (projectId?: string) => Promise<void>;
  launch: (exec: string, file?: string, projectId?: string) => Promise<TrackedWindow>;
  untrack: (id: string) => Promise<void>;
  /** Close the launched app (kill its process subtree) and drop its entry.
   *  Rows the backend cannot signal (pid 0: OS-default opens, hand-offs)
   *  fall back to a plain untrack — either way the row ends up gone. */
  closeApp: (id: string) => Promise<void>;
  /** Open `path` outside the app. With no `handler` the OS (or the user's
   *  default app for the type) picks the program, so the user is asked
   *  first, naming the file, and a launcher or executable is refused with a
   *  note (threat recheck gap 21, decision C2). Resolves `null` when nothing
   *  was opened (declined or refused). */
  openFile: (
    path: string,
    handler?: string,
    projectId?: string | null,
    origin?: string,
    // Physical desktop coordinates to place the launched window at (X11 only,
    // best-effort). Used to open an external app on the screen a file was
    // dropped onto. Omitted → the WM places the window.
    position?: { x: number; y: number },
  ) => Promise<TrackedWindow | null>;
}

export const useWindowsStore = create<WindowsStore>((set) => ({
  windows: [],

  // Merge-refresh: replace only the requested project's slice. The store is
  // one array shared by every mounted viewer (side panel, Files tabs, docked
  // columns), so a wholesale replace would let concurrent viewers clobber
  // each other's projects.
  refresh: async (projectId) => {
    const fetched = await invoke<TrackedWindow[]>("get_opened_windows", {
      projectId: projectId ?? null,
    });
    const scope = projectId ?? null;
    set((s) => ({
      windows: [...s.windows.filter((w) => (w.project_id ?? null) !== scope), ...fetched],
    }));
  },

  launch: async (exec, file, projectId) => {
    const win = await invoke<TrackedWindow>("launch_app", {
      exec,
      file: file ?? null,
      projectId: projectId ?? null,
      role: null,
    });
    set((s) => ({ windows: [...s.windows, win] }));
    return win;
  },

  untrack: async (id) => {
    await invoke("untrack_window", { id });
    set((s) => ({ windows: s.windows.filter((w) => w.id !== id) }));
  },

  closeApp: async (id) => {
    // Optimistic: the row leaves immediately; the backend confirms via the
    // app-windows-changed event → refresh.
    set((s) => ({ windows: s.windows.filter((w) => w.id !== id) }));
    try {
      await invoke("close_tracked_window", { id });
    } catch {
      // "not closeable" (pid 0) or a backend predating the command: at least
      // drop the registry entry so the list and the registry agree.
      try {
        await invoke("untrack_window", { id });
      } catch {
        // Nothing left to do — the optimistic removal stands.
      }
    }
  },

  openFile: async (path, handler, projectId, origin, position) => {
    const args = {
      path,
      handler: handler ?? null,
      projectId: projectId ?? null,
      origin: origin ?? null,
      x: position?.x ?? null,
      y: position?.y ?? null,
    };
    const track = (win: TrackedWindow) => {
      set((s) => ({ windows: [...s.windows, win] }));
      return win;
    };
    if (!handler) {
      let early: TrackedWindow | null = null;
      const asked = await confirmOsOpen(path, async () => {
        early = await invoke<TrackedWindow | null>("open_file", { ...args, checkOnly: true });
        return early;
      });
      // A backend without `checkOnly` opened it on the check already.
      if (asked === "opened" && early) return track(early);
      if (asked !== "open") return null;
    }
    try {
      const win = await invoke<TrackedWindow | null>("open_file", args);
      return win ? track(win) : null;
    } catch (err) {
      // The file became a launcher between the check and the open.
      if (!isLauncherRefusal(err)) throw err;
      await showLauncherRefusal(path);
      return null;
    }
  },
}));

let windowsEventsInstalled = false;

/** Subscribe this window to backend app-registry changes (a launched app
 *  exiting, a close finishing) and fold them in via a scoped refresh. Called
 *  once per window root (AppShell / DetachedApp); the flag is per JS heap, so
 *  each window installs exactly one listener. */
export function installWindowsEvents(): void {
  if (windowsEventsInstalled) return;
  windowsEventsInstalled = true;
  void listen<{ project_id: string | null }>("app-windows-changed", (e) => {
    void useWindowsStore.getState().refresh(e.payload?.project_id ?? undefined);
  });
}
