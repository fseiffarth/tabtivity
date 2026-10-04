/**
 * The Local models sheet's pure half: ordering, what a loaded model's
 * placement and keep-alive say, how often the list is read, and the Home
 * row's caption. The sheet (`screens/LocalModelsSheet.tsx`) renders these;
 * nothing here talks to the host.
 */
import type { LocalModelList, LocalModelRow } from "./api";
import { sizeLabel } from "./terminal/fileLabels";

/** Read again this soon while something is moving — a load, a start, or a
 * request of the phone's own still on its way. */
export const FAST_POLL = 2_500;
/** And this often otherwise, while the sheet is open. */
export const SLOW_POLL = 10_000;

const STATE_RANK: Record<LocalModelRow["state"], number> = { loaded: 0, loading: 1, failed: 2, idle: 2 };

/** Loaded models first, then loading ones, then the rest — each by name. */
export function sortModels(models: readonly LocalModelRow[]): LocalModelRow[] {
  return [...models].sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || a.name.localeCompare(b.name));
}

export type Placement = { key: "onGpu" } | { key: "partGpu"; pct: number } | { key: "onCpu" };

/** Where a loaded model sits. Null when it is not loaded or a reading is
 * missing: an absent size is unknown, not "on the CPU". */
export function placementKey(row: LocalModelRow): Placement | null {
  if (row.state !== "loaded" || row.vram === undefined || !row.loaded_size) return null;
  if (row.vram >= row.loaded_size) return { key: "onGpu" };
  if (row.vram === 0) return { key: "onCpu" };
  const pct = Math.min(99, Math.max(1, Math.round((row.vram / row.loaded_size) * 100)));
  return { key: "partGpu", pct };
}

export type KeepAlive = { key: "pinned" } | { key: "expires"; minutes: number };

/** How long a loaded model stays: pinned (`keep_alive: -1`), or the minutes
 * left, rounded up so a model never reads "0 min" while still resident. */
export function keepAliveKey(row: LocalModelRow): KeepAlive | null {
  if (row.state !== "loaded") return null;
  if (row.pinned) return { key: "pinned" };
  if (typeof row.expires_in !== "number") return null;
  return { key: "expires", minutes: Math.max(1, Math.ceil(row.expires_in / 60)) };
}

/** How long to wait before reading the list again. */
export function pollDelay(list: LocalModelList | null, inFlight: boolean): number {
  if (inFlight) return FAST_POLL;
  if (!list) return SLOW_POLL;
  return list.server === "starting" || list.models.some((model) => model.state === "loading") ? FAST_POLL : SLOW_POLL;
}

export type Summary =
  | { key: "summary"; loaded: number; installed: number }
  | { key: "serverStopped" | "starting" | "unreachable" | "notInstalled" };

/** The Home row's caption for a list. */
export function summary(list: LocalModelList): Summary {
  switch (list.server) {
    case "running":
      return { key: "summary", loaded: list.models.filter((model) => model.state === "loaded").length, installed: list.models.length };
    case "starting": return { key: "starting" };
    case "stopped": return { key: "serverStopped" };
    case "not_installed": return { key: "notInstalled" };
    default: return { key: "unreachable" };
  }
}

/** A model's size on disk. Models run to gigabytes, which `sizeLabel` would
 * spell as thousands of megabytes. */
export function modelSizeLabel(bytes: number): string {
  const gib = 1024 ** 3;
  return bytes >= gib ? `${(bytes / gib).toFixed(1)} GB` : sizeLabel(bytes);
}
