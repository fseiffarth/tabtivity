import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import type { PromptChartCard } from "../../lib/agents/prompt/chart";
import { parseTags } from "../../lib/agents/prompt/tags";
import { useT } from "../../lib/i18n";
import { MarkdownPromptField } from "../common/MarkdownPromptField";
import type { ChartDrag } from "./usePromptChartDrag";
import { NAMES } from "../../lib/brand";
import type { PromptSequence } from "../../lib/agents/prompt/sequences";
import { PromptSequenceGroup, PromptSequenceHeader, PromptSequenceOutline, PromptSequenceRow } from "./PromptSequenceGroup";

interface Point { x: number; y: number }
interface Layout { free: boolean; positions: Record<string, Point> }
export interface DraftBoardHandle {
  place: (id: string, x: number, y: number) => boolean;
  /** Whether cards can be moved at all: in row layout `place` refuses. */
  free: boolean;
  /** The List | Free switch, which the Drafts column's header draws. Free
   *  starts from where the list shows each card now. */
  setFree: (free: boolean) => void;
}

/** The room a sequence's heading takes under its outline on the free canvas. */
const SEQUENCE_HEAD_HEIGHT = 34;

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
  /** Every sequence; the ones with a member among `cards` are drawn as a group
   *  (List) or an outline (Free). */
  sequences?: PromptSequence[];
  /** The sequence open in the inspector, and the card selected. */
  activeSequence?: string | null;
  selectedId?: string | null;
  onOpenSequence?: (id: string) => void;
  /** A one-line row of a member that lives on the timeline was picked. */
  onPickStep?: (card: PromptChartCard) => void;
  onPauseToggle?: (sequence: PromptSequence) => void;
}>(function PromptDraftBoard({ scope, cards, drag, renderCard, onLayout, onCreate, sequences = [], activeSequence = null, selectedId = null, onOpenSequence, onPickStep, onPauseToggle }, ref) {
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
  useImperativeHandle(ref, () => ({
    place: (id, x, y) => {
      if (!layout.free) return false;
      const point = clientPoint(x, y);
      setLayout((value) => ({ ...value, positions: { ...value.positions, [id]: point } }));
      return true;
    },
    free: layout.free,
    setFree: (free) => setLayout((value) => value.free === free ? value : { free, positions: Object.fromEntries(cards.map((card, index) => [card.id, pointOf(card.id, index)])) }),
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
  const cardById = new Map(cards.map((card) => [card.id, card]));
  const groups = sequences.filter((sequence) => sequence.steps.some((step) => cardById.has(step.card.id)));
  const grouped = new Set(groups.flatMap((sequence) => sequence.steps.map((step) => step.card.id)));
  const header = (sequence: PromptSequence) => (
    <PromptSequenceHeader
      sequence={sequence}
      active={activeSequence === sequence.id}
      onOpen={() => onOpenSequence?.(sequence.id)}
      onPauseToggle={() => onPauseToggle?.(sequence)}
    />
  );
  /** The Free canvas's outline: the box around a group's cards, its heading below them. */
  const outline = (sequence: PromptSequence) => {
    const boxes = cards.flatMap((card, index) => sequence.steps.some((step) => step.card.id === card.id)
      ? [{ ...points[index], ...(sizes[card.id] ?? { width: 168, height: 120 }) }] : []);
    if (boxes.length === 0) return null;
    const left = Math.min(...boxes.map((box) => box.x)) - 6;
    const top = Math.min(...boxes.map((box) => box.y)) - 6;
    return (
      <PromptSequenceOutline
        key={`outline:${sequence.id}`}
        box={{
          left: Math.max(0, left),
          top: Math.max(0, top),
          width: Math.max(...boxes.map((box) => box.x + box.width)) + 6 - Math.max(0, left),
          height: Math.max(...boxes.map((box) => box.y + box.height)) + 6 + SEQUENCE_HEAD_HEIGHT - Math.max(0, top),
        }}
        header={header(sequence)}
      />
    );
  };
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
    <div ref={viewport} className="agent-prompt-draft-viewport">
      <div ref={canvas} data-testid="prompt-draft-board" className={layout.free ? "agent-prompt-draft-canvas" : "agent-prompt-drafts-row"}
        onDoubleClick={openComposer}
        style={layout.free ? {
          width: Math.max(width, ...points.map((point, index) => point.x + (sizes[cards[index].id]?.width ?? 168) + 32), composer ? composer.x + COMPOSER_WIDTH + 32 : 0),
          height: Math.max(320, ...points.map((point, index) => point.y + (sizes[cards[index].id]?.height ?? 120) + 64), composer ? composer.y + COMPOSER_HEIGHT + 64 : 0),
        } : undefined}>
        {layout.free && groups.map(outline)}
        {layout.free
          ? cards.map((card, index) => <div key={card.key} data-draft-id={card.id} className="agent-prompt-draft-position" style={{ left: points[index].x, top: points[index].y }}>{renderCard(card)}</div>)
          : (
            <>
              {groups.map((sequence) => (
                <PromptSequenceGroup key={sequence.id} header={header(sequence)}>
                  {sequence.steps.map((step) => {
                    const own = cardById.get(step.card.id);
                    return own
                      ? renderCard(own)
                      : <PromptSequenceRow key={step.card.key} step={step} selected={selectedId === step.card.id} onPick={() => onPickStep?.(step.card)} />;
                  })}
                </PromptSequenceGroup>
              ))}
              {cards.filter((card) => !grouped.has(card.id)).map((card) => renderCard(card))}
            </>
          )}
        {composerNode}
        {cards.length === 0 && !composer && <div className="file-tree-empty">{t("promptChart.noDrafts")}</div>}
      </div>
    </div>
  </>;
});
