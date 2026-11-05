import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { ProjectBox } from "../../types";
import { BOX_SCOPE_PREFIX, useBoxesStore } from "../../stores/boxes";
import { ROOT_SCOPE } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import { useBoxEditorStore } from "../../stores/boxEditor";
import { usePillDragStore } from "../../stores/drag/pillDrag";
import { headerMenuCloseDelay, useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { boxColor } from "../../lib/theme/boxColor";
import { boxPillBudget, type HeaderWidthTier } from "../../lib/headerPins";
import { useT } from "../../lib/i18n";
import { startWindowDrag } from "../../lib/window/startWindowDrag";
import { StarIcon } from "../layout/StarIcon";
import { LogoIcon } from "../layout/LogoIcon";
import { ScopeSetStatusBars } from "./PillStatusBars";
import { MenuShortcut } from "../common/MenuShortcut";
import { ContextMenuPortal } from "../common/ContextMenuPortal";
import { UntestedTag } from "../common/UntestedTag";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { BoxColorPicker } from "./BoxColorPicker";
import { BoxMemberChecklist } from "./BoxMemberChecklist";
import { useBoxNameCheck, useQuickCreateBox } from "./useQuickCreateBox";
import { BoxSwatch, CheckboxIcon, CheckIcon, CloseIcon, PlusIcon, SquareIcon } from "../common/icons/Icon";
import { setBoxBarHidden, useBarHidden } from "../../lib/projects/barHidden";
import { BarHiddenSection, type BarHiddenSet } from "./BarHiddenList";

/** This chip's entry in the shared header hover-menu id (stores/headerHoverMenu). */
const SCOPE_MENU_ID = "box-scope-chip";

/**
 * The status strip of one box: the agents running in the box's own scope AND
 * in its member projects' scopes. A member's agent is the box's agent too (the
 * project may be closed on the strip, yet its work is what the box is doing),
 * and a pill that read idle while a member worked would say "nothing is
 * running there". Each bar still opens its own tab.
 */
function BoxStatusBars({
  box,
  interactive,
  className,
}: {
  box: ProjectBox;
  interactive?: boolean;
  className?: string;
}) {
  const memberKey = box.member_ids.join("\n");
  const scopes = useMemo(
    () => [`${BOX_SCOPE_PREFIX}${box.id}`, ...(memberKey ? memberKey.split("\n") : [])],
    [box.id, memberKey],
  );
  return <ScopeSetStatusBars scopes={scopes} interactive={interactive} className={className} />;
}

/**
 * How many boxes stand on the row as pills of their own on a wide window.
 * Boxes are few by nature (a handful of joinings, not a project list), so
 * nearly every user sees all of theirs; past the budget the rest stay one click
 * away in the list the logo's caret (`▾ +N`) opens.
 * A narrower header gives less (`boxPillBudget`: 6 / 3 / 1 by width tier).
 */
export const MAX_BOX_PILLS = boxPillBudget(0);

/**
 * The boxes that get a pill under `budget`: the first `budget` by position that
 * the user has not hidden from the row (the dropdown's per-row checkbox) —
 * always including the selected box, which takes the last slot when it would
 * otherwise be off the row (and stands in its own place), so the box being
 * looked at is never the one without a pill. A budget of 1 is that box alone:
 * with none selected the row holds no pill and the caret counts them all.
 */
export function boxPillsShown(
  ordered: readonly ProjectBox[],
  selectedId: string | null,
  budget: number,
): ProjectBox[] {
  const selected = selectedId ? ordered.find((b) => b.id === selectedId) : undefined;
  if (budget <= 1) return selected ? [selected] : [];
  const head = ordered.filter((b) => !b.hide_pill).slice(0, budget);
  if (!selected || head.includes(selected)) return head;
  const seated = head.length < budget ? head : head.slice(0, budget - 1);
  return ordered.filter((b) => b === selected || seated.includes(b));
}

/** How far (px) a press on the logo travels before it becomes a window move
 *  rather than a click ("All projects"). */
const LOGO_DRAG_SLOP = 4;

interface Props {
  boxes: ProjectBox[];
  /** The box whose slice the pill strip is showing (`null` = every project). */
  selectedId: string | null;
  /** Pick a box (also opens its scope) or `null` to go back to all projects. */
  onSelect: (boxId: string | null) => void;
  /** The ✕ on the selected pill: leave the box — clear the slice and, from
   *  inside the box scope, go back to the project the strip was on
   *  (`boxSlice.leaveBox`). */
  onLeave: () => void;
  /** The header's width tier: it sets how many box pills the row may hold. */
  widthTier?: HeaderWidthTier;
  onRename: (boxId: string, name: string) => void;
  /** "Dissolve box…" from a pill's menu: the caller asks the confirm question,
   *  leaves the box first when it is the one being looked at, and deletes. */
  onDissolve: (boxId: string) => void;
  /** The selected box's scope is the current one — the `active` treatment on
   *  the box's own pill, driven off `scope` exactly as every project pill
   *  beside it is. */
  active?: boolean;
  /** The root terminal's scope is the current one. */
  rootActive?: boolean;
  onSelectRoot: () => void;
  /** Keyboard-steering station digits, while steering mode is active. */
  rootStation?: number;
  /** What the "All projects" strip leaves out; the dropdown's "N hidden"
   *  entry lists it. Unset inside a slice, which ignores the lists. */
  hidden?: BarHiddenSet;
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
 * same box reads the same everywhere. Past the width tier's budget the rest
 * stay in the dropdown and the logo's caret (`▾ +N`) counts them — one
 * trigger for the one list (the old fold pill after the pills opened the same
 * list a second time).
 *
 * The selected pill wears an always-visible ✕ ("Show all projects"), so the
 * way out of a box is never a hover menu; with no box at all the row is one
 * ghost "+ Box" pill.
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
  onLeave,
  widthTier = 0,
  onRename,
  onDissolve,
  active,
  rootActive,
  onSelectRoot,
  rootStation,
  hidden,
}: Props) {
  const t = useT();
  const barHidden = useBarHidden();
  // Hover-opened through the SHARED header menu id, like the + menu and the
  // cluster menus beside it: one id means opening another header menu closes
  // this one in the same frame instead of both riding out their own 250 ms
  // closing grace. Hover and focus reveal the list; a CLICK on the caret pins
  // it open — it then stays until a second click, a pick,
  // Escape or a press elsewhere, so it no longer evaporates when the pointer
  // drifts off a 10 px target. The logo itself opens nothing (it is the root
  // console and the window's move handle).
  const menuOpen = useHeaderHoverMenuStore((s) => s.openId === SCOPE_MENU_ID);
  const openMenu = useHeaderHoverMenuStore((s) => s.open);
  const closeMenu = useHeaderHoverMenuStore((s) => s.close);
  const closeTimer = useRef<number | undefined>(undefined);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; boxId: string } | null>(
    null,
  );
  // Which pill is being renamed lives in `stores/boxEditor` so a gesture
  // elsewhere (the Alt-drag that just made a box) can put its pill into rename.
  const renamingId = useBoxEditorStore((s) => s.renamingId);
  const setRenamingId = (id: string | null) => {
    const editor = useBoxEditorStore.getState();
    if (id) editor.startRename(id);
    else editor.stopRename();
  };
  const [renameValue, setRenameValue] = useState("");
  // A refused name (empty, taken, too long) keeps the field open on Enter and
  // says why; the box's own spelling is always fine (`check` takes its id).
  const [renameProblem, setRenameProblem] = useState<string | null>(null);
  const { check: checkBoxName } = useBoxNameCheck();
  // Every "new box" door in this chip (the list's "New Box" row) goes through the
  // one name prompt; the ghost pill has its own while no box exists.
  const { quickCreateBox, dialogs: quickCreateDialogs } = useQuickCreateBox();
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const chipRef = useRef<HTMLDivElement>(null);
  const pillsRef = useRef<HTMLDivElement>(null);
  const sprung = useRef(false);
  const pinned = useRef(false);

  const reveal = () => {
    window.clearTimeout(closeTimer.current);
    openMenu(SCOPE_MENU_ID);
  };
  const holdOpen = () => window.clearTimeout(closeTimer.current);
  const scheduleClose = (e?: { clientY: number }) => {
    window.clearTimeout(closeTimer.current);
    if (pinned.current) return;
    closeTimer.current = window.setTimeout(() => closeMenu(SCOPE_MENU_ID), headerMenuCloseDelay(e));
  };
  const dismiss = () => {
    window.clearTimeout(closeTimer.current);
    pinned.current = false;
    closeMenu(SCOPE_MENU_ID);
  };
  // A click: closed → open and pinned; hover-opened → pinned; pinned → closed.
  const toggle = () => {
    if (menuOpen && pinned.current) {
      dismiss();
      return;
    }
    reveal();
    pinned.current = true;
  };
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);
  // Another header menu taking the shared id closes this one; the pin goes too.
  useEffect(() => {
    if (!menuOpen) pinned.current = false;
  }, [menuOpen]);
  // A box dissolved while its pill is in rename takes the field with it.
  useEffect(() => {
    if (!renamingId) return;
    const box = boxes.find((b) => b.id === renamingId);
    if (!box) useBoxEditorStore.getState().stopRename();
  }, [renamingId, boxes]);
  // The field opens on the box's own name, whichever door started the rename.
  useEffect(() => {
    if (!renamingId) return;
    const box = useBoxesStore.getState().boxes.find((b) => b.id === renamingId);
    if (box) setRenameValue(box.name);
    setRenameProblem(null);
  }, [renamingId]);

  // The logo is the window's move handle. The move starts only once the press
  // has travelled LOGO_DRAG_SLOP px, so a press that stays put is still the
  // click that opens the root console. Once the OS move loop owns the pointer
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
      startWindowDrag({ x: ev.clientX, y: ev.clientY });
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

  // The boxes in row order, and the ones that get a pill under the width
  // tier's budget (`boxPillsShown`: the selected box always among them).
  const ordered = useMemo(() => [...boxes].sort((a, b) => a.position - b.position), [boxes]);
  const budget = boxPillBudget(widthTier);
  const shown = useMemo(
    () => boxPillsShown(ordered, selectedId, budget),
    [ordered, selectedId, budget],
  );
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

  // Keep the dropdown anchored under the chip while it is open (the header
  // can reflow around it — the pill strip's overflow chevrons appear and vanish).
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
  // closes the list — the hover grace alone can't catch a pointer that jumps
  // straight out of the header. (The box context menu is a `ContextMenuPortal`
  // and closes itself the same way.)
  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (e: PointerEvent) => {
      if (chipRef.current?.contains(e.target as Node)) return;
      // The box pills host the rename input, so a press inside them must not
      // fold it away under the pointer.
      if (pillsRef.current?.contains(e.target as Node)) return;
      if ((e.target as HTMLElement).closest?.(".box-chip-menu")) return;
      dismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuOpen]);

  // The box the context menu is open for, if it still exists (a dissolve from
  // elsewhere closes the menu with it).
  const menuBox = contextMenu ? (boxes.find((b) => b.id === contextMenu.boxId) ?? null) : null;
  useEffect(() => {
    if (contextMenu && !menuBox) setContextMenu(null);
  }, [contextMenu, menuBox]);

  const pick = (boxId: string | null) => {
    dismiss();
    onSelect(boxId);
  };

  // Enter: a name that may not be written (empty, taken, too long) leaves the
  // field open, marked, with the reason as its tooltip; Escape backs out. A blur
  // is a walk-away, not an answer: a refused name is dropped, and the reason is
  // still said (the caller toasts what `renameBox` refuses).
  const commitRename = (via: "enter" | "blur") => {
    const next = renameValue.trim();
    const box = renamingId ? boxes.find((b) => b.id === renamingId) : null;
    if (box && next !== box.name) {
      const problem = checkBoxName(next, box.id);
      if (problem && via === "enter") {
        setRenameProblem(problem);
        return;
      }
      if (!problem) onRename(box.id, next);
      else if (next) useProjectsStore.setState({ switchToast: problem });
    }
    setRenameProblem(null);
    setRenamingId(null);
  };

  const chipTitle = () => {
    if (naming === "root") return t("header.rootProject");
    return t("boxChip.logoTitle");
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
        {/* The mark: drag it to move the window, click it for the root
            console (the menu's root row; "All projects" is a row there too).
            It does not open the list; only the caret beside it does. */}
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
            dismiss();
            onSelectRoot();
          }}
        >
          {/* The logo alone, root scope included: root is reached by clicking
              it (or Ctrl+Shift+R), not named here. */}
          <LogoIcon className="box-chip-icon" />
        </button>
        {/* The list's ONE trigger: hover or keyboard focus opens it, a click
            pins it open (a second click, a pick, Escape or a press elsewhere
            closes). The count of boxes with no pill on the row rides it as
            `▾ +N` (a bare `N` when no pill is shown at all). */}
        <button
          type="button"
          className="box-chip-caret-btn"
          title={
            overflow > 0
              ? `${t("boxChip.pickerTitle")} · ${t("boxChip.moreBoxesTitle", { count: overflow })}`
              : t("boxChip.pickerTitle")
          }
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onMouseEnter={reveal}
          onMouseLeave={scheduleClose}
          onFocus={reveal}
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
        >
          <span className="box-chip-caret" aria-hidden>
            ▾
          </span>
          {overflow > 0 && (
            <>
              <span className="box-chip-overflow">
                {shown.length > 0 ? t("boxChip.moreBoxes", { count: overflow }) : overflow}
              </span>
              <UntestedTag id="boxChip.foldPill" />
            </>
          )}
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
      {(shown.length > 0 || ordered.length === 0) && (
        <div ref={pillsRef} className="box-pill-row">
          {/* No box yet: one quiet ghost pill is the door in (first-use
              discovery). It goes once any box exists. */}
          {ordered.length === 0 && <GhostBoxPill />}
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
                    aria-invalid={renameProblem ? true : undefined}
                    title={renameProblem ?? undefined}
                    onChange={(e) => {
                      setRenameValue(e.target.value);
                      setRenameProblem(null);
                    }}
                    onBlur={() => commitRename("blur")}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename("enter");
                      if (e.key === "Escape") {
                        setRenameProblem(null);
                        setRenamingId(null);
                      }
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
                      dismiss();
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
                {/* The way out, always visible on the selected pill (never
                    hover-only): the same action as the list's "All projects". */}
                {isSelected && renamingId !== b.id && (
                  <>
                    <button
                      type="button"
                      className="box-pill-leave"
                      title={t("boxChip.leaveTitle", { name: b.name })}
                      aria-label={t("boxChip.leaveTitle", { name: b.name })}
                      onClick={(e) => {
                        e.stopPropagation();
                        dismiss();
                        onLeave();
                      }}
                    >
                      <CloseIcon />
                    </button>
                    <UntestedTag id="boxChip.leaveBox" />
                  </>
                )}
                <BoxStatusBars box={b} />
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
            // into it has LEFT the chip: without these the close timer would
            // fold it away under the cursor. It opens flush under the chip, so
            // there is no gap to cross.
            onMouseEnter={holdOpen}
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
            {/* The cockpit: every scope's agents at once, a destination of
                its own like root, not a slice. */}
            <button
              onClick={() => {
                dismiss();
                useRootOverlayStore.getState().openView("now");
              }}
            >
              <span className="box-chip-menu-name">{t("cockpit.openFromBox")}</span>
              <UntestedTag id="cockpit.openFromBox" />
            </button>
            <div className="box-chip-menu-sep" />
            <button
              className={selectedId === null ? "is-current" : undefined}
              onClick={() => pick(null)}
            >
              {t("boxChip.allProjects")}
            </button>
            {hidden && <BarHiddenSection hidden={hidden} onPicked={dismiss} />}
            {ordered.length > 0 && <div className="box-chip-menu-sep" />}
            {ordered.length > 0 && (
              <div className="box-chip-menu-label">
                {t("boxChip.onRowLabel")} <UntestedTag id="boxChip.onRowLabel" />{" "}
                <UntestedTag id="boxChip.marks" />{" "}
                <UntestedTag id="boxChip.memberAgents" />
              </div>
            )}
            {ordered.map((b) => {
              // Two states, two marks: bold = the slice (the strip shows this
              // box's projects), ✓ = the scope (you are in the box itself).
              const isSlice = b.id === selectedId;
              const isScope = isSlice && !!active;
              return (
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
                  className={`${isSlice ? "is-current is-slice" : ""}${isScope ? " is-scope" : ""}${
                    pillDrag?.overBoxId === b.id ? " drag-over" : ""
                  }`.trim()}
                  onClick={() => pick(b.id)}
                  title={
                    isScope
                      ? t("boxChip.rowScope", { members: memberCountTitle(b) })
                      : isSlice
                        ? t("boxChip.rowSlice", { members: memberCountTitle(b) })
                        : memberCountTitle(b)
                  }
                >
                  <BoxSwatch className="project-pill-box-swatch" color={boxColor(b)} />
                  <span className="box-chip-menu-name">{b.name}</span>
                  {isScope && <CheckIcon className="box-chip-menu-scope" />}
                  {/* Inert bars: the row is already a button, and picking the
                      box is the way in from here. */}
                  <BoxStatusBars box={b} interactive={false} className="inline" />
                  <span className="box-chip-menu-count">{b.member_ids.length}</span>
                </button>
              </div>
              );
            })}
            <div className="box-chip-menu-sep" />
            <button
              onClick={() => {
                dismiss();
                void quickCreateBox();
              }}
            >
              {t("projectSwitcher.newBox")} <UntestedTag id="boxChip.createDoors" />
            </button>
            {/* Opens the box you are looking at, else the first one: the editor
                is for editing, never a way into creating (that is the row above). */}
            {ordered.length > 0 && (
              <button
                onClick={() => {
                  dismiss();
                  useBoxEditorStore.getState().openEditor(selectedId ?? ordered[0].id);
                }}
              >
                {t("pill.editBoxesEllipsis")}
              </button>
            )}
          </div>,
          document.body,
        )}

      {contextMenu && menuBox && (
        <ContextMenuPortal
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          className="context-menu box-pill-menu"
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
            {t("common.rename")} <UntestedTag id="boxPill.rename" />
          </button>
          <BoxColorPicker
            box={menuBox}
            onPick={(color) => void useBoxesStore.getState().setBoxColor(menuBox.id, color)}
          />
          {/* Keeps the members off the "All projects" strip only; this
              slice still shows them all (lib/projects/barHidden). */}
          <button
            className="context-menu-check untested"
            onClick={() => {
              setContextMenu(null);
              const hide = !barHidden.boxes.has(menuBox.id);
              void setBoxBarHidden(menuBox.id, hide, new Set(boxes.map((b) => b.id)));
            }}
            title={t("boxPill.hideMembersTitle", { name: menuBox.name })}
          >
            <span className="context-menu-checkmark" aria-hidden>
              {barHidden.boxes.has(menuBox.id) ? <CheckboxIcon /> : <SquareIcon />}
            </span>
            {t("boxPill.hideMembers")}
            <UntestedTag id="boxPill.hideMembers" />
          </button>

          {/* Members, right on the box: the shared checklist (every project,
              closed ones labelled), toggling membership on the spot. The menu
              STAYS open across toggles — adding three projects is three clicks,
              not three right-clicks — and closes on Escape or a press elsewhere. */}
          <div className="context-menu-group">
            <div className="context-menu-group-label">
              {t("boxPill.membersGroup")} <UntestedTag id="boxMembers.checklist" />
            </div>
            <BoxMemberChecklist box={menuBox} />
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
              onDissolve(menuBox.id);
            }}
          >
            {t("boxPill.dissolveBox")} <UntestedTag id="boxPill.dissolveBox" />
          </button>
        </ContextMenuPortal>
      )}
      {quickCreateDialogs}
    </>
  );
}

/**
 * The ghost "+ Box" pill, the row's only box UI while the user has none: a
 * quiet dashed pill that asks for a name and drops the user into the new box
 * (`useQuickCreateBox`). Its own component so the name prompt (`dialogs`, a
 * portal that must sit beside, not inside, the pill) mounts only while it does.
 */
function GhostBoxPill() {
  const t = useT();
  const { quickCreateBox, dialogs } = useQuickCreateBox();
  return (
    <>
      <div className="box-chip box-ghost-pill">
        <button
          type="button"
          className="box-chip-main"
          title={t("boxChip.newBoxPillTitle")}
          onClick={(e) => {
            e.stopPropagation();
            void quickCreateBox();
          }}
        >
          <PlusIcon className="box-ghost-plus" />
          <span className="box-chip-label">{t("boxChip.newBoxPill")}</span>
        </button>
        <UntestedTag id="boxChip.newBoxPill" />
      </div>
      {dialogs}
    </>
  );
}
