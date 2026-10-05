import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import type { PromptChartCard } from "../../lib/agents/prompt/chart";
import { parseTags } from "../../lib/agents/prompt/tags";
import { useT } from "../../lib/i18n";
import { MarkdownPromptField } from "../common/MarkdownPromptField";
import type { ChartDrag } from "./usePromptChartDrag";
import { NAMES } from "../../lib/brand";

interface Point { x: number; y: number }
interface Layout { free: boolean; positions: Record<string, Point> }
export interface DraftBoardHandle {
  place: (id: string, x: number, y: number) => boolean;
  /** Whether cards can be moved at all: in row layout `place` refuses. */
  free: boolean;
  /** Open the board's own composer — at the next free spot on the canvas, or
   *  at the row's end — the one composer the chart's ＋ opens too. */
  compose: () => void;
}

/** The composer's size on the free canvas, so the canvas grows to hold it. */
const COMPOSER_WIDTH = 460;
const COMPOSER_HEIGHT = 220;

function readLayout(key: string): Layout {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null") as Layout | null;
    const positions = Object.fromEntries(Object.entries(saved?.positions ?? {}).filter(([, point]) =>
      point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.y >= 0));
    return { free: saved?.free === true, positions };
  } catch { return { free: false, positions: {} }; }
}

/** A view-only layout, scoped to the project. Moving a draft never assigns it
 * a time. The chart still owns the ports and every prompt/schedule write.
 * Double-clicking an empty spot opens a composer there; the draft it writes
 * takes that spot on the free canvas. The backend refuses an empty prompt, so
 * nothing is written until the composer holds text. */
export const PromptDraftBoard = forwardRef<DraftBoardHandle, {
  scope: string;
  cards: PromptChartCard[];
  drag: ChartDrag | null;
  renderCard: (card: PromptChartCard) => ReactNode;
  onLayout: () => void;
  /** Write a new draft; resolves to its id, rejects when the write failed. */
  onCreate: (message: string, tags: string[]) => Promise<string>;
}>(function PromptDraftBoard({ scope, cards, drag, renderCard, onLayout, onCreate }, ref) {
  const t = useT();
  const key = `${NAMES.storagePrefix}promptChart.drafts.${scope}`;
  const [layout, setLayout] = useState(() => readLayout(key));
  const canvas = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  const [composer, setComposer] = useState<Point | null>(null);
  const [message, setMessage] = useState("");
  const [tags, setTags] = useState("");
  const columns = Math.max(1, Math.floor(width / 192));
  const pointOf = (id: string, index: number): Point => layout.positions[id] ?? { x: index % columns * 192 + 8, y: Math.floor(index / columns) * 152 + 8 };
  const clientPoint = (x: number, y: number): Point => {
    const rect = canvas.current?.getBoundingClientRect();
    return { x: Math.max(0, x - (rect?.left ?? 0)), y: Math.max(0, y - (rect?.top ?? 0)) };
  };
  /** The first grid spot the composer covers no card at, reading row by row;
   *  below the lowest card when the canvas is full. */
  const freeSpot = (): Point => {
    const boxes = cards.map((card, index) => ({ ...pointOf(card.id, index), ...(sizes[card.id] ?? { width: 168, height: 120 }) }));
    const clear = (x: number, y: number) => boxes.every((box) =>
      x + COMPOSER_WIDTH <= box.x || box.x + box.width <= x || y + COMPOSER_HEIGHT <= box.y || box.y + box.height <= y);
    for (let row = 0; row < 64; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const x = column * 192 + 8;
        const y = row * 152 + 8;
        if ((column === 0 || x + COMPOSER_WIDTH <= width) && clear(x, y)) return { x, y };
      }
    }
    return { x: 8, y: Math.max(8, ...boxes.map((box) => box.y + box.height + 8)) };
  };
  useImperativeHandle(ref, () => ({
    place: (id, x, y) => {
      if (!layout.free) return false;
      const point = clientPoint(x, y);
      setLayout((value) => ({ ...value, positions: { ...value.positions, [id]: point } }));
      return true;
    },
    free: layout.free,
    compose: () => setComposer(layout.free ? freeSpot() : { x: 0, y: 0 }),
  }));
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(layout)); } catch { /* retain it for this session */ }
    onLayout();
  }, [key, layout, onLayout]);
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setWidth(node.clientWidth || 720));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const node = canvas.current;
    if (!node || !layout.free) return;
    const observer = new ResizeObserver(() => {
      setSizes(Object.fromEntries([...node.children].map((child) => {
        const slot = child as HTMLElement;
        const card = slot.firstElementChild as HTMLElement | null;
        return [slot.dataset.draftId, { width: card?.offsetWidth || 168, height: card?.offsetHeight || 120 }];
      })));
    });
    for (const slot of node.children) if (slot.firstElementChild) observer.observe(slot.firstElementChild);
    return () => observer.disconnect();
  }, [cards, layout.free]);

  const openComposer = (event: ReactMouseEvent<HTMLDivElement>) => {
    // Only an empty spot: a double click on a card opens that card's editor.
    if ((event.target as Element).closest(".agent-prompt-card, .agent-prompt-draft-composer")) return;
    setComposer(clientPoint(event.clientX, event.clientY));
  };
  const closeComposer = () => {
    setComposer(null);
    setMessage("");
    setTags("");
  };
  const submit = () => {
    const at = composer;
    if (!at || !message.trim()) return;
    onCreate(message.trim(), parseTags(tags)).then((id) => {
      if (layout.free) setLayout((value) => ({ ...value, positions: { ...value.positions, [id]: at } }));
      closeComposer();
    }).catch(() => { /* the chart reports it; the composer keeps the text */ });
  };

  const points = cards.map((card, index) => drag?.kind === "card" && drag.zone.kind === "strip" && drag.card.id === card.id
    ? clientPoint(drag.x - drag.grabDx, drag.y - drag.grabDy)
    : pointOf(card.id, index));
  const composerNode = composer && (
    <div
      className={`agent-prompt-draft-composer${layout.free ? " agent-prompt-draft-position" : ""}`}
      data-testid="prompt-draft-composer"
      style={layout.free ? { left: composer.x, top: composer.y } : undefined}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <MarkdownPromptField
        rows={4}
        autoFocus
        value={message}
        ariaLabel={t("agentPrompts.placeholder")}
        placeholder={t("agentPrompts.placeholder")}
        onChange={setMessage}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); closeComposer(); }
          else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submit(); }
        }}
      />
      <input value={tags} aria-label={t("agentPrompts.tags")} placeholder={t("agentPrompts.tagsPlaceholder")} onChange={(event) => setTags(event.target.value)} />
      <div className="agent-prompt-card-actions">
        <button className="settings-btn sm primary" type="button" disabled={!message.trim()} onClick={submit}>{t("agentPrompts.add")}</button>
        <button className="settings-btn sm" type="button" onClick={closeComposer}>{t("common.cancel")}</button>
      </div>
    </div>
  );
  return <>
    <div className="agent-prompt-draft-layout-bar">
      <button type="button" className={`agent-composer-chip${layout.free ? " active" : ""}`} aria-pressed={layout.free}
        onClick={() => setLayout((value) => ({ free: !value.free, positions: Object.fromEntries(cards.map((card, index) => [card.id, pointOf(card.id, index)])) }))}>
        {t("promptChart.freeLayout")}
      </button>
      {/* "Move cards freely" is true only in free layout; the row does not move them. */}
      <small>{layout.free ? `${t("promptChart.draftFreeHint")} ` : ""}{t("promptChart.draftLayoutHint")} {t("promptChart.draftCreateHint")}</small>
    </div>
    <small className="agent-prompt-completion-hint">{t("promptChart.completionHint")}</small>
    <div ref={viewport} className={layout.free ? "agent-prompt-draft-viewport" : undefined}>
      <div ref={canvas} data-testid="prompt-draft-board" className={layout.free ? "agent-prompt-draft-canvas" : "agent-prompt-drafts-row"}
        onDoubleClick={openComposer}
        style={layout.free ? {
          width: Math.max(width, ...points.map((point, index) => point.x + (sizes[cards[index].id]?.width ?? 168) + 32), composer ? composer.x + COMPOSER_WIDTH + 32 : 0),
          height: Math.max(320, ...points.map((point, index) => point.y + (sizes[cards[index].id]?.height ?? 120) + 64), composer ? composer.y + COMPOSER_HEIGHT + 64 : 0),
        } : undefined}>
        {cards.map((card, index) => layout.free
          ? <div key={card.key} data-draft-id={card.id} className="agent-prompt-draft-position" style={{ left: points[index].x, top: points[index].y }}>{renderCard(card)}</div>
          : renderCard(card))}
        {composerNode}
        {cards.length === 0 && !composer && <div className="file-tree-empty">{t("promptChart.noDrafts")}</div>}
      </div>
    </div>
  </>;
});
