import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { useViewerState } from "./fileViewer/viewerState";
import {
  parseYaml,
  setValue,
  renameKey,
  deleteNode,
  addChild,
  addRootEntry,
  duplicateNode,
  moveNode,
  moveNodeTo,
  canAddChild,
  canComment,
  canPasteAfter,
  commentOf,
  copyNode,
  inlineListValues,
  setListItems,
  pasteAfter,
  setComment,
  isFlow,
  literalFor,
  scalarType,
  type YamlClip,
  type YamlDoc,
  type YamlNode,
  type YamlValueType,
} from "../../lib/viewers/yaml";
import { useT } from "../../lib/i18n";

/**
 * The YAML/JSON tree editor (#yaml) — the structured half of the viewer, the way
 * the rendered preview is the structured half of the markdown viewer.
 *
 * It edits the FILE TEXT, not a model of it: every action here is a splice back
 * into `text` (see `lib/viewers/yaml`), and the result goes straight to the same
 * draft the Source tab shows. That is the whole design — the two modes never
 * convert between representations, so comments and formatting survive an edit,
 * and Ctrl+S / undo / redo / format / validation all keep working on the text
 * underneath without knowing the tree exists.
 *
 * Both syntaxes render as one tree, and each keeps its own: a block collection
 * grows by lines, a flow one (`{a: 1}` — i.e. JSON) grows inside its brackets.
 * `strict` is set for a `.json` file, where every key and string is quoted.
 *
 * What the tree offers, it can do: a node the parser cannot rewrite safely (an
 * anchor, an alias, a merge key, a plain scalar continued across lines) renders
 * with its edit affordances withheld rather than a control that would corrupt the
 * file.
 */

// ── The copy buffer ─────────────────────────────────────────────────────────
// Module-level, not component state: copying in one tab and pasting in another
// (or after the viewer remounts) is the point of a clipboard. The system
// clipboard receives the same text, but the paste cursor works from THIS one —
// it carries the structure (block/flow, mapping entry/item) a raw string no
// longer has, which is what lets the cursor refuse a spot the paste would tear.
let clipCurrent: YamlClip | null = null;
const clipSubs = new Set<() => void>();

function setClip(next: YamlClip | null) {
  clipCurrent = next;
  for (const fn of clipSubs) fn();
}

function useClip(): YamlClip | null {
  return useSyncExternalStore(
    (cb) => {
      clipSubs.add(cb);
      return () => clipSubs.delete(cb);
    },
    () => clipCurrent,
  );
}

export function YamlTree({
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
  /** JSON dialect (a `.json` file): keys and strings are always quoted. */
  strict?: boolean;
}) {
  const t = useT();
  const doc = useMemo(() => parseYaml(text, { strict }), [text, strict]);

  // Collapse state rides with the tab (like the reader's scroll position), so
  // folding a big config stays folded across a reopen and a restart.
  const viewPos = useViewerState(tabKey);
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(viewPos.initial?.yamlCollapsed ?? []),
  );
  const toggle = useCallback(
    (id: string) => {
      setCollapsed((cur) => {
        const next = new Set(cur);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        viewPos.persist({ yamlCollapsed: [...next] });
        return next;
      });
    },
    [viewPos],
  );

  // The row currently showing its "add entry" form, as `${parentId}:${kind}`.
  const [adding, setAdding] = useState<string | null>(null);

  // Copy → paste: the app-wide buffer, and where THIS tree's paste cursor sits
  // (the id of the entry the paste would follow). The buffer is shared so a copy
  // travels between tabs; the cursor is per tree — two views of two files must
  // not fight over one insertion point.
  const clip = useClip();
  const [cursorId, setCursorId] = useState<string | null>(null);

  // Esc cancels the whole paste mode — cursor and buffer both — but never while
  // typing in one of the tree's inputs, whose own Escape means "revert this
  // field". A buffer cleared elsewhere (another tab's Esc, the banner's ×) takes
  // this tree's cursor with it.
  useEffect(() => {
    if (!clip) {
      setCursorId(null);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      setCursorId(null);
      setClip(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clip]);

  if (doc.error) {
    return (
      <div className="yaml-tree-notice">
        <p>
          {t("yamlTree.cantRead", {
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

  if (!doc.docs.length) {
    return (
      <div className="yaml-tree" style={fontSize ? { fontSize: `${fontSize}px` } : undefined}>
        <div className="yaml-tree-notice">
          <p>{t("yamlGrid.noEntriesYet")}</p>
        </div>
        {adding ? (
          <AddRow
            depth={0}
            kind={adding === "root:item" ? "item" : "key"}
            onCancel={() => setAdding(null)}
            onAdd={(kind, key, type, value) => {
              onChange(
                addRootEntry(text, kind, key, literalFor(type, value, doc.strict), doc.strict),
              );
              setAdding(null);
            }}
          />
        ) : (
          <div className="yaml-row yaml-row-add">
            <button className="yaml-add" onClick={() => setAdding("root:key")}>
              {t("yamlTree.addKeyButton")}
            </button>
            <button className="yaml-add" onClick={() => setAdding("root:item")}>
              {t("yamlTree.addItemButton")}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="yaml-tree" style={fontSize ? { fontSize: `${fontSize}px` } : undefined}>
      {/* What the copy button captured, and how to use or drop it — the banner is
          also the one cancel affordance a mouse-only user has. */}
      {clip && (
        <div className="yaml-clip-banner">
          <span>
            {t("yamlTree.copiedBannerPre")}<strong>{clip.label}</strong>{t("yamlTree.copiedBannerPost")}
          </span>
          <button
            className="yaml-act"
            onClick={() => {
              setCursorId(null);
              setClip(null);
            }}
            title={t("yamlTree.forgetCopiedTitle")}
            aria-label={t("yamlTree.forgetCopiedLabel")}
          >
            ×
          </button>
        </div>
      )}
      {doc.docs.map((root, i) => (
        <div className="yaml-doc" key={root.id}>
          {doc.docs.length > 1 && <div className="yaml-doc-sep">{t("yamlTree.documentSeparator", { n: i + 1 })}</div>}
          <YamlRows
            nodes={root.children}
            parent={root}
            depth={0}
            text={text}
            doc={doc}
            onChange={onChange}
            collapsed={collapsed}
            toggle={toggle}
            adding={adding}
            setAdding={setAdding}
            cursorId={cursorId}
            setCursor={setCursorId}
          />
          {adding?.startsWith(`${root.id}:`) ? (
            <AddRow
              depth={0}
              kind={adding.endsWith(":item") ? "item" : "key"}
              onCancel={() => setAdding(null)}
              onAdd={(kind, key, type, value) => {
                onChange(
                  addChild(
                    text,
                    doc,
                    root,
                    kind,
                    key,
                    literalFor(type, value, doc.strict, root.inFlow || isFlow(root)),
                  ),
                );
                setAdding(null);
              }}
              onCopyLast={copyLastAction(root, text, onChange, () => setAdding(null))}
            />
          ) : (
            <AddControls node={root} adding={adding} setAdding={setAdding} />
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * One level of siblings. Split out so a row's children re-render on their own — and
 * because it is the natural home for the drag: a node can only be reordered AMONG
 * ITS SIBLINGS (there is no such thing as dragging a key into a different mapping —
 * that is a re-parent, not a reorder), so the list that owns them owns the gesture.
 *
 * The drag is pointer-based, not HTML5 drag-and-drop, which does not work under
 * WebKitGTK; and every pointer handler is bound to the grip up front rather than
 * added to the window mid-gesture, because listeners registered once a gesture is
 * already under way are the ones WebKitGTK drops.
 */
/** How an ancestor's hover marks the rows beneath it: the plain substructure
 *  highlight, the accent tint of a hovered whole-entry action (copy, move,
 *  comment), the accent-plus-pull of the drag grip (the block shifts a few px
 *  out, showing it is what the handle moves), or the danger tint of a hovered
 *  delete. */
type SubtreeMark = "row" | "act" | "grab" | "del" | null;

/** The row class a mark paints. Shared by the entry rows AND the add/form rows
 *  inside a container's block, so a marked area colors contiguously instead of
 *  leaving its `+ key` / `+ item` rows white holes. */
const markClass = (m: SubtreeMark): string =>
  m === "del"
    ? "yaml-row-marked-del"
    : m === "grab"
      ? "yaml-row-marked-act yaml-row-pulled"
      : m === "act"
        ? "yaml-row-marked-act"
        : m
          ? "yaml-row-marked"
          : "";

/** Width of the fixed action gutter every row reserves on its LEFT, where the
 *  entry's hover buttons (⠿ # ⧉ ↑ ↓ ×) live — a stable column in front of the
 *  tree, instead of a target that drifts right with the panel's width. Sized to
 *  the full slot set; mirrored by `.yaml-gutter` in themes.css. */
const GUTTER = 130;

/** How many per-level guide colors themes.css defines (`--yaml-guide-N`). */
const GUIDE_COLORS = 4;

/** Every row's left padding — the action gutter, then the tree indent — plus
 *  one vertical guide line per ancestor level (colors cycling by depth), so the
 *  tree's structure reads at a glance. The guides are a background IMAGE, which
 *  is what lets them coexist with the hover/marked background COLORS: those are
 *  stylesheet shorthands, and the inline image wins the image slot alone. */
const rowPad = (depth: number): CSSProperties => {
  const style: CSSProperties = { paddingLeft: `${GUTTER + depth * 14 + 4}px` };
  if (depth > 0) {
    const stops = Array.from({ length: depth }, (_, k) => {
      // Under each ancestor level's caret column.
      const x = GUTTER + 4 + k * 14 + 5;
      const c = `var(--yaml-guide-${k % GUIDE_COLORS})`;
      return `transparent ${x}px, ${c} ${x}px, ${c} ${x + 1}px, transparent ${x + 1}px`;
    }).join(", ");
    style.backgroundImage = `linear-gradient(to right, ${stops})`;
  }
  return style;
};

function YamlRows({
  nodes,
  parent,
  depth,
  text,
  doc,
  onChange,
  collapsed,
  toggle,
  adding,
  setAdding,
  cursorId,
  setCursor,
  marked = null,
}: {
  nodes: YamlNode[];
  parent: YamlNode;
  depth: number;
  text: string;
  doc: YamlDoc;
  onChange: (next: string) => void;
  collapsed: Set<string>;
  toggle: (id: string) => void;
  adding: string | null;
  setAdding: (v: string | null) => void;
  cursorId: string | null;
  setCursor: (v: string | null) => void;
  /** A hovered ancestor marks every row under it (see {@link SubtreeMark}). */
  marked?: SubtreeMark;
}) {
  const rows = useRef<(HTMLDivElement | null)[]>([]);
  // The live gesture is a ref (the pointer handlers read it without re-binding) and
  // state (the drop line has to render).
  const live = useRef<{ from: number; to: number } | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);

  // Several keys at one level pad to one column, so their values start on a
  // shared left edge (the tree is monospace, so `ch` is exact). The widest key
  // sets the column — capped, so one novella of a key can't shove every sibling's
  // value off screen. A lone key needs no column.
  const keyWidth = useMemo(() => {
    const keyed = nodes.filter((n) => n.key != null);
    if (keyed.length < 2) return null;
    return Math.min(40, Math.max(...keyed.map((n) => n.key!.length)));
  }, [nodes]);

  // Which sibling the pointer is over. A sibling's band runs from its own row down
  // to the next sibling's — so pointing anywhere inside a container's subtree lands
  // on the container, which is the only thing at this depth that the pointer could
  // mean.
  const indexAt = (y: number) => {
    let k = 0;
    for (let i = 0; i < nodes.length; i++) {
      const el = rows.current[i];
      if (el && y >= el.getBoundingClientRect().top) k = i;
    }
    return k;
  };

  const start = (i: number) => {
    live.current = { from: i, to: i };
    setDrag(live.current);
  };
  const over = (y: number) => {
    const d = live.current;
    if (!d) return;
    const to = indexAt(y);
    if (to !== d.to) {
      live.current = { from: d.from, to };
      setDrag(live.current);
    }
  };
  // A cancelled gesture writes NOTHING. `hooks/useListReorder` states the rule for
  // this exact shape — a grip drag among siblings — and the reason: "a row
  // reordered by a cancel nobody asked for is a silent edit". Only `TodoBoard`'s
  // card drag commits on `pointercancel`, and it is safe there because no column
  // under the pointer means the card stays put; here the equivalent fallback is
  // index 0, so a cancelled press-and-twitch moved an entry to the top of its
  // mapping and spliced the file.
  const abort = () => {
    live.current = null;
    setDrag(null);
  };

  const drop = () => {
    const d = live.current;
    live.current = null;
    setDrag(null);
    // Only commit onto a removable target (moveNodeTo also guards this, but
    // checking here keeps a drop onto such a slot from firing a no-op onChange).
    // A dash-line entry IS a real target: moveNodeTo hands the item's `- ` to
    // whichever entry ends up first.
    if (d && d.to !== d.from && nodes[d.to]?.deletable) {
      onChange(moveNodeTo(text, nodes, nodes[d.from], d.to));
    }
  };

  return (
    <>
      {nodes.map((node, i) => (
        <YamlRow
          key={node.id}
          node={node}
          index={i}
          siblings={nodes}
          parentKind={parent.kind}
          depth={depth}
          text={text}
          doc={doc}
          onChange={onChange}
          collapsed={collapsed}
          toggle={toggle}
          adding={adding}
          setAdding={setAdding}
          cursorId={cursorId}
          setCursor={setCursor}
          marked={marked}
          keyWidth={keyWidth}
          rowRef={(el) => {
            rows.current[i] = el;
          }}
          dragging={drag?.from === i}
          // The drop line goes on the row the node would land at, on the side it
          // would come to rest — so the gesture shows where the text will end up.
          // Only a removable row gets a line; an unremovable one is blended out
          // instead (see `blocked`).
          dropSide={
            drag && drag.to === i && drag.to !== drag.from && node.deletable
              ? drag.to < drag.from
                ? "before"
                : "after"
              : null
          }
          // While a drag is in flight, an entry that can't be a drop target is
          // dimmed to show the reorder won't land there.
          blocked={drag != null && !node.deletable}
          onDragStart={start}
          onDragOver={over}
          onDragEnd={drop}
          onDragAbort={abort}
        />
      ))}
    </>
  );
}

function YamlRow({
  node,
  index,
  siblings,
  parentKind,
  depth,
  text,
  doc,
  onChange,
  collapsed,
  toggle,
  adding,
  setAdding,
  cursorId,
  setCursor,
  marked,
  keyWidth,
  rowRef,
  dragging,
  dropSide,
  blocked,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDragAbort,
}: {
  node: YamlNode;
  index: number;
  siblings: YamlNode[];
  parentKind: string;
  depth: number;
  text: string;
  doc: YamlDoc;
  onChange: (next: string) => void;
  collapsed: Set<string>;
  toggle: (id: string) => void;
  adding: string | null;
  setAdding: (v: string | null) => void;
  cursorId: string | null;
  setCursor: (v: string | null) => void;
  marked: SubtreeMark;
  /** The sibling group's key column, in ch — null when this key stands alone. */
  keyWidth: number | null;
  rowRef: (el: HTMLDivElement | null) => void;
  dragging: boolean;
  dropSide: "before" | "after" | null;
  blocked: boolean;
  onDragStart: (index: number) => void;
  onDragOver: (clientY: number) => void;
  onDragEnd: () => void;
  /** `pointercancel` — drop the gesture WITHOUT writing. Separate from
   *  `onDragEnd` on purpose: the two terminal events mean opposite things here
   *  (see `abort` beside `drop`). */
  onDragAbort: () => void;
}) {
  const t = useT();
  const [renaming, setRenaming] = useState(false);
  const [noting, setNoting] = useState(false);
  // This row's own hover, handed down to its children: a container's row names
  // the whole block beneath it, so pointing at the row marks the block — and
  // pointing at its delete marks the block in danger, since that is what the ×
  // will take.
  const [mark, setMark] = useState<SubtreeMark>(null);
  const isContainer = node.kind !== "scalar";
  const isOpen = !collapsed.has(node.id);
  const inSeq = parentKind === "seq";

  // While the copy buffer holds an entry, a row the paste FITS after (a mapping
  // entry after a mapping entry, an item after an item — see canPasteAfter) is a
  // click target for the paste cursor; every other row stays an ordinary row.
  const clip = useClip();
  const pastable = clip != null && canPasteAfter(clip, node, parentKind);
  // Hovering a pastable row previews the landing point (see the preview row).
  const [pasteHover, setPasteHover] = useState(false);

  // What this row is called in an action's label. A list item has no key, and
  // "Delete item" would name every sibling equally — to a screen reader and to a
  // test alike — so it is named by its index.
  const label = inSeq ? t("yamlTree.itemLabel", { n: index }) : (node.key ?? "");
  // A list of plain values reads — and edits — better as the values themselves:
  // `web, prod` in one input, where typing a comma adds an item and deleting one
  // removes it. Such a list renders as this ONE line, no item rows: the line IS
  // the list. Only when every item can ride a comma line (see inlineListValues) —
  // a list of mappings, or an item carrying its own comment, stays rows.
  const inlineList = node.kind === "seq" ? inlineListValues(node) : null;
  const count = isContainer
    ? node.kind === "seq"
      ? t(node.children.length === 1 ? "yamlGrid.itemsBadgeOne" : "yamlGrid.itemsBadgeMany", { n: node.children.length })
      : t(node.children.length === 1 ? "yamlGrid.keysBadgeOne" : "yamlGrid.keysBadgeMany", { n: node.children.length })
    : null;

  const movable = node.deletable && siblings.length > 1;
  // Whether hovering this row has a substructure to mark: an open container with
  // visible child rows (an inline comma list has none — the line is the list).
  const marksSubtree = isContainer && isOpen && !inlineList && node.children.length > 0;
  // A whole-entry action (grip, copy, move, comment) hands the accent tint down
  // the substructure the same way the × hands down danger: everything tinted is
  // what the button will act on — the entry is its block, not its one line.
  const actMark = marksSubtree
    ? { onMouseEnter: () => setMark("act"), onMouseLeave: () => setMark("row") }
    : {};
  // The grip's own mark: the same accent, plus the block "pulling out" a few px —
  // the affordance that this handle is what moves it.
  const grabMark = marksSubtree
    ? { onMouseEnter: () => setMark("grab"), onMouseLeave: () => setMark("row") }
    : {};
  // What this row's block content (child rows, its add/form rows) is marked
  // with. A row being DRAGGED keeps the grab mark for the whole gesture — the
  // grip's hover mark would die the moment the pointer moves off it.
  const childMark: SubtreeMark = dragging ? "grab" : (mark ?? marked);
  const note = commentOf(node);
  // What the key says about itself on hover: its comment if it has one, since that
  // is the only place a YAML file documents a key.
  const keyTitle = note ? `# ${note}` : t("yamlTree.renameKeyTitle");

  return (
    <>
      <div
        ref={rowRef}
        className={[
          "yaml-row",
          dragging ? "yaml-row-dragging" : "",
          dropSide ? `yaml-row-drop-${dropSide}` : "",
          blocked ? "yaml-row-blocked" : "",
          pastable ? "yaml-row-pastable" : "",
          markClass(marked),
        ]
          .filter(Boolean)
          .join(" ")}
        style={rowPad(depth)}
        onMouseEnter={() => {
          if (marksSubtree) setMark("row");
          if (pastable) setPasteHover(true);
        }}
        onMouseLeave={() => {
          if (marksSubtree) setMark(null);
          setPasteHover(false);
        }}
        // Placing the paste cursor is a click on the row itself — its background
        // and gaps — never on one of its controls, which keep their own meaning
        // (rename, edit, collapse) while a copy is held.
        onClick={
          pastable
            ? (e) => {
                const clicked = e.target as HTMLElement;
                if (clicked.closest("button, input, textarea, select")) return;
                setCursor(cursorId === node.id ? null : node.id);
              }
            : undefined
        }
      >
        {/* The entry's own actions, in the fixed gutter on the row's LEFT — one
            stable column for every row, whatever its depth. Shown on the row's
            hover, like the old right-edge cluster. */}
        {/* SIX FIXED SLOTS (⠿ # ⧉ ↑ ↓ ×), an action the row doesn't offer
            rendered as an empty slot — so every button keeps its column on
            every row, and the pointer never has to chase a shifting target. */}
        <span className="yaml-actions yaml-gutter">
          {movable ? (
            <button
              className="yaml-grip"
              title={t("yamlGrid.dragToReorder")}
              aria-label={t("yamlGrid.reorderLabel", { title: label })}
              {...grabMark}
              onPointerDown={(e) => {
                // Pointer capture keeps every later event on the grip, so the gesture
                // survives the pointer leaving the row (which is the whole point of it).
                // Optional because it is the one part of this not every environment
                // implements — jsdom has no pointer capture, and the drag is still the
                // drag without it.
                e.preventDefault();
                e.currentTarget.setPointerCapture?.(e.pointerId);
                onDragStart(index);
              }}
              onPointerMove={(e) => onDragOver(e.clientY)}
              onPointerUp={(e) => {
                e.currentTarget.releasePointerCapture?.(e.pointerId);
                onDragEnd();
              }}
              onPointerCancel={onDragAbort}
            >
              ⠿
            </button>
          ) : (
            <span className="yaml-slot yaml-slot-grip" aria-hidden="true" />
          )}
          {!note && !noting && canComment(doc, node) ? (
            <button
              className="yaml-act"
              onClick={() => setNoting(true)}
              title={t("yamlTree.addCommentTitle")}
              aria-label={t("yamlTree.commentOnLabel", { label })}
              {...actMark}
            >
              #
            </button>
          ) : (
            <span className="yaml-slot" aria-hidden="true" />
          )}
          {/* Copy the entry into the paste buffer (and, as text, onto the system
              clipboard). */}
          {node.deletable ? (
            <button
              className="yaml-act"
              onClick={() => {
                const c = copyNode(text, node, label);
                if (!c) return;
                setClip(c);
                navigator.clipboard?.writeText(c.text).catch(() => {});
              }}
              title={t("yamlTree.copyEntryTitle")}
              aria-label={t("yamlTree.copyLabel", { label })}
              {...actMark}
            >
              ⧉
            </button>
          ) : (
            <span className="yaml-slot" aria-hidden="true" />
          )}
          {movable ? (
            <>
              <button
                className="yaml-act"
                disabled={index === 0}
                onClick={() => onChange(moveNode(text, siblings, node, -1))}
                title={t("yamlTree.moveUpTitle")}
                aria-label={t("yamlTree.moveUpLabel", { label })}
                {...actMark}
              >
                ↑
              </button>
              <button
                className="yaml-act"
                disabled={index === siblings.length - 1}
                onClick={() => onChange(moveNode(text, siblings, node, 1))}
                title={t("yamlTree.moveDownTitle")}
                aria-label={t("yamlTree.moveDownLabel", { label })}
                {...actMark}
              >
                ↓
              </button>
            </>
          ) : (
            <>
              <span className="yaml-slot" aria-hidden="true" />
              <span className="yaml-slot" aria-hidden="true" />
            </>
          )}
          {node.deletable ? (
            <button
              className="yaml-act yaml-act-del"
              onClick={() => onChange(deleteNode(text, node))}
              // Hovering a container's × tints its whole substructure in danger:
              // everything marked is what the click will take.
              onMouseEnter={marksSubtree ? () => setMark("del") : undefined}
              onMouseLeave={marksSubtree ? () => setMark("row") : undefined}
              title={isContainer ? t("yamlTree.deleteEntryDeepTitle") : t("yamlTree.deleteEntryTitle")}
              aria-label={t("yamlGrid.deleteLabel", { title: label })}
            >
              ×
            </button>
          ) : (
            <span className="yaml-slot" aria-hidden="true" />
          )}
        </span>

        {isContainer && node.children.length > 0 && !inlineList ? (
          <button
            className="yaml-caret"
            onClick={() => toggle(node.id)}
            aria-expanded={isOpen}
            aria-label={isOpen ? t("yamlTree.collapseLabel", { label }) : t("yamlTree.expandLabel", { label })}
          >
            {isOpen ? "▾" : "▸"}
          </button>
        ) : (
          <span className="yaml-caret yaml-caret-empty" aria-hidden="true" />
        )}

        {inSeq ? (
          <span className="yaml-index" title={note ? `# ${note}` : undefined}>
            {index}
          </span>
        ) : renaming ? (
          <TextCommit
            initial={node.key ?? ""}
            className="yaml-key-input"
            ariaLabel={t("yamlTree.renameKeyLabel", { key: node.key ?? "" })}
            onCommit={(next) => {
              setRenaming(false);
              if (next && next !== node.key) onChange(renameKey(text, doc, node, next));
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <button
            className="yaml-key"
            // +1 for the colon the button also holds; the padding is uniform
            // across siblings, so the values land on one left edge.
            style={keyWidth != null ? { minWidth: `${keyWidth + 1}ch` } : undefined}
            onClick={() => setRenaming(true)}
            title={keyTitle}
          >
            {node.key}
            <span className="yaml-colon">:</span>
          </button>
        )}

        {node.kind === "scalar" ? (
          <ValueCell
            node={node}
            label={label}
            onCommit={(next) => onChange(setValue(text, doc, node, next))}
          />
        ) : inlineList ? (
          <>
            {isFlow(node) && (
              <span className="yaml-count">
                <span className="yaml-flow-tag" title={t("yamlGrid.flowStyleTitle")}>
                  [ ]
                </span>
              </span>
            )}
            <InlineListCell
              node={node}
              values={inlineList}
              label={label}
              onCommit={(vals) => onChange(setListItems(text, doc, node, vals))}
            />
          </>
        ) : (
          <span className="yaml-count">
            {/* Flow (JSON) style is visible, because it is what the row's edits
                will keep: adding here splices into the brackets, not new lines. */}
            {isFlow(node) && (
              <span className="yaml-flow-tag" title={t("yamlGrid.flowStyleTitle")}>
                {node.kind === "seq" ? "[ ]" : "{ }"}
              </span>
            )}
            {count}
          </span>
        )}

        {/* The comment editor takes the row while it is open, since it is prose about
            the whole entry rather than one more field on it. */}
        {noting && (
          <TextCommit
            initial={note}
            className="yaml-comment-input"
            ariaLabel={t("yamlTree.commentOnLabel", { label })}
            placeholder={t("yamlTree.commentPlaceholder")}
            onCommit={(next) => {
              setNoting(false);
              if (next !== note) onChange(setComment(text, doc, node, next));
            }}
            onCancel={() => setNoting(false)}
          />
        )}

        {/* A row that HAS a comment says so without being hovered — a config file's
            comments are the half of it worth reading, and hiding them behind a hover
            would be hiding the documentation. The text itself stays on the hover. */}
        {note && !noting && canComment(doc, node) && (
          <button
            className="yaml-note"
            title={`# ${note}`}
            aria-label={t("yamlTree.commentOnLabel", { label })}
            onClick={() => setNoting(true)}
            {...actMark}
          >
            #
          </button>
        )}

        {/* An empty key (`key:`, `key: null`, `key: []`) offers both — its first
            child is what decides whether it becomes a mapping or a list. A LIST
            offers both too: "+ key" on it adds an item that IS a mapping.
            An OPEN container shows its add affordance as the persistent row at
            the end of its children instead, so the inline hover buttons here are
            only for a collapsed container (whose children aren't shown) or an
            empty placeholder (which has no child rows to host the add row).
            They stay IN the row, next to what they grow — the gutter is for
            actions on the entry itself. */}
        {!(isContainer && isOpen) &&
          !inlineList &&
          (canAddChild(node, "key") || canAddChild(node, "item")) && (
            <span className="yaml-actions yaml-actions-row">
              <AddControls node={node} adding={adding} setAdding={setAdding} inline />
            </span>
          )}
        {!node.editable && (
          <span
            className="yaml-locked"
            title={t("yamlTree.sourceOnlyLockedTitle")}
          >
            {t("yamlTree.sourceOnlyBadge")}
          </span>
        )}
      </div>

      {isContainer && isOpen && !inlineList && (
        <YamlRows
          nodes={node.children}
          parent={node}
          depth={depth + 1}
          text={text}
          doc={doc}
          onChange={onChange}
          collapsed={collapsed}
          toggle={toggle}
          adding={adding}
          setAdding={setAdding}
          cursorId={cursorId}
          setCursor={setCursor}
          // This row's own hover outranks an ancestor's: the innermost pointed-at
          // container is the one whose block the pointer means.
          marked={childMark}
        />
      )}

      {/* The add form opens as the last child of the row it belongs to; when it
          isn't open, an OPEN container shows a persistent add row in its place, so
          every list / mapping carries a visible "+ item" / "+ key" at the point a
          new entry lands — not only the hover buttons on its (often far-off)
          header row. A collapsed container keeps just the header's hover buttons
          (the form still opens from them, below the hidden children). */}
      {adding?.startsWith(`${node.id}:`) ? (
        <AddRow
          depth={depth + 1}
          kind={adding.endsWith(":item") ? "item" : "key"}
          marked={childMark}
          onCancel={() => setAdding(null)}
          onAdd={(kind, key, type, value) => {
            onChange(
              addChild(
                text,
                doc,
                node,
                kind,
                key,
                literalFor(type, value, doc.strict, node.inFlow || isFlow(node)),
              ),
            );
            setAdding(null);
          }}
          onCopyLast={copyLastAction(node, text, onChange, () => setAdding(null))}
        />
      ) : (
        isContainer &&
        isOpen &&
        !inlineList && (
          <AddControls
            node={node}
            depth={depth + 1}
            adding={adding}
            setAdding={setAdding}
            // The add row is part of this block: it carries the block's mark, so
            // a marked area colors contiguously instead of leaving it a white gap.
            marked={childMark}
          />
        )
      )}

      {/* While a copy is held, HOVERING a row it can follow previews the landing
          point: the same accent line the placed cursor row draws, right after
          this entry's whole block — so the click's outcome is visible before
          the click. Zero-height, so nothing below it shifts. */}
      {pastable && pasteHover && cursorId !== node.id && clip && (
        <div className="yaml-row yaml-paste-preview" style={rowPad(depth)} aria-hidden="true">
          <span className="yaml-paste-preview-line" />
        </div>
      )}

      {/* The paste cursor: a horizontal line at the very point the copied entry
          would land — right AFTER this entry's whole block, as its next sibling
          (the same spot duplicateNode inserts at) — with the button that lands
          it. The buffer survives the paste, so one copy can be put down more
          than once. */}
      {pastable && cursorId === node.id && clip && (
        <div className="yaml-row yaml-cursor-row" style={rowPad(depth)}>
          <span className="yaml-caret yaml-caret-empty" aria-hidden="true" />
          <button
            className="yaml-add yaml-paste-here"
            onClick={() => {
              onChange(pasteAfter(text, node, clip));
              setCursor(null);
            }}
          >
            {t("yamlTree.pasteHereButton", { label: clip.label })}
          </button>
          <button
            className="yaml-act"
            onClick={() => setCursor(null)}
            title={t("yamlTree.removeCursorTitle")}
            aria-label={t("yamlTree.removeCursorTitle")}
          >
            ×
          </button>
        </div>
      )}
    </>
  );
}

/** The `+ key` / `+ item` buttons a node offers, given what it can actually take.
 *  `inline` renders them into a row's hover actions; otherwise it is a standalone,
 *  always-visible add row indented to `depth` (the children's level). */
function AddControls({
  node,
  adding,
  setAdding,
  inline,
  depth = 0,
  marked = null,
}: {
  node: YamlNode;
  adding: string | null;
  setAdding: (v: string | null) => void;
  inline?: boolean;
  depth?: number;
  /** The surrounding block's mark — the add row is part of the block. */
  marked?: SubtreeMark;
}) {
  const t = useT();
  const open = adding?.startsWith(`${node.id}:`);
  return (
    <span
      className={
        inline
          ? "yaml-add-inline"
          : ["yaml-row", "yaml-row-add", markClass(marked)].filter(Boolean).join(" ")
      }
      style={inline ? undefined : rowPad(depth)}
    >
      {/* Stand in for the grip + caret columns every entry row leads with, so the
          add buttons line up under the existing keys/items, not 32px to their
          left. Inline (hover-action) controls need no alignment. */}
      {!inline && (
        <>
          <span className="yaml-caret yaml-caret-empty" aria-hidden="true" />
        </>
      )}
      {canAddChild(node, "key") && (
        <button
          className="yaml-add"
          onClick={() => setAdding(open ? null : `${node.id}:key`)}
          // On a list a key is not a key but an item that is a mapping — the shape a
          // list of mappings is actually grown by (`- name: api`).
          title={
            node.kind === "seq"
              ? t("yamlTree.addMappingItemTitle")
              : t("yamlTree.addKeyUnderTitle")
          }
        >
          {t("yamlTree.addKeyButton")}
        </button>
      )}
      {canAddChild(node, "item") && (
        <button
          className="yaml-add"
          onClick={() => setAdding(open ? null : `${node.id}:item`)}
          title={t("yamlTree.addItemToListTitle")}
        >
          {t("yamlTree.addItemButton")}
        </button>
      )}
    </span>
  );
}

/** The tone a comma-line token would carry as its own row. An existing item is
 *  toned by its NODE (so a quoted "8080" stays a string, exactly as its row
 *  would show it); a token the file doesn't hold yet — mid-edit — is toned by
 *  its text, which is what it will parse as when committed plain. */
type ValTone = "string" | "number" | "boolean" | "null";

function tokenTone(t: string, known: Map<string, ValTone>): ValTone {
  const k = known.get(t);
  if (k) return k;
  if (t === "" || t === "null" || t === "~") return "null";
  if (/^-?(\d+|\d*\.\d+)([eE][+-]?\d+)?$/.test(t) || /^0[xob][0-9a-fA-F_]+$/.test(t)) {
    return "number";
  }
  if (/^(true|false|yes|no|on|off)$/i.test(t)) return "boolean";
  return "string";
}

/**
 * The comma-line editor for a scalar-only list, with overflow chevrons: when the
 * joined values outgrow the field, ‹ › appear beside it and HOVERING one glides
 * the content that way — the whole list is reachable without grabbing the caret
 * or a scrollbar an input doesn't have. The glide stops on leave, and at the
 * edge (whose chevron then reads disabled).
 *
 * The entries keep the value colors their own rows would give them. An input
 * cannot color parts of itself, so the input's text is transparent (caret kept)
 * and a pointer-blind MIRROR on top renders the same buffer token by token,
 * scroll-synced — the classic highlighted-input overlay.
 */
function InlineListCell({
  node,
  values,
  label,
  onCommit,
}: {
  node: YamlNode;
  values: string[];
  label: string;
  onCommit: (vals: string[]) => void;
}) {
  const t = useT();
  const ref = useRef<HTMLInputElement | null>(null);
  const mirrorRef = useRef<HTMLSpanElement | null>(null);
  const raf = useRef<number | null>(null);
  const [can, setCan] = useState({ left: false, right: false });

  // The draft buffer, exactly TextCommit's contract: commit on Enter/blur,
  // revert on Escape — owned here because the mirror has to color it live.
  const initial = values.join(", ");
  const [buf, setBuf] = useState(initial);
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) setBuf(initial);
  }, [initial]);
  const commit = () => {
    dirty.current = false;
    if (buf !== initial) {
      onCommit(buf.split(",").map((v) => v.trim()).filter((v) => v !== ""));
    }
  };

  // Each existing item's tone, by its node — the same call its row would make.
  const known = useMemo(() => {
    const m = new Map<string, ValTone>();
    for (const c of node.children) if (!m.has(c.value)) m.set(c.value, scalarType(c));
    return m;
  }, [node]);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // The mirror rides the input's scroll, or the colors would drift off the text.
    if (mirrorRef.current) mirrorRef.current.scrollLeft = el.scrollLeft;
    const max = el.scrollWidth - el.clientWidth;
    const next = { left: el.scrollLeft > 0, right: el.scrollLeft < max - 1 };
    setCan((cur) => (cur.left === next.left && cur.right === next.right ? cur : next));
  }, []);

  // Re-measure on everything that can move the overflow: typing (the buffer),
  // a re-parse changing the values, scrolling, and the pane resizing.
  useEffect(measure, [buf, measure]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.addEventListener("scroll", measure);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro?.disconnect();
    };
  }, [measure]);

  const stop = useCallback(() => {
    if (raf.current != null) cancelAnimationFrame(raf.current);
    raf.current = null;
  }, []);
  useEffect(() => stop, [stop]);

  const glide = (dir: -1 | 1) => {
    stop();
    const step = () => {
      const el = ref.current;
      if (!el) return;
      const before = el.scrollLeft;
      el.scrollLeft = before + dir * 4;
      measure();
      // The edge: a disabled chevron swallows the mouseleave that would end the
      // glide, so the glide ends itself when the scroll stops moving.
      if (el.scrollLeft === before) return;
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  };

  // The buffer, cut into pieces the mirror renders 1:1 — values keep their own
  // spacing (the mirror must match the input to the character), commas stay
  // muted like the tree's other punctuation.
  const pieces = buf.match(/[^,]+|,/g) ?? [];

  const shown = can.left || can.right;
  return (
    <span className="yaml-list-wrap">
      {shown && (
        <button
          className="yaml-list-chevron"
          disabled={!can.left}
          onMouseEnter={() => glide(-1)}
          onMouseLeave={stop}
          tabIndex={-1}
          aria-label={t("yamlTree.scrollLeftLabel", { label })}
        >
          ‹
        </button>
      )}
      <span className="yaml-list-field">
        <input
          ref={ref}
          className="yaml-value-input yaml-list-input"
          value={buf}
          aria-label={t("yamlGrid.valueOfLabel", { label })}
          onChange={(e) => {
            dirty.current = true;
            setBuf(e.target.value);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              dirty.current = false;
              setBuf(initial);
            }
          }}
        />
        <span className="yaml-list-mirror" aria-hidden="true" ref={mirrorRef}>
          {pieces.map((p, i) =>
            p === "," ? (
              <span key={i} className="yaml-colon">
                ,
              </span>
            ) : (
              <span key={i} className={`yaml-val-${tokenTone(p.trim(), known)}`}>
                {p}
              </span>
            ),
          )}
        </span>
      </span>
      {shown && (
        <button
          className="yaml-list-chevron"
          disabled={!can.right}
          onMouseEnter={() => glide(1)}
          onMouseLeave={stop}
          tabIndex={-1}
          aria-label={t("yamlTree.scrollRightLabel", { label })}
        >
          ›
        </button>
      )}
    </span>
  );
}

/** The "copy the last item" action for a container, or undefined when there's
 *  nothing to copy (not a list, empty, or the last entry owns a shared dash line
 *  and so can't be duplicated on its own). */
function copyLastAction(
  container: YamlNode,
  text: string,
  onChange: (next: string) => void,
  done: () => void,
): (() => void) | undefined {
  if (container.kind !== "seq") return undefined;
  const last = container.children[container.children.length - 1];
  if (!last || !last.deletable) return undefined;
  return () => {
    onChange(duplicateNode(text, last));
    done();
  };
}

/** The inline form a new entry is composed in: key (mappings only), type, value.
 *  When adding an item to a non-empty list, `onCopyLast` offers the alternative of
 *  duplicating the last entry (handy for a list of like-shaped mappings). */
function AddRow({
  depth,
  kind,
  onAdd,
  onCancel,
  onCopyLast,
  marked = null,
}: {
  depth: number;
  kind: "key" | "item";
  onAdd: (kind: "key" | "item", key: string, type: YamlValueType, value: string) => void;
  onCancel: () => void;
  onCopyLast?: () => void;
  /** The surrounding block's mark — the form row is part of the block. */
  marked?: SubtreeMark;
}) {
  const t = useT();
  const [key, setKey] = useState("");
  const [type, setType] = useState<YamlValueType>("text");
  const [value, setValue] = useState("");
  const first = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    first.current?.focus();
  }, []);

  // A container's value is its children, and null has no value to type.
  const valueless = type === "map" || type === "seq" || type === "null";
  const canAdd = kind === "item" || key.trim() !== "";
  const submit = () => {
    if (canAdd) onAdd(kind, key.trim(), type, value);
  };

  return (
    <div
      className={["yaml-row", "yaml-row-form", markClass(marked)].filter(Boolean).join(" ")}
      style={rowPad(depth)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <span className="yaml-caret yaml-caret-empty" aria-hidden="true" />
      {/* Adding to a non-empty list: offer copying the last entry as the other
          way to add one — for a list of like-shaped items (e.g. per-head configs)
          it's far quicker to duplicate and tweak than to rebuild from scratch. */}
      {kind === "item" && onCopyLast && (
        <button
          className="yaml-add yaml-add-copy"
          onClick={onCopyLast}
          title={t("yamlGrid.copyLastTitle")}
        >
          {t("yamlGrid.copyLastButton")}
        </button>
      )}
      {kind === "key" ? (
        <input
          ref={first}
          className="yaml-key-input"
          value={key}
          placeholder={t("yamlTree.newKeyPlaceholder")}
          aria-label={t("yamlTree.newKeyLabel")}
          onChange={(e) => setKey(e.target.value)}
        />
      ) : (
        <span className="yaml-index">–</span>
      )}
      <select
        className="yaml-type"
        value={type}
        aria-label={t("yamlTree.valueTypeLabel")}
        onChange={(e) => setType(e.target.value as YamlValueType)}
      >
        <option value="text">{t("yamlTree.typeText")}</option>
        <option value="number">{t("yamlTree.typeNumber")}</option>
        <option value="boolean">{t("yamlTree.typeBoolean")}</option>
        <option value="null">{t("yamlTree.typeNull")}</option>
        <option value="map">{t("yamlTree.typeMap")}</option>
        <option value="seq">{t("yamlTree.typeList")}</option>
      </select>
      {type === "boolean" ? (
        <select
          className="yaml-type"
          value={value || "true"}
          aria-label={t("yamlTree.newValueLabel")}
          onChange={(e) => setValue(e.target.value)}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : (
        !valueless && (
          <input
            ref={kind === "item" ? first : undefined}
            className="yaml-value-input"
            value={value}
            placeholder={t("yamlTree.newValuePlaceholder")}
            aria-label={t("yamlTree.newValueLabel")}
            onChange={(e) => setValue(e.target.value)}
          />
        )
      )}
      <button className="yaml-add" onClick={submit} disabled={!canAdd}>
        {t("common.add")}
      </button>
      <button className="yaml-act" onClick={onCancel} aria-label={t("common.cancel")}>
        ×
      </button>
    </div>
  );
}

/** A scalar's value: an input (a textarea for a block scalar) that commits on
 *  Enter/blur, or plain text when the node is one the tree won't rewrite. */
function ValueCell({
  node,
  label,
  onCommit,
}: {
  node: YamlNode;
  label: string;
  onCommit: (next: string) => void;
}) {
  const t = useT();
  if (!node.editable) {
    return (
      <span className="yaml-value yaml-value-locked" title={node.raw}>
        {node.raw || node.value}
      </span>
    );
  }
  if (node.style === "block") {
    return (
      <BlockCell
        key={node.id}
        initial={node.value}
        tag={node.raw}
        ariaLabel={t("yamlGrid.valueOfLabel", { label })}
        onCommit={onCommit}
      />
    );
  }
  return (
    <TextCommit
      initial={node.value}
      className={`yaml-value-input yaml-val-${scalarType(node)}`}
      ariaLabel={t("yamlGrid.valueOfLabel", { label })}
      placeholder={node.style === "empty" ? t("yamlGrid.nullPlaceholder") : undefined}
      onCommit={onCommit}
    />
  );
}

/** A multi-line block scalar (`|`/`>`): committed on blur or Ctrl+Enter, since
 *  plain Enter has to keep inserting newlines. */
function BlockCell({
  initial,
  tag,
  ariaLabel,
  onCommit,
}: {
  initial: string;
  /** The block header as written (`|`, `>-`, …), shown so the style is visible. */
  tag: string;
  ariaLabel: string;
  onCommit: (next: string) => void;
}) {
  const [buf, setBuf] = useState(initial);
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) setBuf(initial);
  }, [initial]);

  return (
    <span className="yaml-block">
      <span className="yaml-block-tag">{tag}</span>
      <textarea
        className="yaml-block-input"
        value={buf}
        rows={Math.min(12, Math.max(2, buf.split("\n").length))}
        aria-label={ariaLabel}
        onChange={(e) => {
          dirty.current = true;
          setBuf(e.target.value);
        }}
        onBlur={() => {
          dirty.current = false;
          if (buf !== initial) onCommit(buf);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            dirty.current = false;
            setBuf(initial);
          }
        }}
      />
    </span>
  );
}

/**
 * A single-line input that commits on Enter/blur and reverts on Escape. It holds
 * its own buffer rather than driving `onChange` per keystroke: every commit
 * re-encodes the value into the file (quoting it when it must), and doing that on
 * each keypress would rewrite the text — and move the caret — under the typist.
 */
function TextCommit({
  initial,
  className,
  ariaLabel,
  placeholder,
  onCommit,
  onCancel,
}: {
  initial: string;
  className: string;
  ariaLabel: string;
  placeholder?: string;
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
      autoFocus={!!onCancel}
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
