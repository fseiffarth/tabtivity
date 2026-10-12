/**
 * The agent's ticks on the desktop (`markup_done`,
 * `docs/markup_tick_approve_plan.md` §3): a ✓ badge just outside the
 * top-right corner of each group of sent marks the agent says it handled —
 * the ticked marks that sit together (`tickGroups`: one remark, however many
 * strokes it took) — never over their words (`tickBadgeSpot`), over the
 * markup layer as the question pins are (`PdfQuestionPins`, the same pin in
 * the success colour). A click approves the group — its marks leave the
 * layer, undoably — and nothing else ever removes them: a tick only offers
 * the click.
 *
 * Beside a badge, when the page's words under the group changed since Submit
 * (the round log keeps them, `SentRound.words`), a caption says what they
 * were and what they are now (`tickCaption`).
 */
import { useT } from "../../../lib/i18n";
import { wordsIn } from "../../../../mobile-web/src/markup/anchors";
import type { TextRun } from "../../../../mobile-web/src/markup/findText";
import { markBox, tickBadgeSpot, type Layer, type Mark, type TickGroup } from "../../../../mobile-web/src/markup/layer";
import { UntestedTag } from "../../common/UntestedTag";

/** A ✓ group's words at Submit and on the page as loaded now. */
export type TickCaption = { before: string; after: string };

/** One badge: a group's ticked marks (the sent side's objects, in page order),
 *  their box together, and the before/after caption when there is one. */
export type TickBadge = { marks: readonly Mark[]; box: [number, number, number, number]; caption?: TickCaption };

/** The ticked groups' badges, by 1-based page. */
export function tickBadgesByPage(
  layer: Layer,
  groups: readonly TickGroup[],
  captions?: ReadonlyMap<TickGroup, TickCaption>,
): Map<number, TickBadge[]> {
  const out = new Map<number, TickBadge[]>();
  for (const group of groups) {
    const { page, marks, box } = group;
    const shown = marks.map(({ index }) => layer.sent?.pages[page]?.marks[index]).filter((mark): mark is Mark => !!mark);
    if (!shown.length) continue;
    const list = out.get(page) ?? [];
    const caption = captions?.get(group);
    list.push(caption ? { marks: shown, box, caption } : { marks: shown, box });
    out.set(page, list);
  }
  return out;
}

/** The words of a group's marks, one after the other, a repeat dropped (two
 *  strokes on the same word). */
function joinWords(words: readonly string[]): string {
  return words.filter((word, i) => word && word !== words[i - 1]).join(" ");
}

/** A ✓ group's before/after: for each of its marks whose words the round log
 *  kept, those words, against the words under the same mark on `runs` — the
 *  page as loaded now. Mark by mark on both sides, so marks spread over a
 *  line compare alike. `null` until the page's text is read, when nothing was
 *  logged, or when the words are the same. */
export function tickCaption(layer: Layer, group: TickGroup, runs: readonly TextRun[] | null | undefined): TickCaption | null {
  const sent = layer.sent;
  const page = sent?.pages[group.page];
  if (!runs || !page || !sent?.log) return null;
  const before: string[] = [];
  const after: string[] = [];
  for (const { index, round } of group.marks) {
    const mark = page.marks[index];
    const entry = sent.log.find((logged) => logged.id === round);
    const at = mark && entry ? (entry.pages[group.page] ?? []).indexOf(mark) : -1;
    const said = at >= 0 ? entry?.words?.[group.page]?.[at] : null;
    if (typeof said !== "string" || !said) continue;
    before.push(said);
    after.push(wordsIn(runs, markBox(mark)));
  }
  const was = joinWords(before);
  const now = joinWords(after);
  return was && was !== now ? { before: was, after: now } : null;
}

/** A badge's React key: its first mark's identity, not an index — an
 *  approved group's button goes with it, so focus and a held Enter never land
 *  on the next group that slides into its place. */
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
/** The widest a before/after caption grows, CSS px (`.file-viewer-pdf-tick-diff`). */
const CAPTION_W = 260;

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
  onApprove: (marks: readonly Mark[]) => void;
}) {
  const t = useT();
  const page: [number, number] = [size[0] * scale, size[1] * scale];
  return (
    <>
      {badges.map(({ marks, box, caption }) => {
        const [left, top] = tickBadgeSpot(box, scale, page, BADGE);
        const key = `${badgeKey(marks[0])}:${marks.length}`;
        const said = caption ? t("mobile.markup.tickDiff", { before: caption.before, after: caption.after }) : "";
        return [
          <button
            key={key}
            type="button"
            className="file-viewer-pdf-question-pin is-tick"
            style={{ left, top }}
            disabled={disabled}
            title={t("pdfMarkup.ticks.approveTitle")}
            aria-label={t("pdfMarkup.ticks.approveTitle")}
            // A double click's second click is not a second approval: it
            // would take whichever badge sits under the pointer next.
            onClick={(event) => {
              if (event.detail <= 1) onApprove(marks);
            }}
          >
            ✓
          </button>,
          // What the words were and are now, beside the badge — on its left
          // where the badge sits at the page's right edge.
          caption && (
            <span
              key={`${key}:diff`}
              className={`file-viewer-pdf-tick-diff${left + BADGE + CAPTION_W > page[0] ? " is-left" : ""}`}
              style={left + BADGE + CAPTION_W > page[0] ? { right: page[0] - left + 4, top } : { left: left + BADGE + 4, top }}
              title={said}
            >
              {said}
              <UntestedTag id="desktop.markup.tools2" />
            </span>
          ),
        ];
      })}
    </>
  );
}

/** The strip's **n done · Approve all**, when the agent ticked any shown mark;
 *  `count` is the groups, as many as the badges. */
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
