import { readJson, writeJson, type JsonStorage } from "../persist";
import { storageKey } from "../brand";

/**
 * Whether the recent-Downloads section under the file tree is shown, remembered
 * per kind of host: the side panel, and the Files (Project) viewer tabs. Each
 * viewer seeds from its kind's last state on mount and writes every toggle
 * back, so a project switch (the panel remounts), a new tab or a relaunch opens
 * the way the user last left it. Shown until the user has turned it off.
 *
 * A convenience in localStorage (`lib/persist`): lost storage only means the
 * section is back to shown.
 */
export type DownloadsHost = "sidePanel" | "fileViewer";

const STORAGE_KEY = storageKey("downloadsShown");

type Shown = Partial<Record<DownloadsHost, boolean>>;

function read(storage?: JsonStorage): Shown {
  return readJson(
    STORAGE_KEY,
    (raw) => {
      const out: Shown = {};
      if (!raw || typeof raw !== "object") return out;
      for (const host of ["sidePanel", "fileViewer"] as const) {
        const v = (raw as Record<string, unknown>)[host];
        if (typeof v === "boolean") out[host] = v;
      }
      return out;
    },
    {},
    storage,
  );
}

export function readDownloadsShown(host: DownloadsHost, storage?: JsonStorage): boolean {
  return read(storage)[host] ?? true;
}

/** Re-reads first, so the other host's value (or a popout's write — one origin,
 *  one localStorage) is never clobbered by a stale copy. */
export function writeDownloadsShown(host: DownloadsHost, shown: boolean, storage?: JsonStorage): void {
  writeJson(STORAGE_KEY, { ...read(storage), [host]: shown }, storage);
}
