import type { TranslationKey } from "../../lib/i18n";
import {
  absoluteWhen,
  relativeWhen,
  type SideTime,
} from "../../lib/viewers/syncSideTimes";

type T = (key: TranslationKey, params?: Record<string, string | number>) => string;

/** Which resolver side a stamp belongs to; selects its locality colour. */
export type StampSide = "left" | "right";

/** "<abs> (<rel>)" for a tooltip. */
function whenFull(secs: number, nowMs: number, lang: string | undefined): string {
  return `${absoluteWhen(secs, lang)} (${relativeWhen(secs, nowMs, lang)})`;
}

/** The column-header cue: this side's file-modified time plus, on the newer
 *  side, a "newer" badge. Renders nothing for an unknown time (never a zero). */
export function SideStamp({
  t,
  lang,
  nowMs,
  side,
  mtime,
  newer,
  basis,
}: {
  t: T;
  lang: string | undefined;
  nowMs: number;
  side: StampSide;
  mtime: number | null;
  newer: boolean;
  basis: "sync" | "time" | null;
}) {
  if (mtime == null || mtime <= 0) return null;
  return (
    <span className="file-viewer-compare-stamp" title={t("syncTimes.modifiedTitle", { when: whenFull(mtime, nowMs, lang) })}>
      {t("syncTimes.modified", { when: relativeWhen(mtime, nowMs, lang) })}
      {newer && (
        <span
          className={`file-viewer-compare-newer ${side}`}
          title={basis === "sync" ? t("syncTimes.newerBySyncTitle") : t("syncTimes.newerByTimeTitle")}
        >
          {t("syncTimes.newer")}
        </span>
      )}
    </span>
  );
}

/** One side of a block as a sentence: committed (with its commit) or not
 *  committed + the file's save time. */
export function blockSideText(
  t: T,
  lang: string | undefined,
  nowMs: number,
  sideName: string,
  time: SideTime,
): string {
  const when = whenFull(time.secs, nowMs, lang);
  if (!time.committed) return t("syncTimes.blockUncommitted", { side: sideName, when });
  const commit = time.commit ? `${time.commit.short} ${time.commit.summary}`.trim() : "";
  return t("syncTimes.blockCommitted", { side: sideName, when, commit });
}

/** The compact time beside a Take button ("2h ago", "newer" on the newer side). */
export function TakeWhen({
  t,
  lang,
  nowMs,
  time,
  newer,
}: {
  t: T;
  lang: string | undefined;
  nowMs: number;
  time: SideTime;
  newer: boolean;
}) {
  return (
    <span className="file-viewer-compare-take-when">
      {relativeWhen(time.secs, nowMs, lang, "narrow")}
      {newer && <b>{t("syncTimes.newer")}</b>}
    </span>
  );
}
