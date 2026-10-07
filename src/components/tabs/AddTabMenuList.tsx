import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { UntestedTag } from "../common/UntestedTag";
import { MenuShortcut } from "../common/MenuShortcut";
import type { ChordDescriptor, ShortcutAction } from "../../lib/shortcuts/shortcuts";
import { isUntested, type UntestedId } from "../../lib/untested";
import { useT } from "../../lib/i18n";
import { WarningIcon } from "../common/icons/Icon";

/** One pickable row in the add-tab menu. */
export interface AddMenuEntry {
  /** React key — unique within the entry's group. */
  key: string;
  label: string;
  /** Dot glyph in front of the label (defaults to "●"). A shared line icon
   *  where the glyph would be an emoji-capable symbol (☁ ⚠): a font fallback
   *  hands those to the colour-emoji font, which ignores `color`. */
  dot?: ReactNode;
  /** Dot color (a TAB_ACCENT value or any CSS color). */
  color: string;
  disabled?: boolean;
  /** The pill's id in the untested register (`lib/untested`): renders the
   *  shared `<UntestedTag />` after the label (and gives the button the
   *  `untested` class, so label and tag lay out in a row). A menu entry cannot
   *  carry a ReactNode label — the search box filters on `label` as a string — so
   *  the tag is an id here rather than markup at the call site. */
  untested?: UntestedId;
  /** A sentence about a risk in picking this entry, shown as a `⚠` after the
   *  label with the sentence as its tooltip. A caution, never a block: the row
   *  stays pickable, which is the difference between this and `disabled`. Like
   *  `untested` it is a flag rather than markup, for that field's reason — the
   *  search box filters on `label` as a string, so a label cannot be a node. */
  caution?: string;
  /** The row's keyboard twin, shown muted at the row's end (`MenuShortcut`). */
  shortcut?: ShortcutAction | ChordDescriptor;
  /** A fly-out list opened by this row rather than an immediate tab choice. */
  moreEntries?: AddMenuEntry[];
  /** The fly-out's heading (defaults to the row's label). */
  moreTitle?: string;
  onPick: () => void;
}

/** One labelled section of the add-tab menu. */
export interface AddMenuGroup {
  label: string;
  entries: AddMenuEntry[];
  /** Entries shown while the search box is empty. A query always searches the
   *  full `entries` list, which lets a dense section keep only its quick picks
   *  in the compact menu without making the rest unreachable. */
  compactEntries?: AddMenuEntry[];
  /** Label for an idle-only disclosure row that opens the unlisted entries in a
   *  neighbouring fly-out, leaving this compact menu unchanged. */
  moreLabel?: string;
  /** Non-pickable explainer rendered when the group has no entries (only while
   *  the search box is empty — a hint is not a search result). */
  hint?: string;
}

/**
 * The searchable body of the "+" add-tab menu, shared by the main-window
 * `TabBar` and the detached popout's `NewTabMenu` so both filter identically.
 * The search box is auto-focused, so "click + and type" filters immediately;
 * a query narrows entries by label (a group-label match keeps its whole
 * group, so "files" surfaces both file panes), and Escape clears the query
 * before it closes the menu.
 *
 * ↑/↓ walk the results and Enter picks the highlighted one. There is exactly
 * ONE cursor, and the pointer moves it too: the keyboard highlight and the
 * hover highlight are the same row, so arrowing after a hover continues from
 * where the pointer left off instead of from a second, invisible position.
 * That is also why the pointer half is bound to `pointermove` and not
 * `pointerenter` — a keyboard move that scrolls a row under a *stationary*
 * pointer fires enter events, which would drag the cursor back and make ↓
 * appear to stick.
 */
export function AddTabMenuList({ groups }: { groups: AddMenuGroup[] }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [moreMenu, setMoreMenu] = useState<{
    label: string;
    entries: AddMenuEntry[];
    anchor: DOMRect;
  } | null>(null);
  const [morePos, setMorePos] = useState<{ left: number; top: number } | null>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const moreTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const q = query.trim().toLowerCase();

  // Fly-out triggers are keyed `<group>/<row key>`: a group can hold more than
  // one (Agents has "More agents…" and "Cloud session").
  const openMoreMenu = (label: string, entries: AddMenuEntry[], anchor?: HTMLButtonElement | null) => {
    if (!anchor) return;
    setMorePos(null);
    setMoreMenu({ label, entries, anchor: anchor.getBoundingClientRect() });
  };

  const visible = q
    ? groups
        .map((g) => ({
          label: g.label,
          hint: undefined,
          entries: g.label.toLowerCase().includes(q)
            ? g.entries
            : g.entries.filter((e) => e.label.toLowerCase().includes(q)),
        }))
        .filter((g) => g.entries.length > 0)
    : groups.map((g) => {
        const compact = g.compactEntries ?? g.entries;
        const compactKeys = new Set(compact.map((entry) => entry.key));
        // The management row remains in the parent menu. The fly-out is only
        // the agents that compact mode deliberately did not list.
        const moreEntries = g.entries.filter(
          (entry) => !compactKeys.has(entry.key) && entry.key !== "__add_custom_agent__",
        );
        const hasMore = !!g.moreLabel && moreEntries.length > 0;
        return {
          ...g,
          entries: hasMore
            ? [
                ...compact,
                {
                  key: "__more__",
                  label: g.moreLabel!,
                  dot: "…",
                  color: "var(--text-muted)",
                  moreTitle: g.label,
                  moreEntries,
                  onPick: () => openMoreMenu(g.label, moreEntries, moreTriggerRefs.current.get(`${g.label}/__more__`)),
                },
              ]
            : compact,
        };
      });

  // A typed search is a new route to all entries; a stale adjacent menu would
  // only obscure its results, so it closes as soon as the query changes.
  useEffect(() => setMoreMenu(null), [q]);

  // Place the fly-out against its More row, flipping to the left when the
  // compact parent sits against the right edge of the viewport.
  useLayoutEffect(() => {
    if (!moreMenu || !moreMenuRef.current) return;
    const rect = moreMenuRef.current.getBoundingClientRect();
    const margin = 8;
    let left = moreMenu.anchor.right + 4;
    if (left + rect.width > window.innerWidth - margin) {
      left = Math.max(margin, moreMenu.anchor.left - 4 - rect.width);
    }
    const top = Math.max(margin, Math.min(moreMenu.anchor.top, window.innerHeight - margin - rect.height));
    setMorePos({ left, top });
    moreMenuRef.current.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [moreMenu]);

  // The pickable rows in render order — what ↑/↓ walk. Disabled entries are
  // skipped rather than stepped over, so the cursor never lands somewhere
  // Enter would do nothing from.
  const pickable = useMemo(
    () => visible.flatMap((g) => g.entries).filter((e) => !e.disabled),
    [visible],
  );

  // The cursor position, plus whether the user has moved it themselves. With a
  // live query row 0 is highlighted from the start (Enter picks the best match,
  // as it always did); with an empty query nothing is highlighted until an
  // arrow key or the pointer says so, so opening the menu doesn't preselect.
  const [cursor, setCursor] = useState(0);
  const [moved, setMoved] = useState(false);
  useEffect(() => {
    setCursor(0);
    setMoved(false);
  }, [q]);

  // Clamp rather than store-and-fix: the entry list shrinks under us when a
  // probe resolves (installed agents, local drivers), and a stale index would
  // otherwise point past the end for a frame.
  const idx = pickable.length ? Math.min(cursor, pickable.length - 1) : -1;
  const active = (q || moved) && idx >= 0 ? pickable[idx] : undefined;

  // Keep the highlighted row on screen while arrowing through a long list.
  const activeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (active) activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const step = (delta: number) => {
    if (!pickable.length) return;
    const live = Boolean(q) || moved; // is a row highlighted right now?
    setCursor((c) =>
      live
        // Wrap at both ends: this menu is short enough that the last entry is
        // quicker to reach with one ↑ than with a dozen ↓.
        ? (Math.min(c, pickable.length - 1) + delta + pickable.length) % pickable.length
        // Nothing highlighted yet: ↓ enters at the top, ↑ at the bottom.
        : delta > 0 ? 0 : pickable.length - 1,
    );
    setMoved(true);
  };

  return (
    <>
      <input
        className="tab-new-menu-search"
        type="text"
        placeholder={t("newTabMenu.searchPlaceholder")}
        value={query}
        autoFocus
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            step(1);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            step(-1);
          } else if (e.key === "Home" && (q || moved)) {
            e.preventDefault();
            setMoved(true);
            setCursor(0);
          } else if (e.key === "End" && (q || moved)) {
            e.preventDefault();
            setMoved(true);
            setCursor(Math.max(0, pickable.length - 1));
          } else if (e.key === "Enter" && active) {
            e.preventDefault();
            if (active.moreEntries) {
              const group = visible.find((g) => g.entries.includes(active));
              openMoreMenu(
                active.moreTitle ?? active.label,
                active.moreEntries,
                group && moreTriggerRefs.current.get(`${group.label}/${active.key}`),
              );
            } else active.onPick();
          } else if (e.key === "Escape" && query) {
            // First Escape clears the query; only an empty-query Escape is
            // allowed to bubble on to the menu's document-level close handler.
            e.stopPropagation();
            setQuery("");
          }
        }}
      />
      {/* The search box stays pinned; only the entries scroll once the list
          outgrows the window (unified `.menu-scroll-region` shape). */}
      <div className="menu-scroll-region">
      {visible.length === 0 && <div className="tab-new-menu-hint">{t("newTabMenu.noMatches")}</div>}
      {visible.map((g) => (
        <Fragment key={g.label}>
          <div className="tab-new-menu-group-label">{g.label}</div>
          {g.entries.map((e) => (
            <button
              key={e.key}
              ref={(node) => {
                if (e === active) activeRef.current = node;
                if (e.moreEntries && node) moreTriggerRefs.current.set(`${g.label}/${e.key}`, node);
              }}
              className={`tab-new-menu-item${e === active ? " enter-target" : ""}${
                isUntested(e.untested) ? " untested" : ""
              }`}
              disabled={e.disabled}
              onClick={(event) =>
                e.moreEntries
                  ? openMoreMenu(e.moreTitle ?? e.label, e.moreEntries, event.currentTarget)
                  : e.onPick()
              }
              // The pointer owns the same cursor the keys do. Guarded on an
              // actual change so a mouse resting on a row doesn't re-render
              // the menu on every move event.
              onPointerMove={() => {
                if (e.disabled || e === active) return;
                const at = pickable.indexOf(e);
                if (at < 0) return;
                setMoved(true);
                setCursor(at);
              }}
            >
              <span className="tab-new-menu-dot" style={{ color: e.color }}>
                {e.dot ?? "●"}
              </span>
              {e.label}
              {e.caution && (
                <span className="tab-new-menu-caution" title={e.caution} aria-label={e.caution}>
                  <WarningIcon />
                </span>
              )}
              {e.untested && <UntestedTag id={e.untested} />}
              {e.shortcut && <MenuShortcut chord={e.shortcut} />}
            </button>
          ))}
          {g.entries.length === 0 && g.hint && (
            <div className="tab-new-menu-hint">{g.hint}</div>
          )}
        </Fragment>
      ))}
      </div>
      {moreMenu && (
        <div
          ref={moreMenuRef}
          className="tab-new-menu tab-new-menu-more"
          style={{
            position: "fixed",
            left: morePos?.left ?? -10000,
            top: morePos?.top ?? -10000,
          }}
        >
          <div className="tab-new-menu-group-label">{moreMenu.label}</div>
          <div className="menu-scroll-region">
            {moreMenu.entries.map((e) => (
              <button
                key={e.key}
                className={`tab-new-menu-item${isUntested(e.untested) ? " untested" : ""}`}
                disabled={e.disabled}
                onClick={e.onPick}
              >
                <span className="tab-new-menu-dot" style={{ color: e.color }}>
                  {e.dot ?? "●"}
                </span>
                {e.label}
                {e.caution && (
                  <span className="tab-new-menu-caution" title={e.caution} aria-label={e.caution}>
                    <WarningIcon />
                  </span>
                )}
                {e.untested && <UntestedTag id={e.untested} />}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
