import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { ProjectBox } from "../../types";
import { BOX_SCOPE_PREFIX, useBoxesStore } from "../../stores/boxes";
import { ROOT_SCOPE } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import { useBoxEditorStore } from "../../stores/boxEditor";
import { usePillDragStore } from "../../stores/drag/pillDrag";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { boxColor } from "../../lib/theme/boxColor";
import { useT } from "../../lib/i18n";
import { startWindowDrag } from "../../lib/window/startWindowDrag";
import { StarIcon } from "../layout/StarIcon";
import { LogoIcon } from "../layout/LogoIcon";
import { ScopeSetStatusBars } from "./PillStatusBars";
import { MenuShortcut } from "../common/MenuShortcut";
import { UntestedTag } from "../common/UntestedTag";
import { BoxColorPicker } from "./BoxColorPicker";
import { BoxSwatch, CheckboxIcon, SquareIcon } from "../common/icons/Icon";

/** This chip's entry in the shared header hover-menu id (stores/headerHoverMenu). */
const SCOPE_MENU_ID = "box-scope-chip";

/**
 * How many boxes stand on the row as pills of their own. Boxes are few by
 * nature (a handful of joinings, not a project list), so nearly every user
 * sees all of theirs; past this the rest stay one hover away in the chip's
 * dropdown, and the chip says how many it is holding.
 */
export const MAX_BOX_PILLS = 6;

/** How far (px) a press on the logo travels before it becomes a window move
 *  rather than a click ("All projects"). */
const LOGO_DRAG_SLOP = 4;

/** Member rows a box pill's context menu lists before deferring to the editor. */
const MAX_MENU_MEMBER_ROWS = 12;

interface Props {
  boxes: ProjectBox[];
  /** The box whose slice the pill strip is showing (`null` = every project). */
  selectedId: string | null;
  /** Pick a box (also opens its scope) or `null` to go back to all projects. */
  onSelect: (boxId: string | null) => void;
  onRename: (boxId: string, name: string) => void;
  onDelete: (boxId: string) => void;
  /** The selected box's scope is the current one — the `active` treatment on
   *  the box's own pill, driven off `scope` exactly as every project pill
   *  beside it is. */
  active?: boolean;
  /** The root terminal's scope is the current one. */
  rootActive?: boolean;
  onSelectRoot: () => void;
  /** Keyboard-steering station digits, while steering mode is active. */
  rootStation?: number;
}

/**
 * The scope chip and the box pills: the row's fixed leading segment, left of
 * the scrolling project strip.
 *
 * The chip is ONE control standing for the built-in root scope plus the full
 * boxes list, "All projects", and the doors into the box editor. It names Root
 * when that is the current scope, and otherwise just shows the box mark.
 *
 * Right of it, **every box stands as a pill of its own** (2026-09-22). The
 * previous model put only the *selected* box there and kept the rest in the
 * dropdown, which made switching between boxes a hover, a wait and a click
 * each way and left the other boxes invisible until the menu was open. Boxes
 * are few, so a pill each costs the strip little: one click enters a box, the
 * pill is a standing drop target for "add this project to that box", and its
 * colour is the colour its members wear as a swatch on their own pills — the
 * same box reads the same everywhere. Past `MAX_BOX_PILLS` the rest stay in
 * the dropdown and the chip counts them.
 *
 * The slice is a *view*, not the scope: clicking a member switches to that
 * project (the box pill keeps `is-selected` but drops `active`) while the
 * strip stays put, so hopping between a box's projects never reshuffles the
 * row under the pointer. "All projects" is always in the menu, so a slice can
 * never trap anyone away from a project it doesn't list.
 */
export function BoxScopeChip({
  boxes,
  selectedId,
  onSelect,
  onRename,
  onDelete,
  active,
  rootActive,
  onSelectRoot,
  rootStation,
}: Props) {
  const t = useT();
  // Hover-opened through the SHARED header menu id, like the + menu and the
  // cluster menus beside it: one id means opening another header menu closes
  // this one in the same frame instead of both riding out their own 250 ms
  // closing grace. A click on the chip itself is "All projects" (the menu's
  // own row), so hover and focus are what reveal the list.
  const menuOpen = useHeaderHoverMenuStore((s) => s.openId === SCOPE_MENU_ID);
  const openMenu = useHeaderHoverMenuStore((s) => s.open);
  const closeMenu = useHeaderHoverMenuStore((s) => s.close);
  const closeTimer = useRef<number | undefined>(undefined);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; boxId: string } | null>(
    null,
  );
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const chipRef = useRef<HTMLDivElement>(null);
  const pillsRef = useRef<HTMLDivElement>(null);
  const sprung = useRef(false);

  const reveal = () => {
    window.clearTimeout(closeTimer.current);
    openMenu(SCOPE_MENU_ID);
  };
  const scheduleClose = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => closeMenu(SCOPE_MENU_ID), 250);
  };
  const dismiss = () => {
    window.clearTimeout(closeTimer.current);
    closeMenu(SCOPE_MENU_ID);
  };
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  // The logo is the window's move handle. The move starts only once the press
  // has travelled LOGO_DRAG_SLOP px, so a press that stays put is still the
  // click that means "All projects". Once the OS move loop owns the pointer
  // the webview may never see the release, so the listeners go at hand-off;
  // `logoDragged` swallows the click that may still follow a move.
  const logoDragged = useRef(false);
  const logoPressCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => logoPressCleanup.current?.(), []);
  const onLogoMouseDown = (e: React.MouseEvent) => {
    // `button` (0 = left), not `buttons` — see HeaderBar's handleDrag.
    if (e.button !== 0) return;
    logoDragged.current = false;
    logoPressCleanup.current?.();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const onMove = (ev: MouseEvent) => {
      if (Math.abs(ev.clientX - x0) < LOGO_DRAG_SLOP && Math.abs(ev.clientY - y0) < LOGO_DRAG_SLOP)
        return;
      cleanup();
      logoDragged.current = true;
      dismiss();
      startWindowDrag();
    };
    const cleanup = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", cleanup);
      logoPressCleanup.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", cleanup);
    logoPressCleanup.current = cleanup;
  };

  // The boxes in row order, and the ones that get a pill: the first
  // MAX_BOX_PILLS by position that the user has not hidden from the row (the
  // dropdown's per-row checkbox) — always including the selected box, which
  // takes the last slot when it would otherwise be off the row, so the box
  // being looked at is never the one without a pill.
  const ordered = useMemo(() => [...boxes].sort((a, b) => a.position - b.position), [boxes]);
  const shown = useMemo(() => {
    const head = ordered.filter((b) => !b.hide_pill).slice(0, MAX_BOX_PILLS);
    if (!selectedId || head.some((b) => b.id === selectedId)) return head;
    const selected = ordered.find((b) => b.id === selectedId);
    if (!selected) return head;
    // A hidden box being looked at joins the row in its own place, not last.
    const withSelected = head.length < MAX_BOX_PILLS ? head : head.slice(0, MAX_BOX_PILLS - 1);
    return ordered.filter((b) => b === selected || withSelected.includes(b));
  }, [ordered, selectedId]);
  const overflow = ordered.length - shown.length;

  // What the chip NAMES right now — only the built-in root scope; every box
  // has a pill of its own beside the chip.
  const naming: "root" | null = rootActive ? "root" : null;

  // Spring-loaded during a pill drag, but only while some boxes have NO pill
  // on the row: with every box standing beside the chip as its own drop
  // target, the list would only cover the header for nothing. When boxes do
  // overflow, a drag in flight opens the list so every row becomes a target;
  // it folds back unless the user had opened it themselves.
  const pillDrag = usePillDragStore((s) => s.drag);
  const dragging = !!pillDrag && overflow > 0;
  useEffect(() => {
    if (dragging) {
      if (!menuOpen) sprung.current = true;
      reveal();
      return;
    }
    if (!sprung.current) return;
    sprung.current = false;
    dismiss();
    // `menuOpen` is read only to remember whether the drag is what opened the
    // list; re-running on it would fold the list back mid-drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  // Keep the dropdown anchored under the chip while it is open (the header can
  // reflow around it — the pill strip's overflow chevrons appear and vanish).
  useEffect(() => {
    if (!menuOpen) {
      setPos(null);
      return;
    }
    const update = () => {
      const el = chipRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPos({ x: r.left, y: r.bottom });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [menuOpen]);

  // A press outside the chip, the box pills and the portaled list, or Escape,
  // closes both the list and the box context menu — the hover grace alone
  // can't catch a pointer that jumps straight out of the header.
  useEffect(() => {
    if (!menuOpen && !contextMenu) return;
    const onPointer = (e: PointerEvent) => {
      if (chipRef.current?.contains(e.target as Node)) return;
      // The box pills host the rename input, so a press inside them must not
      // fold it away under the pointer.
      if (pillsRef.current?.contains(e.target as Node)) return;
      if ((e.target as HTMLElement).closest?.(".box-chip-menu")) return;
      dismiss();
      setContextMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        dismiss();
        setContextMenu(null);
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuOpen, contextMenu]);

  // The box the context menu is open for, if it still exists (a dissolve from
  // elsewhere closes the menu with it).
  const menuBox = contextMenu ? (boxes.find((b) => b.id === contextMenu.boxId) ?? null) : null;
  useEffect(() => {
    if (contextMenu && !menuBox) setContextMenu(null);
  }, [contextMenu, menuBox]);

  // The projects a box pill's menu offers as members: every open project.
  // Members first, so a long list shows what the box holds before what it could.
  const projects = useProjectsStore((s) => s.projects);
  const memberRows = useMemo(() => {
    if (!menuBox) return [];
    const members = new Set(menuBox.member_ids);
    const open = projects
      .filter((p) => p.status !== "inactive")
      .sort((a, b) => a.position - b.position);
    return [...open.filter((p) => members.has(p.id)), ...open.filter((p) => !members.has(p.id))]
      .slice(0, MAX_MENU_MEMBER_ROWS)
      .map((p) => ({ id: p.id, name: p.name, member: members.has(p.id) }));
  }, [menuBox, projects]);
  const memberRowsTruncated =
    !!menuBox &&
    projects.filter((p) => p.status !== "inactive").length >
      MAX_MENU_MEMBER_ROWS;

  const pick = (boxId: string | null) => {
    dismiss();
    onSelect(boxId);
  };

  const commitRename = () => {
    const next = renameValue.trim();
    const box = renamingId ? boxes.find((b) => b.id === renamingId) : null;
    if (box && next && next !== box.name) onRename(box.id, next);
    setRenamingId(null);
  };

  const chipTitle = () => {
    if (naming === "root") return t("header.rootProject");
    return t("boxChip.pickerTitle");
  };

  const chipLabel = () => {
    if (naming === "root") return t("boxChip.rootLabel");
    return null;
  };

  const station = naming === "root" ? rootStation : undefined;

  const memberCountTitle = (b: ProjectBox) =>
    t(b.member_ids.length === 1 ? "boxPill.memberCountOne" : "boxPill.memberCountMany", {
      count: b.member_ids.length,
    });

  return (
    <>
      <div
        ref={chipRef}
        className={`box-chip${rootActive ? " active" : ""}${
          naming ? " filtering" : ""
        }`}
      >
        {/* The mark: drag it to move the window, click it for "All projects"
            (the menu's own row — drop the box slice). It does not open the
            list; only the caret beside it does. */}
        <button
          type="button"
          className="box-chip-main"
          title={chipTitle()}
          draggable={false}
          onMouseDown={onLogoMouseDown}
          onClick={(e) => {
            e.stopPropagation();
            if (logoDragged.current) {
              logoDragged.current = false;
              return;
            }
            pick(null);
          }}
        >
          {naming === "root" ? (
            <StarIcon className="box-chip-star" />
          ) : (
            <LogoIcon className="box-chip-icon" />
          )}
          {chipLabel() && <span className="box-chip-label">{chipLabel()}</span>}
        </button>
        {/* The list's trigger: hover (or keyboard focus) opens it. */}
        <button
          type="button"
          className="box-chip-caret-btn"
          title={t("boxChip.pickerTitle")}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onMouseEnter={reveal}
          onMouseLeave={scheduleClose}
          onFocus={reveal}
          onClick={(e) => {
            e.stopPropagation();
            reveal();
          }}
        >
          {/* How many boxes have no pill on the row — whatever the chip is
              naming, since those boxes are reachable only through its list. */}
          {overflow > 0 && (
            <span
              className="box-chip-overflow"
              title={t("boxChip.moreBoxesTitle", { count: overflow })}
            >
              {t("boxChip.moreBoxes", { count: overflow })}
            </span>
          )}
          <span className="box-chip-caret" aria-hidden>
            ▾
          </span>
        </button>
        {/* Steering-mode station number, for the built-in scope the chip is
            naming — the root pill used to carry its own. */}
        {station != null && (
          <span className="steering-station-chip" aria-hidden>
            {station}
          </span>
        )}
      </div>

      {/* The box pills, right of the chip: one per box (up to MAX_BOX_PILLS),
          in the boxes' own order. Each names its box in the box's colour,
          wears the box's own status strip, takes the drop of a project
          dragged onto it, hosts the rename input and the box's context menu,
          and enters the box's scope on one click. Deliberately the chip's own
          box (`.box-chip`, minus the caret) rather than a shape of its own,
          so the leading segment stays one run. */}
      {shown.length > 0 && (
        <div ref={pillsRef} className="box-pill-row">
          {shown.map((b) => {
            const isSelected = b.id === selectedId;
            const isActive = isSelected && !!active;
            const color = boxColor(b);
            return (
              <div
                key={b.id}
                // The assign-to-box drop target: ProjectPill's hit-test sweeps
                // `[data-box-id]` across the document, so every pill here is a
                // target in its own right — no menu has to open first.
                data-box-id={b.id}
                className={`box-chip box-scope-pill${isSelected ? " is-selected filtering" : ""}${
                  isActive ? " active" : ""
                }${pillDrag?.overBoxId === b.id ? " drag-over" : ""}`}
                style={{ "--box-color": color } as CSSProperties}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  dismiss();
                  const bottom = (e.currentTarget as HTMLElement).getBoundingClientRect().bottom;
                  setContextMenu({ x: e.clientX, y: bottom || e.clientY, boxId: b.id });
                }}
              >
                {renamingId === b.id ? (
                  <input
                    className="project-box-rename-input"
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="box-chip-main"
                    title={t("boxScopePill.title", {
                      name: b.name,
                      members: memberCountTitle(b),
                    })}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(b.id);
                    }}
                  >
                    {/* The members' filled swatch, not the chip's outline
                        hexagon: the pill and its members' project pills wear
                        the same mark. */}
                    <BoxSwatch className="project-pill-box-swatch" />
                    <span className="box-chip-label">{b.name}</span>
                  </button>
                )}
                <ScopeSetStatusBars scopes={[`${BOX_SCOPE_PREFIX}${b.id}`]} />
              </div>
            );
          })}
        </div>
      )}

      {menuOpen &&
        pos &&
        createPortal(
          <div
            className="box-chip-menu"
            style={{ left: pos.x, top: pos.y }}
            // The list is portaled to <body>, so the pointer travelling down
            // into it has LEFT the chip: without these the 250 ms grace would
            // fold it away under the cursor. It opens flush under the chip, so
            // there is no gap to cross.
            onMouseEnter={reveal}
            onMouseLeave={scheduleClose}
          >
            {/* The built-in root scope, ahead of the boxes and of "All
                projects": it is a destination, not a slice. */}
            <button
              className={rootActive ? "is-current" : undefined}
              title={t("header.rootProject")}
              onClick={() => {
                dismiss();
                onSelectRoot();
              }}
            >
              <StarIcon className="box-chip-menu-star" />
              <span className="box-chip-menu-name">{t("boxChip.rootRow")}</span>
              <ScopeSetStatusBars
                scopes={[ROOT_SCOPE]}
                interactive={false}
                className="inline"
              />
              {rootStation != null && (
                <span className="box-chip-menu-count">{rootStation}</span>
              )}
              <MenuShortcut chord="rootConsole" />
            </button>
            <div className="box-chip-menu-sep" />
            <button
              className={selectedId === null ? "is-current" : undefined}
              onClick={() => pick(null)}
            >
              {t("boxChip.allProjects")}
            </button>
            {ordered.length > 0 && <div className="box-chip-menu-sep" />}
            {ordered.length > 0 && (
              <div className="box-chip-menu-label">
                {t("boxChip.onRowLabel")} <UntestedTag id="boxChip.onRowLabel" />
              </div>
            )}
            {ordered.map((b) => (
              <div key={b.id} className="box-chip-menu-row">
                {/* Whether the box stands on the row as a pill. Its own button
                    beside the row's, so toggling never enters the box, and the
                    menu stays open across toggles like the members checklist. */}
                <button
                  type="button"
                  className="box-chip-menu-pin"
                  aria-pressed={!b.hide_pill}
                  title={t(b.hide_pill ? "boxChip.showPillTitle" : "boxChip.hidePillTitle", {
                    name: b.name,
                  })}
                  onClick={() => void useBoxesStore.getState().setBoxPillHidden(b.id, !b.hide_pill)}
                >
                  {b.hide_pill ? <SquareIcon /> : <CheckboxIcon />}
                </button>
                <button
                  // A drop target in its own right while a pill drag is in
                  // flight (see the spring-loaded open above); ProjectPill's
                  // hit-test sweeps `[data-box-id]` across the document, so a
                  // portaled row counts exactly as a pill does.
                  data-box-id={b.id}
                  className={`${b.id === selectedId ? "is-current" : ""}${
                    pillDrag?.overBoxId === b.id ? " drag-over" : ""
                  }`.trim()}
                  onClick={() => pick(b.id)}
                  title={memberCountTitle(b)}
                >
                  <BoxSwatch className="project-pill-box-swatch" color={boxColor(b)} />
                  <span className="box-chip-menu-name">{b.name}</span>
                  {/* Inert bars: the row is already a button, and picking the
                      box is the way in from here. */}
                  <ScopeSetStatusBars
                    scopes={[`${BOX_SCOPE_PREFIX}${b.id}`]}
                    interactive={false}
                    className="inline"
                  />
                  <span className="box-chip-menu-count">{b.member_ids.length}</span>
                </button>
              </div>
            ))}
            <div className="box-chip-menu-sep" />
            <button
              onClick={() => {
                dismiss();
                useBoxEditorStore.getState().openCreate();
              }}
            >
              {t("projectSwitcher.newBox")}
            </button>
            <button
              onClick={() => {
                dismiss();
                useBoxEditorStore.getState().openEditor(null);
              }}
            >
              {t("pill.editBoxesEllipsis")}
            </button>
          </div>,
          document.body,
        )}

      {contextMenu &&
        menuBox &&
        createPortal(
          <div
            className="context-menu box-pill-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => {
                setContextMenu(null);
                onSelect(menuBox.id);
              }}
            >
              {t("boxPill.openBox")}
            </button>
            <button
              onClick={() => {
                setContextMenu(null);
                setRenameValue(menuBox.name);
                setRenamingId(menuBox.id);
              }}
            >
              {t("common.rename")}
            </button>
            <BoxColorPicker
              box={menuBox}
              onPick={(color) => void useBoxesStore.getState().setBoxColor(menuBox.id, color)}
            />

            {/* Members, right on the box: a checkbox row per open project,
                toggling membership on the spot. The menu STAYS open across
                toggles — adding three projects is three clicks, not three
                right-clicks — and closes on Escape or a press elsewhere. */}
            <div className="context-menu-group">
              <div className="context-menu-group-label">
                {t("boxPill.membersGroup")} <UntestedTag id="boxPill.membersGroup" />
              </div>
              {memberRows.map((row) => (
                <button
                  key={row.id}
                  className="context-menu-check"
                  data-member-id={row.id}
                  onClick={() => {
                    const store = useBoxesStore.getState();
                    if (row.member) void store.removeFromBox(row.id, menuBox.id);
                    else void store.addToBox(row.id, menuBox.id);
                  }}
                  title={t(row.member ? "boxPill.removeMemberTitle" : "boxPill.addMemberTitle", {
                    name: row.name,
                    box: menuBox.name,
                  })}
                >
                  <span className="context-menu-checkmark" aria-hidden>
                    {row.member ? <CheckboxIcon /> : <SquareIcon />}
                  </span>
                  {row.name}
                </button>
              ))}
              {memberRows.length === 0 && (
                <div className="context-menu-note">{t("boxEditor.noProjects")}</div>
              )}
              {memberRowsTruncated && (
                <div className="context-menu-note">{t("boxPill.moreInEditor")}</div>
              )}
            </div>

            <button
              onClick={() => {
                setContextMenu(null);
                useBoxEditorStore.getState().openEditor(menuBox.id);
              }}
            >
              {t("boxPill.editBoxEllipsis")}
            </button>
            <button
              className="danger"
              onClick={() => {
                setContextMenu(null);
                onDelete(menuBox.id);
              }}
            >
              {t("boxPill.deleteBox")}
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
