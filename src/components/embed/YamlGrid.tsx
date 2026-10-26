import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useViewerState } from "./fileViewer/viewerState";
import { UntestedTag } from "../common/UntestedTag";
import {
  addChild,
  deleteNode,
  duplicateNode,
  isFlow,
  literalFor,
  moveNodeTo,
  parseYaml,
  scalarType,
  setValue,
  type YamlDoc,
  type YamlNode,
} from "../../lib/viewers/yaml";
import { cellKind, isContainer } from "../../lib/viewers/yamlGrid";
import { useT } from "../../lib/i18n";

/**
 * The YAML/JSON **card grid** (#yaml-grid) — the third view on the file, beside the
 * tree and Source, for reading structured data as cards.
 *
 * It is a **drill navigation**, not an infinite nest. At any moment one card is the
 * "main" one, and the grid shows:
 *   - a **breadcrumb** of the path from the document down to it,
 *   - the main card's **level** — a grid of its siblings, the main one highlighted —
 *     so you can step sideways between records without going up first,
 *   - the main card's **children** as the next level below, to drill deeper.
 * Clicking any card opens it as the new main; clicking a breadcrumb crumb (or the
 * ⌂ overview) walks back up. With nothing focused the grid is the top overview: the
 * document's own top-level cards.
 *
 * A card shows only its **scalar fields**; its nested collections are the next
 * level, reached by clicking — so a card never grows unbounded. Every card in one
 * level is given the SAME height (measured to the tallest, capped), and a card with
 * more fields than fit **scrolls inside itself** rather than stretching the row.
 *
 * Cards **reorder by dragging** among their siblings (pointer-based from a grip, as
 * WebKitGTK drops HTML5 DnD), one `moveNodeTo` splice per move. Like the tree, the
 * cards EDIT THE FILE TEXT: every action splices `text` via `lib/viewers/yaml`'s ops
 * (`setValue`/`addChild`/`deleteNode`/`duplicateNode`/`moveNodeTo`), so a card edit
 * is an ordinary dirty/undoable/saveable change on the draft the tree and Source
 * share, and comments/quoting/untouched bytes survive it. A value it can't safely
 * rewrite is shown, not offered (`source only`) — the tree's honesty rule.
 */
export function YamlGrid({
  text,
  onChange,
  tabKey,
  fontSize,
  strict,
}: {
  text: string;
  onChange: (next: string) => void;
  tabKey?: string;
  fontSize?: number;
  /** JSON dialect (a `.json` file): keys/strings added here are quoted. */
  strict?: boolean;
}) {
  const t = useT();
  const doc = useMemo(() => parseYaml(text, { strict }), [text, strict]);

  // The focused ("main") card rides with the tab, like the tree's collapse — the
  // drill position stays across a reopen and a restart. A stale id (the file
  // changed shape) is simply not found, and the grid falls back to the overview.
  const viewPos = useViewerState(tabKey);
  const [focusId, setFocusIdState] = useState<string | null>(() => viewPos.initial?.gridFocus ?? null);
  const setFocus = useCallback(
    (id: string | null) => {
      setFocusIdState(id);
      viewPos.persist({ gridFocus: id ?? undefined });
    },
    [viewPos],
  );

  // id → {node, parent}, so a focused card's ancestors and siblings are one lookup
  // away without threading parents through the render.
  const index = useMemo(() => buildIndex(doc), [doc]);

  const ctx: Ctx = useMemo(
    () => ({ doc, text, onChange, strict: !!strict }),
    [doc, text, onChange, strict],
  );

  if (doc.error) {
    return (
      <div className="yaml-tree-notice">
        <p>
          {t("yamlGrid.cantRead", {
            msg: t(doc.error.messageKey, doc.error.messageVars),
            line: doc.error.line,
          })}
        </p>
        <p className="yaml-tree-notice-hint">
          {t("yamlGrid.switchToSourcePre")}<strong>{t("yamlGrid.sourceWord")}</strong>{t("yamlGrid.switchToSourcePost")}
        </p>
      </div>
    );
  }

  const top = topCards(doc);
  if (!top.length) {
    return (
      <div className="yaml-cards">
        <div className="yaml-cards-bar">
          <span className="yaml-cards-bar-spacer" />
          <UntestedTag id="yamlGrid.1" />
        </div>
        <div className="yaml-tree-notice">
          <p>{t("yamlGrid.noEntriesYet")}</p>
        </div>
      </div>
    );
  }

  // The single root seq is the top level's parent (so its cards reorder); a single
  // root map has no reorderable siblings at the top (its ONE card is `document`).
  const topParent = doc.docs.length === 1 && doc.docs[0].kind === "seq" ? doc.docs[0] : null;
  const focused = focusId && index.has(focusId) ? focusId : null;
  const levels = buildLevels(top, topParent, focused, index);
  const crumbs = levels.map((l) => l.selectedId).filter((x): x is string => !!x).map((id) => index.get(id)!.node);

  return (
    <div className="yaml-cards" style={fontSize ? { fontSize: `${fontSize}px` } : undefined}>
      <div className="yaml-cards-bar">
        <nav className="yaml-grid-breadcrumb" aria-label={t("yamlGrid.cardPathLabel")}>
          <button
            className={`yaml-crumb${crumbs.length === 0 ? " on" : ""}`}
            onClick={() => setFocus(null)}
            title={t("yamlGrid.overviewTitle")}
          >
            {t("yamlGrid.overviewButton")}
          </button>
          {crumbs.map((node, i) => (
            <span key={node.id} className="yaml-crumb-wrap">
              <span className="yaml-crumb-sep" aria-hidden="true">
                ›
              </span>
              <button
                className={`yaml-crumb${i === crumbs.length - 1 ? " on" : ""}`}
                onClick={() => setFocus(node.id)}
                title={crumbTitle(t, node, index)}
              >
                {crumbTitle(t, node, index)}
              </button>
            </span>
          ))}
        </nav>
        <span className="yaml-cards-bar-spacer" />
        <UntestedTag id="yamlGrid.2" />
      </div>

      {levels.map((level, i) => (
        <LevelGrid
          key={level.parent ? level.parent.id : `top-${i}`}
          level={level}
          text={text}
          ctx={ctx}
          onFocus={setFocus}
        />
      ))}
    </div>
  );
}

/** The bundle every card needs, passed once instead of threaded field by field. */
interface Ctx {
  doc: YamlDoc;
  text: string;
  onChange: (next: string) => void;
  strict: boolean;
}

/** One rendered level: the cards shown, their common parent (whose child list a
 *  reorder addresses; `null` = not reorderable, e.g. a lone root map), and which
 *  card is on the path to the focus (highlighted as the "main" card). */
interface Level {
  cards: YamlNode[];
  parent: YamlNode | null;
  selectedId: string | null;
}

/** Keys that name a record, tried in order to title a list item's card. */
const TITLE_KEYS = ["name", "id", "title", "label", "key", "host", "type", "kind"];

/** A friendly title for a list member. A mapping is named by its first name-ish
 *  field's value; anything else falls back to a 1-based `Item N`. Never `#0`. */
function itemTitle(t: ReturnType<typeof useT>, node: YamlNode, index: number): string {
  if (node.kind === "map") {
    for (const k of TITLE_KEYS) {
      const field = node.children.find(
        (c) => c.key === k && c.kind === "scalar" && c.value.trim() !== "",
      );
      if (field) return field.value;
    }
  }
  return t("yamlGrid.itemFallback", { n: index + 1 });
}

/** The document's top-level cards: a root map is one `document` card; a root list
 *  is a card per item; multiple documents flatten into one top row. */
function topCards(doc: YamlDoc): YamlNode[] {
  return doc.docs.flatMap((root) => (root.kind === "seq" ? root.children : [root]));
}

/** A card's children that are themselves cards — its nested collections. Scalars
 *  are fields shown ON the card, not cards in the next level. */
function subcardsOf(node: YamlNode): YamlNode[] {
  return node.children.filter(isContainer);
}

/** id → {node, parent} for the whole document, so ancestors/siblings are a lookup. */
function buildIndex(doc: YamlDoc): Map<string, { node: YamlNode; parent: YamlNode | null }> {
  const m = new Map<string, { node: YamlNode; parent: YamlNode | null }>();
  const walk = (node: YamlNode, parent: YamlNode | null) => {
    m.set(node.id, { node, parent });
    for (const c of node.children) walk(c, node);
  };
  for (const r of doc.docs) walk(r, null);
  return m;
}

/** Whether `ancestorId` is a (strict) ancestor of `targetId` in the doc tree. */
function isAncestorOf(
  ancestorId: string,
  targetId: string,
  index: Map<string, { node: YamlNode; parent: YamlNode | null }>,
): boolean {
  let cur = index.get(targetId)?.parent ?? null;
  while (cur) {
    if (cur.id === ancestorId) return true;
    cur = index.get(cur.id)?.parent ?? null;
  }
  return false;
}

/** Walk the drill from the top row down to the focused card, one level per step:
 *  each level highlights the card on the path, and the next level is that card's
 *  children — ending with the focused card's own children (nothing highlighted). */
function buildLevels(
  top: YamlNode[],
  topParent: YamlNode | null,
  focusId: string | null,
  index: Map<string, { node: YamlNode; parent: YamlNode | null }>,
): Level[] {
  const levels: Level[] = [];
  let cards = top;
  let parent = topParent;
  // Guard against a pathological cycle (ids are unique, but be safe).
  for (let guard = 0; guard < 64; guard++) {
    const selected = focusId
      ? cards.find((c) => c.id === focusId || isAncestorOf(c.id, focusId, index)) ?? null
      : null;
    levels.push({ cards, parent, selectedId: selected?.id ?? null });
    if (!selected) break;
    const kids = subcardsOf(selected);
    if (selected.id === focusId) {
      if (kids.length) levels.push({ cards: kids, parent: selected, selectedId: null });
      break;
    }
    if (!kids.length) break;
    cards = kids;
    parent = selected;
  }
  return levels;
}

/** A card's display title, given its parent (a mapping keeps its key; a list member
 *  gets its name-ish field, else `Item N`; a lone root map is `document`). */
function titleFor(
  t: ReturnType<typeof useT>,
  node: YamlNode,
  parent: YamlNode | null,
  indexInParent: number,
): string {
  if (!parent) return node.path.length === 0 && node.kind === "map" ? t("yamlGrid.documentTitle") : itemTitle(t, node, indexInParent);
  if (parent.kind === "map") return node.key ?? itemTitle(t, node, indexInParent);
  return itemTitle(t, node, indexInParent);
}

/** A breadcrumb crumb's short label — the same title the card wears in its level. */
function crumbTitle(
  t: ReturnType<typeof useT>,
  node: YamlNode,
  index: Map<string, { node: YamlNode; parent: YamlNode | null }>,
): string {
  const parent = index.get(node.id)?.parent ?? null;
  const i = parent ? parent.children.indexOf(node) : 0;
  return titleFor(t, node, parent, i);
}

/** How tall a level's cards may grow before their fields scroll inside them. */
const LEVEL_MAX_HEIGHT = 320;

/**
 * One level of the drill: a grid of sibling cards, all forced to the SAME height
 * (measured to the tallest, capped at {@link LEVEL_MAX_HEIGHT}; a card with more
 * fields scrolls inside itself). Owns the pointer-drag reorder among its cards —
 * `siblings` is the parent's full child list (what `moveNodeTo` addresses); a drop
 * maps a card's grid position back to its real index there.
 */
function LevelGrid({
  level,
  text,
  ctx,
  onFocus,
}: {
  level: Level;
  text: string;
  ctx: Ctx;
  onFocus: (id: string | null) => void;
}) {
  const t = useT();
  const { cards, parent, selectedId } = level;
  const siblings = parent?.children ?? cards;

  // One ref array, shared by the drag hit-test and the equal-height measurement.
  const els = useRef<(HTMLDivElement | null)[]>([]);
  const live = useRef<{ from: number; to: number } | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);

  // ── Equal height ──────────────────────────────────────────────────────────
  // Re-measure whenever the level's shape or the file text changes (an edit can
  // add/remove a field). `null` renders the cards at natural height so the tallest
  // can be read; the effect then pins every card to it.
  const [height, setHeight] = useState<number | null>(null);
  const sig = useMemo(() => cards.map((c) => c.id).join("|") + "#" + text.length, [cards, text]);
  useLayoutEffect(() => {
    setHeight(null);
  }, [sig]);
  useLayoutEffect(() => {
    if (height !== null) return;
    let max = 0;
    for (const el of els.current) if (el) max = Math.max(max, el.offsetHeight);
    if (max > 0) setHeight(Math.min(max, LEVEL_MAX_HEIGHT));
  });

  // ── Drag reorder ──────────────────────────────────────────────────────────
  const indexAt = (x: number, y: number): number => {
    let best = live.current?.from ?? 0;
    let bestDist = Infinity;
    for (let i = 0; i < cards.length; i++) {
      const el = els.current[i];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return i;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best;
  };
  const start = (i: number) => {
    live.current = { from: i, to: i };
    setDrag(live.current);
  };
  const over = (x: number, y: number) => {
    const d = live.current;
    if (!d) return;
    const to = indexAt(x, y);
    if (to !== d.to) {
      live.current = { from: d.from, to };
      setDrag(live.current);
    }
  };
  // A cancelled gesture writes NOTHING — see `hooks/useListReorder`, which states
  // the rule for a grip drag among siblings. `drop()`'s fallback when the pointer
  // is outside the list is card 0, so committing on cancel let a press-and-twitch
  // move a card to the front of its level and splice the file.
  const abort = () => {
    live.current = null;
    setDrag(null);
  };

  const drop = () => {
    const d = live.current;
    live.current = null;
    setDrag(null);
    if (!d || d.to === d.from) return;
    const node = cards[d.from];
    const target = cards[d.to];
    if (!node.deletable || !target.deletable) return;
    const to = siblings.findIndex((s) => s.id === target.id);
    if (to >= 0) ctx.onChange(moveNodeTo(ctx.text, siblings, node, to));
  };

  return (
    <div className="yaml-level">
      <div className="yaml-level-grid">
        {cards.map((node, i) => {
          const movable = !!parent && node.deletable && cards.length > 1;
          const cardDrag: CardDrag = {
            rowRef: (el) => {
              els.current[i] = el;
            },
            dragging: drag?.from === i,
            dropTarget: drag != null && drag.to === i && drag.to !== drag.from,
            blocked: drag != null && !node.deletable,
            grip: movable
              ? {
                  onPointerDown: (e) => {
                    e.preventDefault();
                    e.currentTarget.setPointerCapture?.(e.pointerId);
                    start(i);
                  },
                  onPointerMove: (e) => over(e.clientX, e.clientY),
                  onPointerUp: (e) => {
                    e.currentTarget.releasePointerCapture?.(e.pointerId);
                    drop();
                  },
                  onPointerCancel: abort,
                }
              : null,
          };
          return (
            <LevelCard
              key={node.id}
              node={node}
              title={titleFor(t, node, parent, siblings.indexOf(node))}
              selected={node.id === selectedId}
              height={height}
              onFocus={onFocus}
              ctx={ctx}
              drag={cardDrag}
            />
          );
        })}
      </div>
      {parent && <AddBar node={parent} ctx={ctx} />}
    </div>
  );
}

/** A card's slot in its level's drag — the grip handlers, its live drag flags, and
 *  the ref the level measures + hit-tests it by. `null` grip = not draggable. */
interface CardDrag {
  rowRef: (el: HTMLDivElement | null) => void;
  dragging: boolean;
  dropTarget: boolean;
  blocked: boolean;
  grip: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onPointerCancel: () => void;
  } | null;
}

/** The classes a card wears while a drag is in flight — shared by every card. */
function cardDragClass(drag: CardDrag | null): string {
  if (!drag) return "";
  return [
    drag.dragging ? "yaml-card-dragging" : "",
    drag.dropTarget ? "yaml-card-drop" : "",
    drag.blocked ? "yaml-card-blocked" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function CardGrip({ drag, title }: { drag: CardDrag | null; title: string }) {
  const t = useT();
  if (!drag?.grip) return null;
  return (
    <button
      className="yaml-grip yaml-card-grip"
      title={t("yamlGrid.dragToReorder")}
      aria-label={t("yamlGrid.reorderLabel", { title })}
      {...drag.grip}
    >
      ⠿
    </button>
  );
}

/**
 * One card in a level: its scalar children are editable fields (scrolling inside
 * the fixed card height when there are many); its nested collections are NOT shown
 * inline — a "N groups" footer (and the title) opens the card as the new main,
 * revealing them as the next level. A bare scalar list item is a value-only card.
 */
function LevelCard({
  node,
  title,
  selected,
  height,
  onFocus,
  ctx,
  drag,
}: {
  node: YamlNode;
  title: string;
  selected: boolean;
  height: number | null;
  onFocus: (id: string | null) => void;
  ctx: Ctx;
  drag: CardDrag | null;
}) {
  const t = useT();
  const scalar = !isContainer(node);
  const entries = node.children.map((child, i) => ({ child, i }));
  const scalars = entries.filter((e) => e.child.kind === "scalar");
  const subs = scalar ? [] : subcardsOf(node);
  const n = node.children.length;
  const badge = scalar
    ? ""
    : node.kind === "seq"
      ? t(n === 1 ? "yamlGrid.itemsBadgeOne" : "yamlGrid.itemsBadgeMany", { n })
      : t(n === 1 ? "yamlGrid.keysBadgeOne" : "yamlGrid.keysBadgeMany", { n });
  const canDrill = subs.length > 0;
  const style: CSSProperties | undefined = height != null ? { height: `${height}px` } : undefined;

  return (
    <div
      className={`yaml-card yaml-level-card${selected ? " yaml-card-main" : ""} ${cardDragClass(drag)}`.trimEnd()}
      style={style}
      ref={drag?.rowRef}
    >
      <div className="yaml-card-head">
        <CardGrip drag={drag} title={title} />
        {canDrill ? (
          <button
            className="yaml-card-toggle"
            onClick={() => onFocus(node.id)}
            title={t("yamlGrid.openTitle", { title })}
            aria-label={t("yamlGrid.openTitle", { title })}
          >
            <span className="yaml-card-title">{title}</span>
          </button>
        ) : (
          <span className="yaml-card-title yaml-card-title-static">{title}</span>
        )}
        {!scalar && isFlow(node) && (
          <span className="yaml-flow-tag" title={t("yamlGrid.flowStyleTitle")}>
            {node.kind === "seq" ? "[ ]" : "{ }"}
          </span>
        )}
        {badge && <span className="yaml-card-badge">{badge}</span>}
        {node.deletable && (
          <button
            className="yaml-act yaml-act-del yaml-card-del"
            title={t("yamlGrid.deleteCardTitle")}
            aria-label={t("yamlGrid.deleteLabel", { title })}
            onClick={() => {
              // Deleting the main card (or an ancestor of it) drops the focus back
              // to safety — the level rebuilds and a stale focus would vanish.
              if (selected) onFocus(null);
              ctx.onChange(deleteNode(ctx.text, node));
            }}
          >
            ×
          </button>
        )}
      </div>

      <div className="yaml-card-scroll">
        {scalar ? (
          <div className="yaml-card-field yaml-card-field-scalar">
            {cellKind(node, null) === "scalar" ? (
              <CommitInput
                className={`yaml-value-input yaml-val-${scalarType(node)}`}
                initial={node.value}
                ariaLabel={t("yamlGrid.valueOfLabel", { label: title })}
                onCommit={(next) => ctx.onChange(setValue(ctx.text, ctx.doc, node, next))}
              />
            ) : (
              <span className="yaml-value-locked" title={node.raw}>
                {node.raw || node.value}
              </span>
            )}
          </div>
        ) : scalars.length > 0 ? (
          <div className="yaml-card-fields">
            {scalars.map(({ child, i }) => (
              <FieldRow key={child.id} entry={child} parentKind={node.kind} index={i} ctx={ctx} />
            ))}
          </div>
        ) : (
          <div className="yaml-card-empty">{t("yamlGrid.noFields")}</div>
        )}
      </div>

      {!scalar && <AddBar node={node} ctx={ctx} />}
      {canDrill && (
        <button
          className="yaml-card-drill"
          onClick={() => onFocus(node.id)}
          title={t(subs.length === 1 ? "yamlGrid.openGroupsTitleOne" : "yamlGrid.openGroupsTitleMany", { n: subs.length })}
        >
          {t(subs.length === 1 ? "yamlGrid.groupsBadgeOne" : "yamlGrid.groupsBadgeMany", { n: subs.length })} <span aria-hidden="true">▸</span>
        </button>
      )}
    </div>
  );
}

/** One scalar field inside a card: a label (key, or list index) and its value —
 *  edit-in-place when the tree can rewrite it, read-only (`source only`) when not. */
function FieldRow({
  entry,
  parentKind,
  index,
  ctx,
}: {
  entry: YamlNode;
  parentKind: string;
  index: number;
  ctx: Ctx;
}) {
  const t = useT();
  const inSeq = parentKind === "seq";
  const label = inSeq ? "–" : entry.key ?? "";
  const kind = cellKind(entry, null);

  return (
    <div className="yaml-card-field">
      <span
        className={`yaml-card-key${inSeq ? " yaml-card-bullet" : ""}`}
        title={inSeq ? t("yamlGrid.itemIndexTitle", { n: index + 1 }) : label}
      >
        {label}
      </span>
      {kind === "scalar" ? (
        <CommitInput
          className={`yaml-value-input yaml-val-${scalarType(entry)}`}
          initial={entry.value}
          ariaLabel={t("yamlGrid.valueOfLabel", { label })}
          placeholder={entry.style === "empty" ? t("yamlGrid.nullPlaceholder") : undefined}
          onCommit={(next) => ctx.onChange(setValue(ctx.text, ctx.doc, entry, next))}
        />
      ) : (
        <span
          className="yaml-value-locked"
          title={entry.raw || t("yamlGrid.sourceOnlyTitle")}
        >
          {entry.raw || entry.value}
        </span>
      )}
      {entry.deletable && (
        <button
          className="yaml-act yaml-act-del yaml-card-field-del"
          title={t("yamlGrid.deleteFieldTitle")}
          aria-label={t("yamlGrid.deleteLabel", { title: label })}
          onClick={() => ctx.onChange(deleteNode(ctx.text, entry))}
        >
          ×
        </button>
      )}
    </div>
  );
}

/** The add affordances at the foot of a card: a mapping grows a field, a sequence a
 *  card or a value (and can copy its last item — fastest for like-shaped records). */
function AddBar({ node, ctx }: { node: YamlNode; ctx: Ctx }) {
  const t = useT();
  const [adding, setAdding] = useState(false);
  if (node.kind !== "map" && node.kind !== "seq") return null;
  const lastChild = node.children[node.children.length - 1];
  const canCopy = node.kind === "seq" && lastChild && lastChild.deletable;

  if (node.kind === "map") {
    return (
      <div className="yaml-card-add">
        {adding ? (
          <CommitInput
            className="yaml-key-input"
            initial=""
            placeholder={t("yamlGrid.newFieldPlaceholder")}
            ariaLabel={t("yamlGrid.newFieldKeyLabel")}
            autoFocus
            onCommit={(next) => {
              setAdding(false);
              const key = next.trim();
              if (key) {
                ctx.onChange(
                  addChild(ctx.text, ctx.doc, node, "key", key, literalFor("text", "", ctx.strict)),
                );
              }
            }}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <button className="yaml-add" onClick={() => setAdding(true)}>
            {t("yamlGrid.addFieldButton")}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="yaml-card-add">
      <button
        className="yaml-add"
        title={t("yamlGrid.addCardTitle")}
        onClick={() => ctx.onChange(addChild(ctx.text, ctx.doc, node, "item", "", "{}"))}
      >
        {t("yamlGrid.addCardButton")}
      </button>
      <button
        className="yaml-add"
        title={t("yamlGrid.addValueTitle")}
        onClick={() =>
          ctx.onChange(
            addChild(ctx.text, ctx.doc, node, "item", "", literalFor("text", "", ctx.strict)),
          )
        }
      >
        {t("yamlGrid.addValueButton")}
      </button>
      {canCopy && (
        <button
          className="yaml-add"
          title={t("yamlGrid.copyLastTitle")}
          onClick={() => ctx.onChange(duplicateNode(ctx.text, lastChild))}
        >
          {t("yamlGrid.copyLastButton")}
        </button>
      )}
    </div>
  );
}

/**
 * A single-line input that commits on Enter/blur and reverts on Escape. It holds
 * its own buffer rather than driving `onChange` per keystroke: a commit re-encodes
 * the value into the file (quoting when it must), and doing that per keypress would
 * rewrite the text under the caret.
 */
function CommitInput({
  initial,
  className,
  ariaLabel,
  placeholder,
  autoFocus,
  onCommit,
  onCancel,
}: {
  initial: string;
  className: string;
  ariaLabel: string;
  placeholder?: string;
  autoFocus?: boolean;
  onCommit: (next: string) => void;
  onCancel?: () => void;
}) {
  const [buf, setBuf] = useState(initial);
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) setBuf(initial);
  }, [initial]);

  return (
    <input
      className={className}
      value={buf}
      placeholder={placeholder}
      aria-label={ariaLabel}
      autoFocus={autoFocus}
      style={fullWidth}
      onChange={(e) => {
        dirty.current = true;
        setBuf(e.target.value);
      }}
      onBlur={() => {
        dirty.current = false;
        if (buf !== initial) onCommit(buf);
        else onCancel?.();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          dirty.current = false;
          if (buf !== initial) onCommit(buf);
          else onCancel?.();
        } else if (e.key === "Escape") {
          e.preventDefault();
          dirty.current = false;
          setBuf(initial);
          onCancel?.();
        }
      }}
    />
  );
}

const fullWidth: CSSProperties = { width: "100%" };
