/**
 * The agent's ticks on the desktop (`markup_done`,
 * `docs/markup_tick_approve_plan.md` §3): a ✓ badge at the top-right corner
 * of each sent mark the agent says it handled, over the markup layer as the
 * question pins are (`PdfQuestionPins`, the same pin in the success colour).
 * A click approves the mark — it leaves the layer, undoably — and nothing
 * else ever removes it: a tick only offers the click.
 */
import { useT } from "../../../lib/i18n";
import { markBox, type Layer, type Mark, type TickedMark } from "../../../../mobile-web/src/markup/layer";
import { UntestedTag } from "../../common/UntestedTag";

/** One badge: the ticked mark, its place on its page's sent side and its box. */
export type TickBadge = { index: number; mark: Mark; box: [number, number, number, number] };

/** The ticked marks' badges, by 1-based page. */
export function tickBadgesByPage(layer: Layer, marks: readonly TickedMark[]): Map<number, TickBadge[]> {
  const out = new Map<number, TickBadge[]>();
  for (const { page, index } of marks) {
    const mark = layer.sent?.pages[page]?.marks[index];
    if (!mark) continue;
    const list = out.get(page) ?? [];
    list.push({ index, mark, box: markBox(mark) });
    out.set(page, list);
  }
  return out;
}

/** A badge's React key: its mark's identity, not its index — an approved
 *  mark's button goes with it, so focus and a held Enter never land on the
 *  next mark that slides into its index. */
const markIds = new WeakMap<Mark, number>();
let nextMarkId = 0;
function badgeKey(mark: Mark): number {
  let id = markIds.get(mark);
  if (id === undefined) {
    id = ++nextMarkId;
    markIds.set(mark, id);
  }
  return id;
}

/** A badge's size (CSS px) — the question pin's. */
const BADGE = 22;

/** One page's ✓ badges. `size` is the page in its marks' units (CSS px at
 *  scale 1), so a badge stays on the page. */
export function PdfTickBadges({
  badges,
  size,
  scale,
  disabled,
  onApprove,
}: {
  badges: readonly TickBadge[];
  size: [number, number];
  scale: number;
  disabled: boolean;
  onApprove: (index: number, mark: Mark) => void;
}) {
  const t = useT();
  const maxLeft = Math.max(0, size[0] * scale - BADGE);
  const maxTop = Math.max(0, size[1] * scale - BADGE);
  return (
    <>
      {badges.map(({ index, mark, box }) => {
        const [x, y, w] = box;
        const left = Math.min(maxLeft, Math.max(0, (x + w) * scale - BADGE / 2));
        const top = Math.min(maxTop, Math.max(0, y * scale - BADGE / 2));
        return (
          <button
            key={`${badgeKey(mark)}:${index}`}
            type="button"
            className="file-viewer-pdf-question-pin is-tick"
            style={{ left, top }}
            disabled={disabled}
            title={t("pdfMarkup.ticks.approveTitle")}
            aria-label={t("pdfMarkup.ticks.approveTitle")}
            // A double click's second click is not a second approval: it
            // would take whichever badge sits under the pointer next.
            onClick={(event) => {
              if (event.detail <= 1) onApprove(index, mark);
            }}
          >
            ✓
          </button>
        );
      })}
    </>
  );
}

/** The strip's **n done · Approve all**, when the agent ticked any shown mark. */
export function PdfTicksStatus({ count, disabled, onApproveAll }: { count: number; disabled: boolean; onApproveAll: () => void }) {
  const t = useT();
  if (count === 0) return null;
  return (
    <span className="file-viewer-pdf-markup-round">
      <span>{t("pdfMarkup.ticks.done", { count })}</span>
      <span aria-hidden="true">·</span>
      <button
        type="button"
        className="file-viewer-zoom-btn file-viewer-zoom-text"
        onClick={onApproveAll}
        disabled={disabled}
        title={t("pdfMarkup.ticks.approveAllTitle")}
      >
        {t("pdfMarkup.ticks.approveAll")}
      </button>
      <UntestedTag id="desktop.markup.ticks" />
    </span>
  );
}
