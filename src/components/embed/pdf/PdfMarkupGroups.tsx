/**
 * A Submit of its own beside each remark being written (`markGroups`: unsent
 * marks that sit together): it sends that group alone, the page's other marks
 * stay unsent. Placed by `submitSpot` just outside the group and clear of
 * every unsent mark, so it never hides what was written; regrouped after
 * each stroke, hidden while one is drawn. A group that just changed ignores
 * clicks for a moment: a pen still writing there must not send it.
 */
import { useEffect, useMemo, useState } from "react";
import { useT } from "../../../lib/i18n";
import { markBox, submitSpot, type Mark, type MarkGroup, type PageLayer } from "../../../../mobile-web/src/markup/layer";

/** The button's size (CSS px) — it is placed whole, never overlapping a mark. */
const BUTTON: [number, number] = [58, 20];
/** How long after its last change a group takes no click. */
export const GROUP_SETTLE_MS = 900;

/** When each mark first showed up here, by identity. */
const seen = new WeakMap<Mark, number>();
function arrivedAt(marks: readonly Mark[], now: number): number {
  let last = 0;
  for (const mark of marks) {
    let at = seen.get(mark);
    if (at === undefined) {
      at = now;
      seen.set(mark, at);
    }
    last = Math.max(last, at);
  }
  return last;
}

/** One page's group Submits. `size` is the page in its marks' units. */
export function PdfGroupSubmits({ groups, page, size, scale, disabled, onSubmit }: {
  groups: readonly MarkGroup[];
  /** The page's unsent marks, which no button may cover. */
  page: PageLayer | undefined;
  size: [number, number];
  scale: number;
  disabled: boolean;
  onSubmit: (marks: readonly Mark[]) => void;
}) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  const boxes = useMemo(() => (page?.marks ?? []).map(markBox), [page]);
  const arrivals = groups.map((group) => arrivedAt(group.marks, Date.now()));
  const settlesAt = Math.max(0, ...arrivals) + GROUP_SETTLE_MS;
  // Draw the settled look once the newest group has settled.
  useEffect(() => {
    const wait = settlesAt - Date.now();
    if (wait <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(timer);
  }, [settlesAt]);
  const css: [number, number] = [size[0] * scale, size[1] * scale];
  return (
    <>
      {groups.map((group, i) => {
        const [left, top] = submitSpot(group.box, scale, css, BUTTON, boxes);
        const settling = Math.max(now, Date.now()) - arrivals[i] < GROUP_SETTLE_MS;
        return (
          <button
            key={`${group.marks.length}:${i}`}
            type="button"
            className={`file-viewer-pdf-question-pin is-submit${settling ? " is-settling" : ""}`}
            style={{ left, top, width: BUTTON[0], height: BUTTON[1] }}
            disabled={disabled}
            title={t("pdfMarkup.groupSubmitTitle", { count: group.marks.length })}
            aria-label={t("pdfMarkup.groupSubmitTitle", { count: group.marks.length })}
            onClick={(event) => {
              if (event.detail > 1 || Date.now() - arrivals[i] < GROUP_SETTLE_MS) return;
              onSubmit(group.marks);
            }}
          >
            {t("mobile.markup.submit")}
          </button>
        );
      })}
    </>
  );
}
