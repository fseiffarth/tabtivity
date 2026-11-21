import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useViewerState } from "./fileViewer/viewerState";
import { UntestedTag } from "../common/UntestedTag";
import {
  addChild,
  childLiteral,
  deleteNode,
  duplicateNode,
  lastDuplicable,
  moveNodeTo,
  parseYaml,
  setValue,
  type YamlDoc,
  type YamlNode,
} from "../../lib/viewers/yaml";
import {
  buildIndex,
  buildLevels,
  isContainer,
  recordName,
  subcardsOf,
  type Level,
  type NodeIndex,
} from "../../lib/viewers/yamlGrid";
import { useT } from "../../lib/i18n";
import { useSiblingDrag, type SiblingGrip } from "../../hooks/useSiblingDrag";
import { ChevronRightIcon, CloseIcon, GripIcon } from "../common/icons/Icon";
import { CommitInput, FlowTag, ParseNotice, ValueCell, countBadge } from "./YamlParts";

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
  doc: parsed,
}: {
  text: string;
  onChange: (next: string) => void;
  tabKey?: string;
  fontSize?: number;
  /** JSON dialect (a `.json` file): keys/strings added here are quoted. */
  strict?: boolean;
  /** `text` already parsed in this dialect, when the host holds it — the host
   *  parses the draft to decide whether cards are offered at all, and one parse
   *  per edit is enough. Parsed here when absent. */
  doc?: YamlDoc;
}) {
  const t = useT();
  const doc = useMemo(() => parsed ?? parseYaml(text, { strict }), [parsed, text, strict]);

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
  // away without threading parents through the render. Only a focus asks it
  // anything, so the overview does not walk the document to build it.
  const index = useMemo(() => (focusId ? buildIndex(doc) : NO_INDEX), [doc, focusId]);
  const focused = focusId && index.has(focusId) ? focusId : null;
  const levels = useMemo(() => buildLevels(doc, focused, index), [doc, focused, index]);

  const ctx: Ctx = useMemo(() => ({ doc, text, onChange }), [doc, text, onChange]);

  if (doc.error) return <ParseNotice error={doc.error} cantReadKey="yamlGrid.cantRead" />;

  if (!levels[0].cards.length) {
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

  const crumbs = levels.flatMap((l) => (l.selected ? [l.selected] : []));

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
          {crumbs.map((node, i) => {
            const title = crumbTitle(t, node, index);
            return (
              <span key={node.id} className="yaml-crumb-wrap">
                <span className="yaml-crumb-sep" aria-hidden="true">
                  <ChevronRightIcon />
                </span>
                <button
                  className={`yaml-crumb${i === crumbs.length - 1 ? " on" : ""}`}
                  onClick={() => setFocus(node.id)}
                  title={title}
                >
                  {title}
                </button>
              </span>
            );
          })}
        </nav>
        <span className="yaml-cards-bar-spacer" />
        <UntestedTag id="yamlGrid.2" />
      </div>

      {levels.map((level, i) => (
        <LevelGrid
          key={level.parent ? level.parent.id : `top-${i}`}
          level={level}
          ctx={ctx}
          onFocus={setFocus}
        />
      ))}
    </div>
  );
}

const NO_INDEX: NodeIndex = new Map();

/** The bundle every card needs, passed once instead of threaded field by field. */
interface Ctx {
  doc: YamlDoc;
  text: string;
  onChange: (next: string) => void;
}

type T = ReturnType<typeof useT>;

/** A card's display title, given its parent: a mapping's entry keeps its key; a
 *  list member is named by its name-ish field, else a 1-based `Item N` (never
 *  `#0`); a lone root map is `document`. */
function titleFor(t: T, node: YamlNode, parent: YamlNode | null, indexInParent: number): string {
  if (!parent && node.path.length === 0 && node.kind === "map") return t("yamlGrid.documentTitle");
  return (
    (parent?.kind === "map" ? node.key : null) ??
    recordName(node) ??
    t("yamlGrid.itemFallback", { n: indexInParent + 1 })
  );
}

/** A breadcrumb crumb's short label — the same title the card wears in its level. */
function crumbTitle(t: T, node: YamlNode, index: NodeIndex): string {
  const parent = index.get(node.id)?.parent ?? null;
  return titleFor(t, node, parent, parent ? parent.children.indexOf(node) : 0);
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
  ctx,
  onFocus,
}: {
  level: Level;
  ctx: Ctx;
  onFocus: (id: string | null) => void;
}) {
  const t = useT();
  const { cards, parent, selected } = level;
  const siblings = parent?.children ?? cards;
  // Where each card sits in its parent's FULL child list (the scalars between the
  // cards count) — what its `Item N` title and a reorder's target index mean.
  const position = useMemo(() => new Map(siblings.map((s, i) => [s, i])), [siblings]);

  // One ref array, shared by the drag hit-test and the equal-height measurement.
  const els = useRef<(HTMLDivElement | null)[]>([]);

  // ── Equal height ──────────────────────────────────────────────────────────
  // Re-measure when something that sets a card's height changes: which cards the
  // level holds, how many entries each has, and how many lines each spans (a
  // block scalar growing). Retyping a one-line value changes none of them, so an
  // ordinary edit does not unpin and re-lay-out the whole level. `null` renders
  // the cards at natural height so the tallest can be read; the effect then pins
  // every card to it.
  const [height, setHeight] = useState<number | null>(null);
  const sig = useMemo(
    () => cards.map((c) => `${c.id}:${c.children.length}:${c.endLine - c.line}`).join("|"),
    [cards],
  );
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
  const { drag, grip } = useSiblingDrag(
    // The card under the pointer, else the nearest by centre — a 2-D grid has
    // gaps, and a pointer in one still means the card beside it.
    (x, y, from) => {
      let best = from;
      let bestDist = Infinity;
      for (let i = 0; i < cards.length; i++) {
        const el = els.current[i];
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return i;
        const d = (x - (r.left + r.width / 2)) ** 2 + (y - (r.top + r.height / 2)) ** 2;
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      return best;
    },
    (from, to) => {
      const node = cards[from];
      const target = cards[to];
      if (!node.deletable || !target.deletable) return;
      const at = position.get(target);
      if (at != null) ctx.onChange(moveNodeTo(ctx.text, siblings, node, at));
    },
  );

  return (
    <div className="yaml-level">
      <div className="yaml-level-grid">
        {cards.map((node, i) => (
          <LevelCard
            key={node.id}
            node={node}
            index={i}
            title={titleFor(t, node, parent, position.get(node) ?? i)}
            selected={node === selected}
            height={height}
            onFocus={onFocus}
            ctx={ctx}
            cardRef={(el) => {
              els.current[i] = el;
            }}
            grip={parent && node.deletable && cards.length > 1 ? grip : null}
            // The card being dragged lifts and dims; the card it would land on
            // rings; one that can't be a target fades while a drag is in flight.
            dragClass={
              drag
                ? [
                    drag.from === i ? "yaml-card-dragging" : "",
                    drag.to === i && drag.to !== drag.from ? "yaml-card-drop" : "",
                    node.deletable ? "" : "yaml-card-blocked",
                  ]
                    .filter(Boolean)
                    .join(" ")
                : ""
            }
          />
        ))}
      </div>
      {parent && <AddBar node={parent} ctx={ctx} />}
    </div>
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
  index,
  title,
  selected,
  height,
  onFocus,
  ctx,
  cardRef,
  grip,
  dragClass,
}: {
  node: YamlNode;
  /** The card's position in its level — what the level's drag addresses it by. */
  index: number;
  title: string;
  selected: boolean;
  height: number | null;
  onFocus: (id: string | null) => void;
  ctx: Ctx;
  /** The element the level measures and hit-tests this card by. */
  cardRef: (el: HTMLDivElement | null) => void;
  /** The level's drag, or `null` for a card that cannot be reordered. */
  grip: SiblingGrip | null;
  dragClass: string;
}) {
  const t = useT();
  const scalar = !isContainer(node);
  const subs = subcardsOf(node);
  const canDrill = subs.length > 0;
  const style: CSSProperties | undefined = height != null ? { height: `${height}px` } : undefined;
  const commit = (entry: YamlNode) => (next: string) =>
    ctx.onChange(setValue(ctx.text, ctx.doc, entry, next));

  return (
    <div
      className={["yaml-card", "yaml-level-card", selected ? "yaml-card-main" : "", dragClass]
        .filter(Boolean)
        .join(" ")}
      style={style}
      ref={cardRef}
    >
      <div className="yaml-card-head">
        {grip && (
          <button
            className="yaml-grip yaml-card-grip"
            title={t("yamlGrid.dragToReorder")}
            aria-label={t("yamlGrid.reorderLabel", { title })}
            onPointerDown={(e) => grip.down(index, e)}
            onPointerMove={grip.move}
            onPointerUp={grip.up}
            onPointerCancel={grip.cancel}
          >
            <GripIcon />
          </button>
        )}
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
        {!scalar && <FlowTag node={node} />}
        {!scalar && <span className="yaml-card-badge">{countBadge(t, node)}</span>}
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
            <CloseIcon />
          </button>
        )}
      </div>

      <div className="yaml-card-scroll">
        {scalar ? (
          <div className="yaml-card-field yaml-card-field-scalar">
            <ValueCell node={node} label={title} onCommit={commit(node)} />
          </div>
        ) : node.children.some((c) => c.kind === "scalar") ? (
          <div className="yaml-card-fields">
            {node.children.map(
              (child, i) =>
                child.kind === "scalar" && (
                  <FieldRow
                    key={child.id}
                    entry={child}
                    inSeq={node.kind === "seq"}
                    index={i}
                    onCommit={commit(child)}
                    ctx={ctx}
                  />
                ),
            )}
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
  inSeq,
  index,
  onCommit,
  ctx,
}: {
  entry: YamlNode;
  inSeq: boolean;
  index: number;
  onCommit: (next: string) => void;
  ctx: Ctx;
}) {
  const t = useT();
  const label = inSeq ? "–" : entry.key ?? "";

  return (
    <div className="yaml-card-field">
      <span
        className={`yaml-card-key${inSeq ? " yaml-card-bullet" : ""}`}
        title={inSeq ? t("yamlGrid.itemIndexTitle", { n: index + 1 }) : label}
      >
        {label}
      </span>
      <ValueCell node={entry} label={label} onCommit={onCommit} />
      {entry.deletable && (
        <button
          className="yaml-act yaml-act-del yaml-card-field-del"
          title={t("yamlGrid.deleteFieldTitle")}
          aria-label={t("yamlGrid.deleteLabel", { title: label })}
          onClick={() => ctx.onChange(deleteNode(ctx.text, entry))}
        >
          <CloseIcon />
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
  const add = (kind: "key" | "item", key: string, type: "text" | "map") =>
    ctx.onChange(addChild(ctx.text, ctx.doc, node, kind, key, childLiteral(ctx.doc, node, type, "")));

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
              if (key) add("key", key, "text");
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
  if (node.kind !== "seq") return null;

  const last = lastDuplicable(node);
  return (
    <div className="yaml-card-add">
      <button
        className="yaml-add"
        title={t("yamlGrid.addCardTitle")}
        onClick={() => add("item", "", "map")}
      >
        {t("yamlGrid.addCardButton")}
      </button>
      <button
        className="yaml-add"
        title={t("yamlGrid.addValueTitle")}
        onClick={() => add("item", "", "text")}
      >
        {t("yamlGrid.addValueButton")}
      </button>
      {last && (
        <button
          className="yaml-add"
          title={t("yamlGrid.copyLastTitle")}
          onClick={() => ctx.onChange(duplicateNode(ctx.text, last))}
        >
          {t("yamlGrid.copyLastButton")}
        </button>
      )}
    </div>
  );
}
