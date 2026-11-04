/**
 * Component tests for box rendering in the switcher under the CHIP model
 * (#13/#41, N:M membership): boxes are not pills among the projects — one
 * chip heads the row (root, the full boxes list, "All projects"), and
 * every box stands beside it as a small coloured pill of its own; picking one
 * SLICES the strip to that box's members. Member pills still render
 * individually (with a swatch per box in the box's colour), each box pill is
 * an assign-to-box drop target, and Alt-drop on a pill boxes the two.
 *
 * The pill drag is pointer-driven (see ProjectPill's `startPillDrag`), not
 * native HTML5 DnD — jsdom gives every element a zero-sized rect, so the drag's
 * hit-testing is driven by stubbing `getBoundingClientRect`, the same approach
 * `PageStrip.test.tsx`/`DragDropSplit.test.tsx` take for their pointer drags.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, fireEvent, cleanup, screen, within } from "@testing-library/react";
import type { ProjectBox, ProjectEntry } from "../../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(null) }));
const startWindowDrag = vi.hoisted(() => vi.fn());
vi.mock("../../lib/window/startWindowDrag", () => ({ startWindowDrag }));

import { ProjectSwitcher } from "../../components/layout/ProjectSwitcher";
import { useProjectsStore } from "../../stores/projects";
import { BOX_SCOPE_PREFIX, BoxNameError, useBoxesStore } from "../../stores/boxes";
import { resetBoxSlice, useBoxSliceStore } from "../../stores/boxSlice";
import { useBoxEditorStore } from "../../stores/boxEditor";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { usePillDragStore } from "../../stores/drag/pillDrag";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { useTabsStore } from "../../stores/tabs";
import { useActivityStore } from "../../stores/activity";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { MAX_BOX_PILLS } from "../../components/projects/BoxScopeChip";
import { boxColor } from "../../lib/theme/boxColor";

function proj(id: string, position: number): ProjectEntry {
  return {
    id,
    name: id,
    status: "active",
    position,
    local_file: `/p/${id}/project.json`,
  };
}

function box(id: string, members: string[], position = 5): ProjectBox {
  return { id, name: id, member_ids: members, position };
}


/** What the real `openBox` does that these tests depend on: it moves the tab
 *  scope into the box. The chip names the scope it is in, so a mock that only
 *  resolved left it naming root. */
async function openBoxScope(boxId: string) {
  useTabsStore.setState({ scope: `${BOX_SCOPE_PREFIX}${boxId}` });
}

/** Give an element a fixed layout rect, since jsdom's is always zero-sized. */
function layOut(
  el: HTMLElement,
  r: { left: number; right: number; top: number; bottom: number },
) {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    left: r.left,
    right: r.right,
    top: r.top,
    bottom: r.bottom,
    width: r.right - r.left,
    height: r.bottom - r.top,
    x: r.left,
    y: r.top,
    toJSON: () => ({}),
  } as DOMRect);
}

/** Dispatch a pointer event the way the existing drag tests do (`PageStrip`,
 *  `DragDropSplit`): jsdom's PointerEvent doesn't carry the fields the pointer
 *  gesture reads, so a plain Event is decorated with them. */
function pointer(
  type: string,
  x: number,
  y: number,
  target: EventTarget,
  opts: { altKey?: boolean } = {},
) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, { clientX: x, clientY: y, button: 0, pointerId: 1, altKey: !!opts.altKey });
  act(() => {
    target.dispatchEvent(ev);
  });
}

function findPill(container: HTMLElement, name: string): HTMLElement {
  return [...container.querySelectorAll(".project-pill")].find(
    (el) => el.querySelector(".project-pill-label")?.textContent === name,
  ) as HTMLElement;
}

function pillNames(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".project-pill .project-pill-label")].map(
    (el) => el.textContent ?? "",
  );
}

function chip(container: HTMLElement): HTMLElement | null {
  // The selected box's pill wears the chip's own box (`.box-chip`), so the chip
  // proper is the one that is NOT it.
  return container.querySelector(".box-chip:not(.box-scope-pill)");
}

/** The first box pill right of the chip (null when there is no box). */
function boxPill(container: HTMLElement): HTMLElement | null {
  return container.querySelector(".box-scope-pill");
}

/** The box pills' names, in row order. */
function boxPillNames(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".box-scope-pill .box-chip-label")].map(
    (el) => el.textContent ?? "",
  );
}

/** The `+N` on the logo's caret: the boxes without a pill (null when none). */
function caretCount(container: HTMLElement): HTMLElement | null {
  return container.querySelector(".box-chip-caret-btn .box-chip-overflow");
}

/** Open the chip's dropdown (hovering its caret opens it — a click on the
 *  logo is "All projects") and hand back its portaled menu. */
async function openChipMenu(container: HTMLElement): Promise<HTMLElement> {
  const chip = container.querySelector(".box-chip-caret-btn") as HTMLElement;
  await act(async () => {
    fireEvent.mouseEnter(chip);
  });
  return document.querySelector(".box-chip-menu") as HTMLElement;
}

function menuRow(menu: HTMLElement, text: string): HTMLElement {
  return [...menu.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(text),
  ) as HTMLElement;
}

/** The store's own `setActive`, so a test that swaps in a spy cannot leak it
 *  into the next one. */
const realSetActive = useProjectsStore.getState().setActive;

beforeEach(() => {
  resetBoxSlice();
  // The header's shared hover-menu id outlives a test's unmount.
  useHeaderHoverMenuStore.getState().close("box-scope-chip");
  usePillDragStore.getState().end();
  useKeyboardSteeringStore.getState().exit();
  useProjectsStore.setState({
    projects: [],
    activeId: null,
    loaded: true,
    setActive: realSetActive,
  });
  useBoxesStore.setState({ boxes: [], loaded: true });
  useTabsStore.setState({ scope: "root" });
});

async function renderSwitcher(widthTier: 0 | 1 | 2 | 3 = 0) {
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<ProjectSwitcher open={true} widthTier={widthTier} />));
  });
  return container;
}

describe("box chip rendering (slice model)", () => {
  it("renders NO box pill in the strip — one chip beside the root pill instead", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])] });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
    });

    const container = await renderSwitcher();

    // The strip holds projects and nothing else: no box wears a pill any more.
    expect(pillNames(container).sort()).toEqual(["p1", "p2"]);
    expect(container.querySelector(".project-pill.is-box")).toBeNull();
    expect(chip(container)).toBeTruthy();

    // The member pill wears the box badge; the non-member doesn't.
    expect(findPill(container, "p1").querySelector(".project-pill-boxdot")).toBeTruthy();
    expect(findPill(container, "p2").querySelector(".project-pill-boxdot")).toBeNull();
  });

  it("is the row's whole leading segment: no root pill beside it", async () => {
    // The chip used to render nothing at all until a box existed, when root
    // had a pinned pill of its own. It folds into it now, so it is
    // always there — and it is the ONLY thing between the header's edge and the
    // scrolling projects.
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });
    const container = await renderSwitcher();
    expect(chip(container)).toBeTruthy();
    expect(container.querySelector(".root-pill")).toBeNull();
    // The app's logo alone, in the root scope too: no "Root" label.
    expect(chip(container)!.querySelector(".box-chip-icon")).toBeTruthy();
    expect(chip(container)!.querySelector(".box-chip-label")).toBeNull();
  });

  it("lists root in the dropdown, ahead of the boxes", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])] });
    useProjectsStore.setState({
      projects: [proj("p1", 10)],
      activeId: null,
      loaded: true,
    });

    const container = await renderSwitcher();
    const menu = await openChipMenu(container);
    const rows = [...menu.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(rows[0]).toContain("Root project");
    expect(rows.findIndex((r) => r.includes("boxA"))).toBeGreaterThan(0);
    // Root is not a box, so it is no drop target for a pill drag.
    expect(menu.querySelectorAll("[data-box-id]").length).toBe(1);
  });

  it("the chip lists every box, empty ones included, with member counts", async () => {
    useBoxesStore.setState({ boxes: [box("solo", ["p1"], 5), box("empty", [], 6)] });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });

    const container = await renderSwitcher();
    const menu = await openChipMenu(container);
    expect(menu.textContent).toContain("solo");
    // An empty box survives and is still selectable (dissolve is the editor's
    // explicit action) — it simply costs the strip no width.
    expect(menu.textContent).toContain("empty");
    const counts = [...menu.querySelectorAll(".box-chip-menu-count")].map((el) => el.textContent);
    expect(counts).toEqual(["1", "0"]);
  });

  it("picking a box opens it AND slices the strip to its members", async () => {
    const openBox = vi.fn(openBoxScope);
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])], openBox });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
    });

    const container = await renderSwitcher();
    const menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "boxA"));
    });

    expect(openBox).toHaveBeenCalledWith("boxA");
    expect(pillNames(container)).toEqual(["p1"]);
    // The box is named by its OWN pill beside the chip, not on the chip's face.
    expect(boxPill(container)!.textContent).toContain("boxA");
    expect(chip(container)!.textContent).not.toContain("boxA");
  });

  it("“All projects” puts the whole strip back", async () => {
    useBoxesStore.setState({
      boxes: [box("boxA", ["p1"])],
      openBox: vi.fn(openBoxScope),
    });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
    });

    const container = await renderSwitcher();
    let menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "boxA"));
    });
    expect(pillNames(container)).toEqual(["p1"]);

    menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "All projects"));
    });
    expect(pillNames(container).sort()).toEqual(["p1", "p2"]);
  });

  it("clicking the logo opens the root console and keeps the box slice", async () => {
    useRootOverlayStore.setState({ open: false });
    useBoxesStore.setState({
      boxes: [box("boxA", ["p1"])],
      openBox: vi.fn(openBoxScope),
    });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
    });

    const container = await renderSwitcher();
    const menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "boxA"));
    });
    expect(pillNames(container)).toEqual(["p1"]);

    await act(async () => {
      fireEvent.click(container.querySelector(".box-chip-main") as HTMLElement);
    });
    expect(useRootOverlayStore.getState().open).toBe(true);
    expect(pillNames(container)).toEqual(["p1"]);
    expect(document.querySelector(".box-chip-menu")).toBeNull();
  });

  it("the logo moves the window once the press travels, and only the caret opens the list", async () => {
    startWindowDrag.mockClear();
    useRootOverlayStore.setState({ open: false });
    useBoxesStore.setState({
      boxes: [box("boxA", ["p1"])],
      openBox: vi.fn(openBoxScope),
    });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
    });

    const container = await renderSwitcher();
    const logo = container.querySelector(".box-chip:not(.box-scope-pill) .box-chip-main") as HTMLElement;

    // Hovering the logo opens nothing.
    await act(async () => {
      fireEvent.mouseEnter(logo);
    });
    expect(document.querySelector(".box-chip-menu")).toBeNull();

    // Narrow down to boxA first; no click here is "All projects" any more.
    const menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "boxA"));
    });
    expect(pillNames(container)).toEqual(["p1"]);

    // A press that wobbles within the slop is not a move.
    await act(async () => {
      fireEvent.mouseDown(logo, { button: 0, clientX: 10, clientY: 10 });
      fireEvent.mouseMove(window, { clientX: 12, clientY: 11 });
    });
    expect(startWindowDrag).not.toHaveBeenCalled();

    // Past it, the OS move loop takes over and the trailing click is swallowed.
    await act(async () => {
      fireEvent.mouseMove(window, { clientX: 30, clientY: 10 });
      fireEvent.mouseUp(window);
      fireEvent.click(logo);
    });
    expect(startWindowDrag).toHaveBeenCalledTimes(1);
    expect(useRootOverlayStore.getState().open).toBe(false);

    // A later plain click opens the root console.
    await act(async () => {
      fireEvent.mouseDown(logo, { button: 0, clientX: 10, clientY: 10 });
      fireEvent.mouseUp(window);
      fireEvent.click(logo);
    });
    expect(startWindowDrag).toHaveBeenCalledTimes(1);
    expect(useRootOverlayStore.getState().open).toBe(true);
    expect(pillNames(container)).toEqual(["p1"]);
  });

  it("“All projects” hands the scope back to the project the strip was on", async () => {
    // Entering a box takes the scope with it; leaving must give it back, or the
    // strip shows every project while the tabs below are still the box's.
    const setActive = vi.fn(async (id: string | null) => {
      useTabsStore.setState({ scope: id ?? "root" });
    });
    useBoxesStore.setState({
      boxes: [box("boxA", ["p1"])],
      openBox: vi.fn(openBoxScope),
    });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: "p2",
      loaded: true,
      setActive,
    });
    useTabsStore.setState({ scope: "p2" });

    const container = await renderSwitcher();
    let menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "boxA"));
    });
    expect(useTabsStore.getState().scope).toBe("box:boxA");

    menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "All projects"));
    });
    // Re-activated even though `activeId` never changed — that is what moves
    // CenterPanel's scope back out of the box.
    expect(setActive).toHaveBeenCalledWith("p2");
    expect(useTabsStore.getState().scope).toBe("p2");
    expect(pillNames(container).sort()).toEqual(["p1", "p2"]);
  });

  it("a member opened from inside the slice is not what “All projects” returns to", async () => {
    // p2 was current in the whole-strip view; p1 was current in the BOX's view.
    const setActive = vi.fn(async (id: string | null) => {
      useTabsStore.setState({ scope: id ?? "root" });
    });
    useBoxesStore.setState({
      boxes: [box("boxA", ["p1"])],
      openBox: vi.fn(openBoxScope),
    });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: "p2",
      loaded: true,
      setActive,
    });
    useTabsStore.setState({ scope: "p2" });

    const container = await renderSwitcher();
    let menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "boxA"));
    });
    // Hop to a member, as clicking its pill does.
    await act(async () => {
      fireEvent.click(findPill(container, "p1").querySelector(".pill-main") as HTMLElement);
    });
    setActive.mockClear();

    menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "All projects"));
    });
    // Strip and tabs already agree on p1 — no second runtime switch.
    expect(setActive).not.toHaveBeenCalled();
    expect(useTabsStore.getState().scope).toBe("p1");
  });

  it("“All projects” falls back to root when the remembered project is closed", async () => {
    const setActive = vi.fn(async (id: string | null) => {
      useTabsStore.setState({ scope: id ?? "root" });
    });
    useBoxesStore.setState({
      boxes: [box("boxA", ["p1"])],
      openBox: vi.fn(openBoxScope),
    });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: "p2",
      loaded: true,
      setActive,
    });
    useTabsStore.setState({ scope: "p2" });

    const container = await renderSwitcher();
    let menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "boxA"));
    });
    await act(async () => {
      useProjectsStore.setState({
        projects: [proj("p1", 10), { ...proj("p2", 20), status: "inactive" }],
      });
    });

    menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "All projects"));
    });
    expect(setActive).toHaveBeenCalledWith(null);
    expect(useTabsStore.getState().scope).toBe("root");
  });

  it("gives every box a pill of its own beside the chip, in row order", async () => {
    // Boxes are switched by pointing, not by opening a list (user, 2026-09-22):
    // each stands on the row from the start, in its own colour, and picking
    // one only marks it as the slice being looked at.
    useBoxesStore.setState({
      boxes: [box("boxB", ["p2"], 6), box("boxA", ["p1"], 5)],
      openBox: vi.fn(openBoxScope),
    });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
    });

    const container = await renderSwitcher();
    expect(boxPillNames(container)).toEqual(["boxA", "boxB"]);
    // Nothing is selected yet, and the dropdown is not what lit anything.
    expect(container.querySelector(".box-scope-pill.is-selected")).toBeNull();
    // The colour is the box's own (hashed from its id) and travels inline, so
    // the CSS can tint the mark, the active line and the drop wash from it.
    const pillA = boxPill(container)!;
    expect(pillA.style.getPropertyValue("--box-color")).toBe(boxColor({ id: "boxA" }));
    // No member-count badge on the pill: the count is in the tooltip, and the
    // members themselves are one click away.
    expect(pillA.querySelector(".project-box-member-count")).toBeNull();
    expect(pillA.querySelector(".box-chip-main")?.getAttribute("title")).toContain("1 member");

    const menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "boxA"));
    });
    expect(pillA.className).toContain("is-selected");
    expect(pillA.className).toContain("active");
    expect(boxPillNames(container)).toEqual(["boxA", "boxB"]);
  });

  it("caps the row at MAX_BOX_PILLS, counts the rest on the caret, and always seats the selected box", async () => {
    const many = Array.from({ length: MAX_BOX_PILLS + 2 }, (_, i) =>
      box(`box${i}`, [], i + 1),
    );
    useBoxesStore.setState({ boxes: many, openBox: vi.fn(openBoxScope) });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });

    const container = await renderSwitcher();
    expect(boxPillNames(container)).toEqual(many.slice(0, MAX_BOX_PILLS).map((b) => b.name));
    // The count rides the logo's caret, the list's one trigger.
    expect(caretCount(container)!.textContent).toBe("+2");
    expect(container.querySelector(".box-fold-pill")).toBeNull();

    // Picking an overflow box from the dropdown seats it in the last slot —
    // the box being looked at is never the one without a pill.
    const menu = await openChipMenu(container);
    const last = many[many.length - 1];
    await act(async () => {
      fireEvent.click(menuRow(menu, last.name));
    });
    const names = boxPillNames(container);
    expect(names).toHaveLength(MAX_BOX_PILLS);
    expect(names.slice(0, MAX_BOX_PILLS - 1)).toEqual(
      many.slice(0, MAX_BOX_PILLS - 1).map((b) => b.name),
    );
    expect(names[MAX_BOX_PILLS - 1]).toBe(last.name);
    expect(container.querySelector(".box-scope-pill.is-selected")?.textContent).toContain(
      last.name,
    );
  });

  it("lets the dropdown choose which boxes stand on the row", async () => {
    useBoxesStore.setState({
      boxes: [box("boxA", [], 5), { ...box("boxB", [], 6), hide_pill: true }],
      openBox: vi.fn(openBoxScope),
    });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });

    const container = await renderSwitcher();
    // A hidden box has no pill, but the caret still counts it and the list has it.
    expect(boxPillNames(container)).toEqual(["boxA"]);
    expect(caretCount(container)!.textContent).toBe("+1");

    const menu = await openChipMenu(container);
    const pins = [...menu.querySelectorAll<HTMLElement>(".box-chip-menu-pin")];
    expect(pins.map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    await act(async () => {
      fireEvent.click(pins[1]);
    });
    expect(useBoxesStore.getState().boxes.find((b) => b.id === "boxB")?.hide_pill).toBeUndefined();
    expect(boxPillNames(container)).toEqual(["boxA", "boxB"]);
    // Toggling is not picking: no box was entered, and the list stays open.
    expect(container.querySelector(".box-scope-pill.is-selected")).toBeNull();
    expect(document.querySelector(".box-chip-menu")).toBeTruthy();

    await act(async () => {
      fireEvent.click(menu.querySelectorAll<HTMLElement>(".box-chip-menu-pin")[0]);
    });
    expect(useBoxesStore.getState().boxes.find((b) => b.id === "boxA")?.hide_pill).toBe(true);
    expect(boxPillNames(container)).toEqual(["boxB"]);
  });

  it("paints a box in its picked colour, and the pill menu's Colour row sets it", async () => {
    useBoxesStore.setState({ boxes: [{ ...box("boxA", ["p1"], 5), color: "#123456" }] });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });

    const container = await renderSwitcher();
    expect(boxPill(container)!.style.getPropertyValue("--box-color")).toBe("#123456");

    await act(async () => {
      fireEvent.contextMenu(boxPill(container)!);
    });
    const ctx = document.querySelector(".box-pill-menu") as HTMLElement;
    await act(async () => {
      fireEvent.click(ctx.querySelector('[aria-label="Green"]')!);
    });
    expect(useBoxesStore.getState().boxes[0].color).toBe("#59b96a");
    expect(boxPill(container)!.style.getPropertyValue("--box-color")).toBe("#59b96a");

    // Automatic drops the stored colour and goes back to the hashed one.
    await act(async () => {
      fireEvent.click(ctx.querySelector('[aria-label="Automatic colour"]')!);
    });
    expect("color" in useBoxesStore.getState().boxes[0]).toBe(false);
    expect(boxPill(container)!.style.getPropertyValue("--box-color")).toBe(
      boxColor({ id: "boxA" }),
    );
  });

  it("member pills wear one swatch per box, named after the box", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"], 5), box("boxB", ["p1"], 6)] });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
    });

    const container = await renderSwitcher();
    const badge = findPill(container, "p1").querySelector(".project-pill-boxdot")!;
    const swatches = [...badge.querySelectorAll(".project-pill-box-swatch")];
    expect(swatches.map((s) => s.getAttribute("data-box-name"))).toEqual(["boxA", "boxB"]);
    expect(badge.getAttribute("title")).toContain("boxA, boxB");
    expect(findPill(container, "p2").querySelector(".project-pill-box-swatch")).toBeNull();
  });

  it("the box pill's menu is a members checklist that toggles on the spot and stays open", async () => {
    const addToBox = vi.fn().mockResolvedValue(undefined);
    const removeFromBox = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({ boxes: [box("boxA", ["p2"])], addToBox, removeFromBox });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
    });

    const container = await renderSwitcher();
    await act(async () => {
      fireEvent.contextMenu(boxPill(container)!);
    });
    const ctx = document.querySelector(".box-pill-menu") as HTMLElement;
    expect(ctx).toBeTruthy();
    // Members first, then the rest.
    const rows = [...ctx.querySelectorAll("[data-member-id]")] as HTMLElement[];
    expect(rows.map((r) => r.getAttribute("data-member-id"))).toEqual(["p2", "p1"]);
    // A ticked box draws two paths (frame + tick); an empty one just the frame.
    expect(rows[0].querySelectorAll(".context-menu-checkmark svg path").length).toBe(1);
    expect(rows[1].querySelectorAll(".context-menu-checkmark svg path").length).toBe(0);

    await act(async () => {
      fireEvent.click(rows[1]);
    });
    expect(addToBox).toHaveBeenCalledWith("p1", "boxA");
    // Adding three projects is three clicks, not three right-clicks.
    expect(document.querySelector(".box-pill-menu")).toBeTruthy();

    await act(async () => {
      fireEvent.click(rows[0]);
    });
    expect(removeFromBox).toHaveBeenCalledWith("p2", "boxA");
  });

  it("clicking the box pill re-enters the box scope without a menu", async () => {
    const openBox = vi.fn(openBoxScope);
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])], openBox });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
    });

    const container = await renderSwitcher();
    const menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "boxA"));
    });
    // Leave the box scope for one of its members, the way clicking a member pill does.
    await act(async () => {
      useTabsStore.setState({ scope: "p1" });
    });
    expect(boxPill(container)!.className).not.toContain("active");
    openBox.mockClear();

    await act(async () => {
      fireEvent.click(boxPill(container)!.querySelector(".box-chip-main") as HTMLElement);
    });

    expect(openBox).toHaveBeenCalledWith("boxA");
    expect(boxPill(container)!.className).toContain("active");
    // The click opened no dropdown — the pill is a destination, not a picker.
    expect(document.querySelector(".box-chip-menu")).toBeNull();
  });

  it("the box pill carries the box's own menu and drop target", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])], openBox: vi.fn(openBoxScope) });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
    });

    const container = await renderSwitcher();
    const menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "boxA"));
    });

    // "Into the box I am looking at" is a drop on the pill now, not the chip.
    expect(boxPill(container)!.getAttribute("data-box-id")).toBe("boxA");
    expect(chip(container)!.getAttribute("data-box-id")).toBeNull();

    await act(async () => {
      fireEvent.contextMenu(boxPill(container)!);
    });
    const ctx = document.querySelector(".context-menu") as HTMLElement;
    expect(ctx).toBeTruthy();
    expect(ctx.textContent).toContain("Rename");
    // One name for the action everywhere: it dissolves the grouping, nothing else.
    expect(ctx.textContent).toContain("Dissolve box…");
    expect(ctx.textContent).not.toContain("Delete box");
  });

  it("a slice never hides the project in scope, member or not", async () => {
    // The strip that hides the project you are working in is the strip that has
    // lost you — so the scoped project rides along with the slice.
    useBoxesStore.setState({
      boxes: [box("boxA", ["p1"])],
      openBox: vi.fn(openBoxScope),
    });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
    });

    const container = await renderSwitcher();
    const menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "boxA"));
    });
    expect(pillNames(container)).toEqual(["p1"]);

    await act(async () => {
      useTabsStore.setState({ scope: "p2" });
    });
    expect(pillNames(container)).toEqual(["p1", "p2"]);
  });

  it("entering a box scope by another door selects that slice", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])] });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
    });

    const container = await renderSwitcher();
    expect(pillNames(container).sort()).toEqual(["p1", "p2"]);

    await act(async () => {
      useTabsStore.setState({ scope: "box:boxA" });
    });
    expect(pillNames(container)).toEqual(["p1"]);
    // The box's scope is the current one, so ITS pill wears the active
    // treatment — the chip only lights up for root now.
    expect(boxPill(container)!.className).toContain("active");
    expect(chip(container)!.className).not.toContain("active");
  });

  it("a dissolved box takes its slice with it", async () => {
    useBoxesStore.setState({
      boxes: [box("boxA", ["p1"])],
      openBox: vi.fn(openBoxScope),
    });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
    });

    const container = await renderSwitcher();
    const menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "boxA"));
    });
    expect(pillNames(container)).toEqual(["p1"]);

    await act(async () => {
      useBoxesStore.setState({ boxes: [] });
    });
    expect(pillNames(container).sort()).toEqual(["p1", "p2"]);
    // The chip itself stays — it is root's home too — it just names
    // no box any more.
    expect(chip(container)).toBeTruthy();
    expect(chip(container)!.textContent).not.toContain("boxA");
  });

  it("a pill drag springs the box list open and each row is a drop target", async () => {
    // The strip can be sliced, so the pill being dragged is usually not one of
    // the target box's own members — with the list folded away there would be
    // nothing to aim at. p2 is already in boxB: the drop on boxA is ADDITIVE
    // and must not touch that membership.
    const addToBox = vi.fn().mockResolvedValue(undefined);
    const reorderProjects = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({
      boxes: [box("boxA", ["p1"], 5), box("boxB", ["p2"], 6)],
      addToBox,
    });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
      reorderProjects,
    });

    const container = await renderSwitcher();
    const p2Pill = findPill(container, "p2");
    layOut(p2Pill, { left: 0, right: 50, top: 0, bottom: 40 });
    // boxA's own pill is the target — no list has to open first, since every
    // box already stands on the row.
    const target = container.querySelector('.box-scope-pill[data-box-id="boxA"]') as HTMLElement;
    expect(target).toBeTruthy();
    layOut(target, { left: 100, right: 160, top: 0, bottom: 40 });

    pointer("pointerdown", 10, 10, p2Pill);
    pointer("pointermove", 60, 10, window);
    // With every box on the row, a drag springs no list.
    expect(document.querySelector(".box-chip-menu")).toBeNull();

    pointer("pointermove", 130, 20, window);
    expect(target.className).toContain("drag-over");
    pointer("pointerup", 130, 20, window);

    expect(addToBox).toHaveBeenCalledWith("p2", "boxA");
    expect(reorderProjects).not.toHaveBeenCalled();
  });

  it("springs the list open under a drag only for the boxes that have no pill", async () => {
    const addToBox = vi.fn().mockResolvedValue(undefined);
    const many = Array.from({ length: MAX_BOX_PILLS + 1 }, (_, i) =>
      box(`box${i}`, [], i + 1),
    );
    useBoxesStore.setState({ boxes: many, addToBox });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
      reorderProjects: vi.fn().mockResolvedValue(undefined),
    });

    const container = await renderSwitcher();
    const p2Pill = findPill(container, "p2");
    layOut(p2Pill, { left: 0, right: 50, top: 0, bottom: 40 });
    const overflowBox = many[many.length - 1];

    pointer("pointerdown", 10, 10, p2Pill);
    pointer("pointermove", 60, 10, window);
    const row = document.querySelector(
      `.box-chip-menu [data-box-id="${overflowBox.id}"]`,
    ) as HTMLElement;
    expect(row).toBeTruthy();
    layOut(row, { left: 100, right: 260, top: 40, bottom: 68 });

    pointer("pointermove", 180, 50, window);
    pointer("pointerup", 180, 50, window);

    expect(addToBox).toHaveBeenCalledWith("p2", overflowBox.id);
    // …and the sprung list folds back once the drag is over.
    expect(document.querySelector(".box-chip-menu")).toBeNull();
  });

  it("alt-dropping a pill onto another boxes the two via boxProjects", async () => {
    const created = box("newBox", ["p2", "p1"]);
    const boxProjects = vi.fn(async () => {
      useBoxesStore.setState({ boxes: [created] });
      return created;
    });
    const reorderProjects = vi.fn().mockResolvedValue(undefined);
    useBoxEditorStore.getState().stopRename();
    useBoxesStore.setState({ boxes: [], boxProjects, openBox: vi.fn(async () => {}) });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
      reorderProjects,
    });

    const container = await renderSwitcher();
    const p1Pill = findPill(container, "p1");
    const p2Pill = findPill(container, "p2");
    layOut(p1Pill, { left: 0, right: 50, top: 0, bottom: 40 });
    layOut(p2Pill, { left: 100, right: 150, top: 0, bottom: 40 });

    await act(async () => {
      pointer("pointerdown", 10, 10, p1Pill);
      pointer("pointermove", 120, 10, window, { altKey: true });
      pointer("pointerup", 120, 10, window, { altKey: true });
    });

    expect(boxProjects).toHaveBeenCalledWith(["p2", "p1"], { name: "Box 1" });
    expect(reorderProjects).not.toHaveBeenCalled();
    // The gesture has no name prompt, so the new box's pill goes straight into
    // inline rename (and the box is entered, so that pill stands on the row).
    expect(useBoxEditorStore.getState().renamingId).toBe("newBox");
    expect(useBoxSliceStore.getState().sliceBoxId).toBe("newBox");
  });

  it("an alt-drop the backend refuses by name says why instead of failing silently", async () => {
    const boxProjects = vi.fn().mockRejectedValue(new BoxNameError("taken"));
    useBoxesStore.setState({ boxes: [], boxProjects });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
      switchToast: null,
      reorderProjects: vi.fn().mockResolvedValue(undefined),
    });

    const container = await renderSwitcher();
    const p1Pill = findPill(container, "p1");
    const p2Pill = findPill(container, "p2");
    layOut(p1Pill, { left: 0, right: 50, top: 0, bottom: 40 });
    layOut(p2Pill, { left: 100, right: 150, top: 0, bottom: 40 });

    await act(async () => {
      pointer("pointerdown", 10, 10, p1Pill);
      pointer("pointermove", 120, 10, window, { altKey: true });
      pointer("pointerup", 120, 10, window, { altKey: true });
    });

    expect(useProjectsStore.getState().switchToast).toBe("A box with that name already exists.");
  });

  it("a plain (no-alt) drop onto a pill still reorders, not box", async () => {
    const boxProjects = vi.fn().mockResolvedValue(null);
    const reorderProjects = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({ boxes: [], boxProjects });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
      reorderProjects,
    });

    const container = await renderSwitcher();
    const p1Pill = findPill(container, "p1");
    const p2Pill = findPill(container, "p2");
    layOut(p1Pill, { left: 0, right: 50, top: 0, bottom: 40 });
    layOut(p2Pill, { left: 100, right: 150, top: 0, bottom: 40 });

    await act(async () => {
      pointer("pointerdown", 10, 10, p1Pill);
      // Past p2's midpoint (125): with only these two pills, p1 landing
      // "after" p2 is the only real move available (it's already right
      // before p2), so the cursor must clear the midpoint to signal it.
      pointer("pointermove", 140, 10, window);
      pointer("pointerup", 140, 10, window);
    });

    expect(reorderProjects).toHaveBeenCalledWith("p1", "p2");
    expect(boxProjects).not.toHaveBeenCalled();
  });

  it("dropping into the gap between two OTHER pills lands there, not one further right", async () => {
    // Regression: landing "before OTHERS[k]" by targeting OTHERS[k] directly
    // is only correct when OTHERS[k] sat to the LEFT of the dragged pill's
    // start position; when it sat to the right, `onReorder` lands the pill
    // AFTER that target, one slot further than intended — the reported bug.
    const reorderProjects = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({ boxes: [] });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20), proj("p3", 30)],
      activeId: null,
      loaded: true,
      reorderProjects,
    });

    const container = await renderSwitcher();
    const p1Pill = findPill(container, "p1");
    const p2Pill = findPill(container, "p2");
    const p3Pill = findPill(container, "p3");
    layOut(p1Pill, { left: 0, right: 50, top: 0, bottom: 40 });
    layOut(p2Pill, { left: 100, right: 150, top: 0, bottom: 40 });
    layOut(p3Pill, { left: 200, right: 250, top: 0, bottom: 40 });

    await act(async () => {
      pointer("pointerdown", 10, 10, p1Pill);
      // Past p2's midpoint (125) but well before p3's (225) — the gap
      // between p2 and p3, not "onto" either.
      pointer("pointermove", 180, 10, window);
      pointer("pointerup", 180, 10, window);
    });

    // p1 lands between p2 and p3 — i.e. immediately AFTER p2 — not after p3.
    expect(reorderProjects).toHaveBeenCalledWith("p1", "p2");
  });
});

/**
 * Where a box's working / waiting / finished bars are drawn. A `box:<id>` scope
 * holds ordinary tabs running the same agents a project's do, so a box must be
 * able to say it wants something — but NOT from the picker chip (user,
 * 2026-09-07): that control is too short for a strip. The two surfaces with the
 * room carry it instead — the selected box's own pill, and the dropdown rows,
 * which are the only enumeration of the boxes.
 */
describe("box chip status bars", () => {
  /** A box scope with one agent tab, in the state the strip should draw. */
  function seedBoxTab(boxId: string, key: string, state: "working" | "needs-decision" | "finished") {
    useTabsStore.setState((s) => ({
      tabsByScope: {
        ...s.tabsByScope,
        [`box:${boxId}`]: [{ key, label: key, cmd: "claude", cwd: "/b", kind: "agent" }],
      },
    }));
    useActivityStore.setState((s) => ({
      statusTabsByScope: { ...s.statusTabsByScope, [`box:${boxId}`]: [{ key, state }] },
    }));
  }

  function bars(container: HTMLElement): HTMLElement[] {
    return [
      ...container.querySelectorAll(".box-chip:not(.box-scope-pill) .pill-status-bar"),
    ] as HTMLElement[];
  }

  function pillBars(container: HTMLElement): HTMLElement[] {
    return [...container.querySelectorAll(".box-scope-pill .pill-status-bar")] as HTMLElement[];
  }

  beforeEach(() => {
    useTabsStore.setState({ tabsByScope: {}, layoutByScope: {} });
    useActivityStore.setState({ statusTabsByScope: {}, statusCountsByScope: {} });
  });

  it("keeps the picker chip itself bare", async () => {
    // The chip is an icon, a word and a caret — no room for a band of bars
    // across its bottom edge, however many boxes it could speak for.
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"]), box("boxB", [])] });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });
    seedBoxTab("boxA", "agent-1", "needs-decision");
    seedBoxTab("boxB", "agent-2", "working");

    const container = await renderSwitcher();
    expect(bars(container)).toHaveLength(0);
    // Not lost, only moved: the list is one hover away and names both boxes.
    const menu = await openChipMenu(container);
    expect([...menu.querySelectorAll(".pill-status-bar")].map((b) => b.className)).toEqual([
      "pill-status-bar needs-decision static",
      "pill-status-bar working static",
    ]);
  });

  it("a bar on the box pill opens its own box's tab", async () => {
    const openBox = vi.fn(openBoxScope);
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])], openBox });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });
    seedBoxTab("boxA", "agent-1", "needs-decision");

    const container = await renderSwitcher();
    const menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "boxA"));
    });
    // The slice is a view, not the scope: the pill keeps naming boxA while the
    // user works in one of its projects, which is exactly when a bar has
    // somewhere to take them.
    await act(async () => {
      useTabsStore.setState({ scope: "p1" });
    });
    openBox.mockClear();

    await act(async () => {
      fireEvent.click(pillBars(container)[0]);
    });
    expect(openBox).toHaveBeenCalledWith("boxA");
  });

  it("each box reports on its own pill, and nowhere twice", async () => {
    useBoxesStore.setState({
      boxes: [box("boxA", ["p1"], 5), box("boxB", [], 6)],
      openBox: vi.fn(openBoxScope),
    });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });
    seedBoxTab("boxA", "agent-1", "needs-decision");
    seedBoxTab("boxB", "agent-2", "working");

    const container = await renderSwitcher();

    // Every box has a pill, so every box's strip is on its own pill —
    // unprefixed, because the pill names the box — while the chip beside
    // them stays bare.
    const perPill = [...container.querySelectorAll(".box-scope-pill")].map((p) =>
      [...p.querySelectorAll(".pill-status-bar")].map((b) => b.className),
    );
    expect(perPill).toEqual([["pill-status-bar needs-decision"], ["pill-status-bar working"]]);
    const drawn = pillBars(container);
    expect(drawn[0].getAttribute("aria-label")).toContain("agent-1");
    expect(drawn[0].getAttribute("aria-label")).not.toContain("boxA ·");
    expect(bars(container)).toHaveLength(0);
  });

  it("gives each dropdown row its own inert strip", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"]), box("boxB", [])] });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });
    seedBoxTab("boxA", "agent-1", "finished");

    const container = await renderSwitcher();
    const menu = await openChipMenu(container);
    const rowA = menuRow(menu, "boxA");
    const rowB = menuRow(menu, "boxB");
    const rowBars = [...rowA.querySelectorAll(".pill-status-bar")];
    expect(rowBars).toHaveLength(1);
    // Spans, not buttons: the row IS a button, and a button inside one is
    // invalid markup.
    expect(rowBars[0].tagName).toBe("SPAN");
    expect(rowBars[0].className).toContain("finished");
    // A box with nothing running draws no strip at all.
    expect(rowB.querySelector(".pill-status-bars")).toBeNull();
  });
});

/** The ✕ on the selected box pill. */
function leaveButton(container: HTMLElement): HTMLElement | null {
  return container.querySelector(".box-pill-leave");
}

describe("header access: the way out of a box (AS2a)", () => {
  function seedTwoBoxes(setActive = vi.fn()) {
    useBoxesStore.setState({
      boxes: [box("boxA", ["p1"], 5), box("boxB", ["p2"], 6)],
      openBox: vi.fn(openBoxScope),
    });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20), proj("p3", 30)],
      activeId: "p3",
      loaded: true,
      setActive,
    });
  }

  it("wears an always-visible ✕ on the selected pill only", async () => {
    seedTwoBoxes();
    const container = await renderSwitcher();
    // Nothing selected: no ✕ anywhere.
    expect(leaveButton(container)).toBeNull();

    const menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "boxA"));
    });
    const pills = [...container.querySelectorAll(".box-scope-pill")];
    expect(pills[0].querySelector(".box-pill-leave")).toBeTruthy();
    expect(pills[1].querySelector(".box-pill-leave")).toBeNull();
    expect(container.querySelectorAll(".box-pill-leave")).toHaveLength(1);
    expect(leaveButton(container)!.getAttribute("title")).toBe("Show all projects (leave “boxA”)");
  });

  it("the ✕ clears the slice and hands the scope back to the project the strip was on", async () => {
    const setActive = vi.fn(async (id: string | null) => {
      useTabsStore.setState({ scope: id ?? "root" });
    });
    seedTwoBoxes(setActive);
    useTabsStore.setState({ scope: "p3" });
    const container = await renderSwitcher();
    const menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "boxA"));
    });
    expect(pillNames(container)).toEqual(["p1"]);

    await act(async () => {
      fireEvent.click(leaveButton(container)!);
    });
    expect(setActive).toHaveBeenCalledWith("p3");
    expect(useTabsStore.getState().scope).toBe("p3");
    expect(pillNames(container).sort()).toEqual(["p1", "p2", "p3"]);
    expect(container.querySelector(".box-scope-pill.is-selected")).toBeNull();
    expect(leaveButton(container)).toBeNull();
    // Entering the box did not route through the pill's own click: the ✕ is not "select".
    expect(document.querySelector(".box-chip-menu")).toBeNull();
  });

  it("the ✕ stays while a member is being visited, and clears just the slice there", async () => {
    const setActive = vi.fn(async (id: string | null) => {
      useTabsStore.setState({ scope: id ?? "root" });
    });
    seedTwoBoxes(setActive);
    const container = await renderSwitcher();
    const menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "boxA"));
    });
    await act(async () => {
      fireEvent.click(findPill(container, "p1").querySelector(".pill-main") as HTMLElement);
    });
    expect(useTabsStore.getState().scope).toBe("p1");
    expect(leaveButton(container)).toBeTruthy();
    setActive.mockClear();

    await act(async () => {
      fireEvent.click(leaveButton(container)!);
    });
    // Strip and tabs already agree: no second runtime switch, the strip is whole again.
    expect(setActive).not.toHaveBeenCalled();
    expect(pillNames(container).sort()).toEqual(["p1", "p2", "p3"]);
  });

  it("tints the strip in the box colour while a slice is selected, and not otherwise", async () => {
    seedTwoBoxes();
    const container = await renderSwitcher();
    const region = container.querySelector(".project-pills-region") as HTMLElement;
    expect(region.className).not.toContain("is-sliced");

    const menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "boxB"));
    });
    expect(region.className).toContain("is-sliced");
    expect(region.style.getPropertyValue("--slice-color")).toBe(boxColor({ id: "boxB" }));

    await act(async () => {
      fireEvent.click(leaveButton(container)!);
    });
    expect(region.className).not.toContain("is-sliced");
    expect(region.style.getPropertyValue("--slice-color")).toBe("");
  });

  it("marks the scope box with a ✓ and the sliced box in bold — two marks for two states", async () => {
    seedTwoBoxes(
      vi.fn(async (id: string | null) => {
        useTabsStore.setState({ scope: id ?? "root" });
      }),
    );
    const container = await renderSwitcher();
    let menu = await openChipMenu(container);
    expect(menu.querySelector(".box-chip-menu-scope")).toBeNull();
    await act(async () => {
      fireEvent.click(menuRow(menu, "boxA"));
    });

    // In the box: scope AND slice on the same row.
    menu = await openChipMenu(container);
    const rowA = menuRow(menu, "boxA");
    expect(rowA.className).toContain("is-slice");
    expect(rowA.className).toContain("is-scope");
    expect(rowA.querySelector(".box-chip-menu-scope")).toBeTruthy();
    expect(menuRow(menu, "boxB").className).not.toContain("is-slice");
    expect(menu.querySelectorAll(".box-chip-menu-scope")).toHaveLength(1);

    // Visiting a member: the slice stays (bold), the scope has left (no ✓).
    await act(async () => {
      fireEvent.click(findPill(container, "p1").querySelector(".pill-main") as HTMLElement);
    });
    menu = await openChipMenu(container);
    const visiting = menuRow(menu, "boxA");
    expect(visiting.className).toContain("is-slice");
    expect(visiting.className).not.toContain("is-scope");
    expect(menu.querySelector(".box-chip-menu-scope")).toBeNull();
  });
});

describe("header access: the caret opens on click as well as on hover (AS2a)", () => {
  function seed() {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])], openBox: vi.fn(openBoxScope) });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });
  }

  it("a click pins the list open past the pointer leaving; a second click closes it", async () => {
    seed();
    const container = await renderSwitcher();
    const caret = container.querySelector(".box-chip-caret-btn") as HTMLElement;
    expect(document.querySelector(".box-chip-menu")).toBeNull();

    // Keyboard/touch path: no hover at all, a click alone opens it.
    await act(async () => {
      fireEvent.click(caret);
    });
    expect(document.querySelector(".box-chip-menu")).toBeTruthy();
    expect(caret.getAttribute("aria-expanded")).toBe("true");

    vi.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.mouseLeave(caret);
        vi.advanceTimersByTime(3000);
      });
      expect(document.querySelector(".box-chip-menu")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }

    await act(async () => {
      fireEvent.click(caret);
    });
    expect(document.querySelector(".box-chip-menu")).toBeNull();
  });

  it("a hover-opened list still folds away on leaving, and a click on it keeps it", async () => {
    seed();
    const container = await renderSwitcher();
    const caret = container.querySelector(".box-chip-caret-btn") as HTMLElement;
    vi.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.mouseEnter(caret);
      });
      expect(document.querySelector(".box-chip-menu")).toBeTruthy();
      await act(async () => {
        fireEvent.mouseLeave(caret);
        vi.advanceTimersByTime(3000);
      });
      expect(document.querySelector(".box-chip-menu")).toBeNull();

      // Hover, then click: the click keeps what the hover opened (not a toggle shut).
      await act(async () => {
        fireEvent.mouseEnter(caret);
        fireEvent.click(caret);
      });
      await act(async () => {
        fireEvent.mouseLeave(caret);
        vi.advanceTimersByTime(3000);
      });
      expect(document.querySelector(".box-chip-menu")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Escape closes a pinned list", async () => {
    seed();
    const container = await renderSwitcher();
    await act(async () => {
      fireEvent.click(container.querySelector(".box-chip-caret-btn") as HTMLElement);
    });
    expect(document.querySelector(".box-chip-menu")).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(document.querySelector(".box-chip-menu")).toBeNull();
  });
});

describe("header access: the width-tier pill budget and the caret's count (AS2a)", () => {
  const eight = () => Array.from({ length: 8 }, (_, i) => box(`box${i}`, [], i + 1));

  function seed(boxes: ProjectBox[]) {
    useBoxesStore.setState({ boxes, openBox: vi.fn(openBoxScope) });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });
  }

  it("holds 6 pills on tiers 0 and 1, 3 on tier 2 and only the selected box on tier 3", async () => {
    for (const [tier, expected] of [
      [0, 6],
      [1, 6],
      [2, 3],
      [3, 0],
    ] as const) {
      seed(eight());
      const container = await renderSwitcher(tier);
      expect(boxPillNames(container)).toHaveLength(expected);
      // The rest are counted on the logo's caret (`▾ +N`, bare N with no pill).
      expect(caretCount(container)!.textContent).toBe(expected === 0 ? "8" : `+${8 - expected}`);
      cleanup();
      resetBoxSlice();
    }
  });

  it("keeps the selected box on the row at every tier, in its own place", async () => {
    seed(eight());
    useBoxesStore.setState({ boxes: eight() });
    const container = await renderSwitcher(3);
    // Select box5 through the list.
    await act(async () => {
      fireEvent.click(container.querySelector(".box-chip-caret-btn") as HTMLElement);
    });
    await act(async () => {
      fireEvent.click(menuRow(document.querySelector(".box-chip-menu") as HTMLElement, "box5"));
    });
    expect(boxPillNames(container)).toEqual(["box5"]);
    expect(leaveButton(container)).toBeTruthy();
    expect(caretCount(container)!.textContent).toBe("+7");
  });

  it("shows no count when every box has its pill", async () => {
    seed([box("boxA", [], 1), box("boxB", [], 2)]);
    const container = await renderSwitcher(2);
    expect(boxPillNames(container)).toEqual(["boxA", "boxB"]);
    expect(caretCount(container)).toBeNull();
  });

  it("opens the one list under the logo, whatever overflows: no second trigger on the row", async () => {
    seed(eight());
    const container = await renderSwitcher(2);
    expect(container.querySelector(".box-fold-pill")).toBeNull();
    expect(container.querySelectorAll(".box-chip-caret-btn")).toHaveLength(1);
    const caret = container.querySelector(".box-chip-caret-btn") as HTMLElement;
    layOut(chip(container)!, { left: 12, right: 60, top: 0, bottom: 40 });

    await act(async () => {
      fireEvent.mouseEnter(caret);
    });
    const menu = document.querySelector(".box-chip-menu") as HTMLElement;
    expect(menu).toBeTruthy();
    expect(menu.style.left).toBe("12px");
    expect(caret.getAttribute("aria-expanded")).toBe("true");
    // Every box, shown or not.
    expect(menu.querySelectorAll(".box-chip-menu-row")).toHaveLength(8);
    cleanup();
  });
});

describe("member pill swatches open their box", () => {
  const dot = (container: HTMLElement, name: string) =>
    findPill(container, name).querySelector(".project-pill-boxdot") as HTMLElement;

  it("a click on a single-box member's swatch opens that box, and does not activate the project", async () => {
    const openBox = vi.fn().mockImplementation(openBoxScope);
    const setActive = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])], openBox });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
      setActive,
    });
    const container = await renderSwitcher();

    await act(async () => {
      fireEvent.click(dot(container, "p1"));
    });
    expect(openBox).toHaveBeenCalledWith("boxA");
    expect(setActive).not.toHaveBeenCalled();
    // The slice follows: the strip now shows the box's members only.
    expect(useBoxSliceStore.getState().sliceBoxId).toBe("boxA");
    expect(pillNames(container)).toEqual(["p1"]);
  });

  it("the press on the swatch does not start a pill drag", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])], openBox: vi.fn() });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
    });
    const container = await renderSwitcher();
    const target = dot(container, "p1");
    layOut(findPill(container, "p1"), { left: 0, right: 80, top: 0, bottom: 24 });
    pointer("pointerdown", 40, 12, target);
    pointer("pointermove", 120, 12, window);
    expect(usePillDragStore.getState().drag).toBeNull();
  });

  it("a member of several boxes gets a list of them, and a pick opens that box", async () => {
    const openBox = vi.fn().mockImplementation(openBoxScope);
    const setActive = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({
      boxes: [box("boxA", ["p1"], 5), box("boxB", ["p1"], 6), box("boxC", ["p2"], 7)],
      openBox,
    });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
      setActive,
    });
    const container = await renderSwitcher();

    await act(async () => {
      fireEvent.click(dot(container, "p1"));
    });
    expect(openBox).not.toHaveBeenCalled();
    const menu = document.querySelector(".project-pill-box-menu") as HTMLElement;
    expect(menu).toBeTruthy();
    // Only this project's boxes, each with its swatch in the box colour.
    const rows = [...menu.querySelectorAll("button")];
    expect(rows.map((b) => b.textContent)).toEqual(["boxA", "boxB"]);
    expect(rows.every((b) => b.querySelector(".context-menu-box-swatch"))).toBe(true);

    await act(async () => {
      fireEvent.click(rows[1]);
    });
    expect(openBox).toHaveBeenCalledWith("boxB");
    expect(setActive).not.toHaveBeenCalled();
    expect(document.querySelector(".project-pill-box-menu")).toBeNull();
  });

  it("the hit area is a padded button-role span, not the bare 10 px swatch", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])] });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });
    const container = await renderSwitcher();
    const el = dot(container, "p1");
    expect(el.getAttribute("role")).toBe("button");
    expect(el.classList.contains("is-link")).toBe(true);
    expect(el.getAttribute("title")).toContain("boxA");
  });

  it("the station badges number the sliced pills, inactive members included", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1", "p3"])] });
    useProjectsStore.setState({
      projects: [
        proj("p1", 10),
        { ...proj("p2", 20) },
        { ...proj("p3", 30), status: "inactive" },
      ],
      activeId: null,
      loaded: true,
    });
    useBoxSliceStore.setState({ sliceBoxId: "boxA" });
    const container = await renderSwitcher();
    act(() => {
      useKeyboardSteeringStore.getState().enter();
      useKeyboardSteeringStore.getState().setLevel("projects");
    });
    const badge = (name: string) =>
      findPill(container, name).querySelector(".steering-station-chip")?.textContent;
    expect(pillNames(container)).toEqual(["p1", "p3"]);
    expect(badge("p1")).toBe("2");
    expect(badge("p3")).toBe("3");
  });
});

describe("box pill menu — shared checklist, dissolve, rename check (AS5a)", () => {
  async function openBoxMenu(container: HTMLElement): Promise<HTMLElement> {
    await act(async () => {
      fireEvent.contextMenu(boxPill(container)!);
    });
    return document.querySelector(".box-pill-menu") as HTMLElement;
  }
  const rowOf = (ctx: HTMLElement, id: string) => ctx.querySelector(`[data-member-id="${id}"]`) as HTMLElement;
  const menuItem = (text: string) =>
    [...document.querySelectorAll(".box-pill-menu button")].find((b) => b.textContent?.includes(text)) as HTMLElement;

  beforeEach(() => {
    useBoxEditorStore.setState({ open: false, boxId: null, renamingId: null });
  });

  it("lists closed projects with a closed label and adds or removes them like any other", async () => {
    const addToBox = vi.fn().mockResolvedValue(undefined);
    const removeFromBox = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({ boxes: [box("boxA", ["old"])], addToBox, removeFromBox });
    useProjectsStore.setState({
      projects: [
        proj("p1", 10),
        { ...proj("old", 20), status: "inactive" },
        { ...proj("shelf", 30), status: "inactive" },
      ],
      activeId: null,
      loaded: true,
    });
    const container = await renderSwitcher();
    const ctx = await openBoxMenu(container);
    // Members first (the closed member too), then the rest — closed ones among them.
    expect([...ctx.querySelectorAll("[data-member-id]")].map((r) => r.getAttribute("data-member-id"))).toEqual([
      "old",
      "p1",
      "shelf",
    ]);
    expect(rowOf(ctx, "old").textContent).toContain("closed");
    expect(rowOf(ctx, "shelf").textContent).toContain("closed");
    expect(rowOf(ctx, "p1").textContent).not.toContain("closed");

    await act(async () => {
      fireEvent.click(rowOf(ctx, "shelf"));
    });
    expect(addToBox).toHaveBeenCalledWith("shelf", "boxA");
    await act(async () => {
      fireEvent.click(rowOf(ctx, "old"));
    });
    expect(removeFromBox).toHaveBeenCalledWith("old", "boxA");
    expect(document.querySelector(".box-pill-menu")).toBe(ctx);
  });

  it("never caps the rows, filters past 8 and keeps a ticked row where it is", async () => {
    const projects = Array.from({ length: 15 }, (_, i) => proj(`proj${String(i).padStart(2, "0")}`, i));
    useBoxesStore.setState({ boxes: [box("boxA", ["proj03"])] });
    useProjectsStore.setState({ projects, activeId: null, loaded: true });
    const container = await renderSwitcher();
    const ctx = await openBoxMenu(container);
    const ids = () => [...ctx.querySelectorAll("[data-member-id]")].map((r) => r.getAttribute("data-member-id"));
    expect(ids()).toHaveLength(15);
    expect(ids()[0]).toBe("proj03");
    expect(ctx.querySelector(".box-member-list")).toBeTruthy();
    expect(ctx.textContent).not.toContain("More projects under");

    const before = ids();
    await act(async () => {
      useBoxesStore.setState({ boxes: [box("boxA", ["proj03", "proj07"])] });
    });
    expect(ids()).toEqual(before);

    const filter = ctx.querySelector(".box-member-filter") as HTMLInputElement;
    expect(filter).toBeTruthy();
    fireEvent.change(filter, { target: { value: "proj1" } });
    expect(ids()).toEqual(["proj10", "proj11", "proj12", "proj13", "proj14"]);
  });

  it("has no filter on a short list", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", [])] });
    useProjectsStore.setState({ projects: [proj("p1", 1), proj("p2", 2)], activeId: null, loaded: true });
    const container = await renderSwitcher();
    const ctx = await openBoxMenu(container);
    expect(ctx.querySelector(".box-member-filter")).toBeNull();
  });

  it("Dissolve box… asks, and from inside the box leaves it before deleting", async () => {
    // `leaveBox` hands the scope back through `setActive` (the centre panel does
    // the rest), so "left first" = the slice is clear and `setActive` already ran.
    const setActive = vi.fn().mockResolvedValue(undefined);
    useProjectsStore.setState({ setActive });
    const seen: { slice: string | null; handedBack: number }[] = [];
    const deleteBox = vi.fn(async () => {
      seen.push({ slice: useBoxSliceStore.getState().sliceBoxId, handedBack: setActive.mock.calls.length });
    });
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])], deleteBox, openBox: vi.fn(openBoxScope) });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });
    const container = await renderSwitcher();
    const menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "boxA"));
    });
    expect(useTabsStore.getState().scope).toBe("box:boxA");

    await openBoxMenu(container);
    await act(async () => {
      fireEvent.click(menuItem("Dissolve box…"));
    });
    expect(deleteBox).not.toHaveBeenCalled();
    const question = await screen.findByRole("dialog", { name: "Dissolve box" });
    await act(async () => {
      fireEvent.click(within(question).getByRole("button", { name: "Dissolve box" }));
    });
    expect(deleteBox).toHaveBeenCalledWith("boxA");
    // By the time the box is deleted the slice is gone and the scope was handed back.
    expect(seen).toEqual([{ slice: null, handedBack: 1 }]);
  });

  it("a declined Dissolve changes nothing", async () => {
    const deleteBox = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({ boxes: [box("boxA", [])], deleteBox });
    const container = await renderSwitcher();
    await openBoxMenu(container);
    await act(async () => {
      fireEvent.click(menuItem("Dissolve box…"));
    });
    const question = await screen.findByRole("dialog", { name: "Dissolve box" });
    await act(async () => {
      fireEvent.click(within(question).getByRole("button", { name: "Cancel" }));
    });
    expect(deleteBox).not.toHaveBeenCalled();
  });

  async function startRenameFromMenu(container: HTMLElement): Promise<HTMLInputElement> {
    await openBoxMenu(container);
    await act(async () => {
      fireEvent.click(menuItem("Rename"));
    });
    return container.querySelector(".project-box-rename-input") as HTMLInputElement;
  }

  it("inline rename: a taken name keeps the field open with the reason on Enter", async () => {
    const renameBox = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({ boxes: [box("boxA", []), box("boxB", [], 6)], renameBox });
    const container = await renderSwitcher();
    const input = await startRenameFromMenu(container);
    expect(input.value).toBe("boxA");
    await act(async () => {
      fireEvent.change(input, { target: { value: "BOXB" } });
      fireEvent.keyDown(input, { key: "Enter" });
    });
    // Case-insensitive duplicate: refused, field still there, marked, reason on hover.
    const still = container.querySelector(".project-box-rename-input") as HTMLInputElement;
    expect(still).toBeTruthy();
    expect(still.getAttribute("aria-invalid")).toBe("true");
    expect(still.title).toBe("A box with that name already exists.");
    expect(renameBox).not.toHaveBeenCalled();

    // Typing clears the mark; a free name is written.
    await act(async () => {
      fireEvent.change(still, { target: { value: "Thesis" } });
    });
    expect(still.getAttribute("aria-invalid")).toBeNull();
    await act(async () => {
      fireEvent.keyDown(still, { key: "Enter" });
    });
    expect(renameBox).toHaveBeenCalledWith("boxA", "Thesis");
    expect(container.querySelector(".project-box-rename-input")).toBeNull();
  });

  it("inline rename: an empty name on Enter is refused, Escape backs out", async () => {
    const renameBox = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({ boxes: [box("boxA", [])], renameBox });
    const container = await renderSwitcher();
    const input = await startRenameFromMenu(container);
    await act(async () => {
      fireEvent.change(input, { target: { value: "   " } });
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect((container.querySelector(".project-box-rename-input") as HTMLElement).title).toBe("Give the box a name.");
    await act(async () => {
      fireEvent.keyDown(container.querySelector(".project-box-rename-input")!, { key: "Escape" });
    });
    expect(container.querySelector(".project-box-rename-input")).toBeNull();
    expect(renameBox).not.toHaveBeenCalled();
  });

  it("inline rename: walking away with a taken name drops it and says why", async () => {
    const renameBox = vi.fn().mockResolvedValue(undefined);
    useProjectsStore.setState({ switchToast: null });
    useBoxesStore.setState({ boxes: [box("boxA", []), box("boxB", [], 6)], renameBox });
    const container = await renderSwitcher();
    const input = await startRenameFromMenu(container);
    await act(async () => {
      fireEvent.change(input, { target: { value: "boxB" } });
      fireEvent.blur(input);
    });
    expect(container.querySelector(".project-box-rename-input")).toBeNull();
    expect(renameBox).not.toHaveBeenCalled();
    expect(useProjectsStore.getState().switchToast).toBe("A box with that name already exists.");
  });

  it("the box list's New Box row asks for a name and enters the new box", async () => {
    const created = box("boxNew", [], 1);
    const createBoxQuick = vi.fn(async () => created);
    const openBox = vi.fn(async () => {});
    useBoxesStore.setState({ boxes: [box("boxA", [])], createBoxQuick, openBox });
    const container = await renderSwitcher();
    const menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "New Box"));
    });
    expect(useBoxEditorStore.getState().open).toBe(false);
    const field = (await screen.findByRole("textbox")) as HTMLInputElement;
    expect(field.value).toBe("Box 1");
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(createBoxQuick).toHaveBeenCalledWith({ name: "Box 1", memberIds: [] });
    expect(openBox).toHaveBeenCalledWith("boxNew");
  });

  it("Edit boxes… opens the box you are in, else the first, and never create mode", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", [], 1), box("boxB", [], 2)], openBox: vi.fn(openBoxScope) });
    const container = await renderSwitcher();
    let menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "Edit boxes"));
    });
    expect(useBoxEditorStore.getState()).toMatchObject({ open: true, boxId: "boxA" });

    useBoxEditorStore.getState().close();
    await act(async () => {
      useBoxSliceStore.setState({ sliceBoxId: "boxB" });
    });
    menu = await openChipMenu(container);
    await act(async () => {
      fireEvent.click(menuRow(menu, "Edit boxes"));
    });
    expect(useBoxEditorStore.getState()).toMatchObject({ open: true, boxId: "boxB" });
  });

  it("with no box there is nothing to edit: the list has no Edit boxes… row", async () => {
    const container = await renderSwitcher();
    const menu = await openChipMenu(container);
    expect(menuRow(menu, "Edit boxes")).toBeUndefined();
    expect(menuRow(menu, "New Box")).toBeTruthy();
  });
});
