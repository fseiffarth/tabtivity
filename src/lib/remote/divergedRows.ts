import type { TranslationKey } from "../i18n";
import { fmtModified } from "../viewers/fileUtils";
import type { SyncEntryStatus } from "../../stores/remote/sync";

/**
 * What a diverged file's row says and offers, from its status alone: the
 * desktop's orange view and the phone's Diverged list read the same rules. No
 * store and no Tauri here, so the phone bundle can import it.
 */

export interface MtimeCue {
  text: string;
  tone: "remote" | "local" | "neutral";
  title: string;
}

/** Which side moved, as a small badge. The verdict comes from the backend's
 *  `host_diverged`/`local_diverged` — each side compared to its own recorded
 *  base, so host/local clock skew can never pick the wrong authority. The
 *  mtimes are kept purely as DISPLAY metadata (the tooltip's "modified when"
 *  lines); the badge's tone/text no longer trusts them. Tone always names the
 *  side the text is about: remote = --warning (orange), local = --success
 *  (green), matching the take-remote/keep-local icon buttons below.
 *
 *  A row only reaches this list once the manifest has recorded a synced base
 *  for it (`amberPaths` reads `state === "amber"`, which `compute_state`
 *  never sets for an untracked path) — so a null mtime here is never "this
 *  file was never synced," it's "this file WAS synced and one side's copy
 *  has since been deleted." The tooltip says so explicitly, since the badge
 *  text alone ("Remote only") reads ambiguously otherwise. Exported for tests. */
export function mtimeDivergenceCue(
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  hostMtime: number | null | undefined,
  localMtime: number | null | undefined,
  hostDiverged: boolean,
  localDiverged: boolean,
  hostChecked: boolean,
): MtimeCue {
  const hostLabel =
    hostMtime != null
      ? t("projectFilesView.remoteModified", { when: fmtModified(hostMtime) })
      : t("projectFilesView.remoteDeletedSinceSync");
  const localLabel =
    localMtime != null
      ? t("projectFilesView.localModified", { when: fmtModified(localMtime) })
      : t("projectFilesView.localDeletedSinceSync");
  const title = `${hostLabel}\n${localLabel}`;
  if (hostMtime == null && localMtime == null) {
    // "Gone on both sides" is a host fact — only claim it when this pass
    // actually asked the host. A cold pool (or an errored stat) reports every
    // host mtime as null, and asserting a deletion out of that would put the
    // Forget action under a false sentence.
    if (!hostChecked) {
      const uncheckedLabel = t("projectFilesView.localGoneHostUnchecked");
      return { text: uncheckedLabel, tone: "neutral", title: `${uncheckedLabel}\n${localLabel}` };
    }
    return { text: t("projectFilesView.goneBothSides"), tone: "neutral", title };
  }
  if (hostMtime == null) return { text: t("projectFilesView.localOnly"), tone: "local", title };
  if (localMtime == null) return { text: t("projectFilesView.remoteOnly"), tone: "remote", title };
  // Both present: use the backend's per-side base comparison, never a
  // cross-machine mtime comparison.
  if (hostDiverged && localDiverged)
    return { text: t("projectFilesView.bothChanged"), tone: "neutral", title };
  if (hostDiverged) return { text: t("projectFilesView.remoteNewer"), tone: "remote", title };
  if (localDiverged) return { text: t("projectFilesView.localNewer"), tone: "local", title };
  // Neither flagged (a self-heal race): nothing actually diverged.
  return { text: t("projectFilesView.sameTime"), tone: "neutral", title };
}

/**
 * Splits diverged files by which side holds the newer copy, for the orange
 * view's "take the newer one for all". The backend's per-side direction wins
 * (only the host moved from its recorded base → host; only the mirror → local),
 * so clock skew cannot flip it; a file both sides changed falls back to the
 * mtime comparison. A file with a side missing (a deletion), one with equal
 * mtimes, and one not in the map are left out — nothing says which copy is newer.
 */
export function splitByNewerSide(
  byPath: Record<string, SyncEntryStatus> | undefined,
  relPaths: string[],
): { host: string[]; local: string[] } {
  const host: string[] = [];
  const local: string[] = [];
  for (const rel of relPaths) {
    const e = byPath?.[rel];
    if (!e || e.hostMtime == null || e.localMtime == null) continue;
    if (e.hostDiverged !== e.localDiverged) {
      (e.hostDiverged ? host : local).push(rel);
    } else if (e.hostMtime !== e.localMtime) {
      (e.hostMtime > e.localMtime ? host : local).push(rel);
    }
  }
  return { host, local };
}

/**
 * Diverged files minus the ones BOTH sides changed since their recorded base
 * (the backend's per-side flags, both copies present) — the orange view's
 * "exclude changed on both" tick, so a bulk take-a-side never silently drops
 * one side's edits of a true conflict; those are resolved per row.
 */
export function withoutChangedOnBoth(
  byPath: Record<string, SyncEntryStatus> | undefined,
  relPaths: string[],
): string[] {
  return relPaths.filter((rel) => {
    const e = byPath?.[rel];
    return !(e && e.hostMtime != null && e.localMtime != null && e.hostDiverged && e.localDiverged);
  });
}

/**
 * Which side a 🗑 in the orange view would delete: the surviving copy of a file
 * deleted on exactly one side, or null when no deletion applies. Deleting the
 * mirror copy is only offered when the host was actually consulted and
 * positively reported the file gone (`hostChecked`) — a cold pool reports every
 * host mtime as null without asking. The backend re-verifies either premise
 * against live state before deleting anything.
 */
export function deleteSideOf(e: SyncEntryStatus | undefined): "host" | "local" | null {
  if (!e) return null;
  const noHostFile = e.hostMtime == null;
  const noLocalFile = e.localMtime == null;
  if (noLocalFile && !noHostFile) return "host";
  if (noHostFile && !noLocalFile && e.hostChecked) return "local";
  return null;
}

/** Splits diverged files by the side a 🗑 would delete (`deleteSideOf`), for the
 *  orange view's "delete for all"; files no deletion applies to are left out. */
export function splitByDeleteSide(
  byPath: Record<string, SyncEntryStatus> | undefined,
  relPaths: string[],
): { host: string[]; local: string[] } {
  const host: string[] = [];
  const local: string[] = [];
  for (const rel of relPaths) {
    const side = deleteSideOf(byPath?.[rel]);
    if (side) (side === "host" ? host : local).push(rel);
  }
  return { host, local };
}
