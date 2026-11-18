import { invoke } from "@tauri-apps/api/core";

/**
 * Per-turn checkpoints (`services::checkpoints`, `commands::checkpoints`): the
 * backend snapshots an agent tab's folder as each turn begins and ends, in a
 * store of its own, and can put files back. The window names a tab by its
 * launch uid (`TabEntry.sessionId`) and a checkpoint by its opaque id — never a
 * folder: the backend bound the tab to its folder at launch.
 */

export type CheckpointKind = "pre" | "post" | "manual" | "pre-restore" | "restore";

/** A file a snapshot left out (`reason`: size, budget, special, unreadable),
 *  or a folder git can't enter (`blocked`: its `.gitignore` is a pipe; the
 *  path ends in `/`). */
export interface CheckpointSkipped {
  path: string;
  bytes: number;
  reason: string;
}

/** One log row (`services::checkpoints::store::Row`, camelCase). */
export interface CheckpointRow {
  id: string;
  kind: CheckpointKind;
  commit: string;
  tree: string;
  tabUid: string;
  tabLabel: string;
  cli: string;
  sessionId?: string;
  /** Milliseconds since the epoch. */
  at: number;
  promptAt?: number;
  raced: boolean;
  partial: boolean;
  skipped: CheckpointSkipped[];
  nested: string[];
  restoredTo?: string;
  paths?: number;
}

export interface CheckpointListing {
  /** Taken at all: the backend switch and the window's flag are both on. */
  enabled: boolean;
  bound: boolean;
  /** Oldest first. */
  rows: CheckpointRow[];
  /** Why the folder's last automatic snapshot failed, until one succeeds. */
  failure: string | null;
}

export interface CheckpointChange {
  path: string;
  /** A added since, D deleted since, M modified, T type changed. */
  status: "A" | "D" | "M" | "T";
  added: number | null;
  removed: number | null;
  binary: boolean;
  diff: string | null;
  cut: boolean;
}

export interface CheckpointSince {
  files: CheckpointChange[];
  /** Files another tab's turn changed since the checkpoint. */
  others: string[];
  leftOut: number;
  nested: string[];
  othersWorking: boolean;
  /** Another agent tab in this folder doesn't report its turns: it may be working. */
  othersUnknown: boolean;
  /** This tab's agent doesn't report its turns (Codex before its hooks are
   *  trusted, a CLI without hooks): a restore needs `confirmUnknown`. */
  turnUnknown: boolean;
  raced: boolean;
  partial: boolean;
}

export interface CheckpointRestored {
  restored: number;
  removed: number;
  failed: { path: string; error: string }[];
  undoId: string;
}

export interface CheckpointStoreInfo {
  key: string;
  folder: string;
  bytes: number;
  count: number;
  lastAt: number;
}

export interface CheckpointSettings {
  enabled: boolean;
  stores: CheckpointStoreInfo[];
  /** The local git can run checkpoints (2.40 or later). */
  gitOk: boolean;
  /** The local git's `major.minor`; null without git. */
  gitVersion: string | null;
}

/** The event a finished snapshot is announced with. */
export const CHECKPOINT_EVENT = "checkpoint-added";

/**
 * Each tab's checkpoint key, by launch uid: the backend mints it at every
 * launch and hands it only to the window, in `pty_spawn`'s answer
 * (`checkpointKey`). The uid is in the agent's own environment, so the
 * backend never takes it as the caller's word; this key is never persisted
 * and never reaches the agent. A relaunch brings a new one.
 */
const keys = new Map<string, string>();

/** Remember (or, with none, forget) the key tab `uid`'s launch answered with. */
export function noteCheckpointKey(uid: string, key: string | null | undefined): void {
  if (key) keys.set(uid, key);
  else keys.delete(uid);
}

const NO_KEY = "this tab has no checkpoints";
const UNBOUND: CheckpointListing = { enabled: false, bound: false, rows: [], failure: null };

/** `call` with tab `uid`'s key, or a refusal when this window has none for it. */
function withKey<T>(uid: string, call: (tabKey: string) => Promise<T>): Promise<T> {
  const tabKey = keys.get(uid);
  return tabKey ? call(tabKey) : Promise.reject(new Error(NO_KEY));
}

export const checkpointList = (uid: string) =>
  keys.has(uid) ? withKey(uid, (tabKey) => invoke<CheckpointListing>("checkpoint_list", { tabKey })) : Promise.resolve(UNBOUND);

export const checkpointDiff = (uid: string, id: string, only?: string[]) =>
  withKey(uid, (tabKey) => invoke<CheckpointSince>("checkpoint_diff", { tabKey, id, only: only ?? null }));

export const checkpointRestore = (uid: string, id: string, only: string[] | null, confirmOthers: boolean, confirmUnknown: boolean) =>
  withKey(uid, (tabKey) => invoke<CheckpointRestored>("checkpoint_restore", { tabKey, id, only, confirmOthers, confirmUnknown }));

export const checkpointNow = (uid: string, label?: string) =>
  withKey(uid, (tabKey) => invoke<CheckpointRow>("checkpoint_now", { tabKey, label: label ?? null }));

export const checkpointSettingsGet = () => invoke<CheckpointSettings>("checkpoint_settings_get");

export const checkpointSettingsSet = (enabled: boolean) => invoke<CheckpointSettings>("checkpoint_settings_set", { enabled });

export const checkpointClear = (key?: string) => invoke<CheckpointSettings>("checkpoint_clear", { key: key ?? null });

/** Rows a restore can go back to: those that hold a snapshot. */
export function snapshotRows(rows: readonly CheckpointRow[]): CheckpointRow[] {
  return rows.filter((row) => row.kind !== "restore" && row.commit !== "");
}

/** How far a bubble's time may be from a `pre` row's prompt time and still be
 *  that prompt's checkpoint (the hook's record and the transcript's stamp are
 *  written by different processes). */
export const PROMPT_MATCH_MS = 5000;

/**
 * The `pre` checkpoint of the prompt sent at `stamp` (the bubble's time, an
 * ISO string): the tab's `pre` row whose prompt time is the nearest within
 * [`PROMPT_MATCH_MS`]. No match is `undefined` — never a guess.
 */
export function preForPrompt(rows: readonly CheckpointRow[], uid: string, stamp: string | undefined): CheckpointRow | undefined {
  if (!stamp) return undefined;
  const at = new Date(stamp).getTime();
  if (Number.isNaN(at)) return undefined;
  let best: CheckpointRow | undefined;
  let bestGap = PROMPT_MATCH_MS + 1;
  for (const row of rows) {
    if (row.kind !== "pre" || row.tabUid !== uid || row.promptAt == null) continue;
    const gap = Math.abs(row.promptAt - at);
    if (gap < bestGap) {
      best = row;
      bestGap = gap;
    }
  }
  return best;
}

/** The `post` row that ended the turn before `pre`: the previous turn's end,
 *  what a restore to a `raced` `pre` offers instead. */
export function previousPost(rows: readonly CheckpointRow[], pre: CheckpointRow): CheckpointRow | undefined {
  let found: CheckpointRow | undefined;
  for (const row of rows) {
    if (row.at >= pre.at) break;
    if (row.kind === "post" && row.tabUid === pre.tabUid) found = row;
  }
  return found;
}

/** `bytes` as a short size. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}
