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
import { render, act, fireEvent } from "@testing-library/react";
import type { ProjectBox, ProjectEntry } from "../../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(null) }));
const startWindowDrag = vi.hoisted(() => vi.fn());
vi.mock("../../lib/window/startWindowDrag", () => ({ startWindowDrag }));

import { ProjectSwitcher } from "../../components/layout/ProjectSwitcher";
import { useProjectsStore } from "../../stores/projects";
import { BOX_SCOPE_PREFIX, useBoxesStore } from "../../stores/boxes";
import { usePillDragStore } from "../../stores/drag/pillDrag";
import { useTabsStore } from "../../stores/tabs";
import { useActivityStore } from "../../stores/activity";
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
  usePillDragStore.getState().end();
  useProjectsStore.setState({
    projects: [],
    activeId: null,
    loaded: true,
    setActive: realSetActive,
  });
  useBoxesStore.setState({ boxes: [], loaded: true });
  useTabsStore.setState({ scope: "root" });
});

async function renderSwitcher() {
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<ProjectSwitcher open={true} />));
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
    // Naming the scope it is in: root, with the app's own mark.
    expect(chip(container)!.querySelector(".box-chip-star")).toBeTruthy();
    expect(chip(container)!.textContent).toContain("Root");
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

  it("clicking the chip itself is “All projects”", async () => {
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
    expect(pillNames(container).sort()).toEqual(["p1", "p2"]);
    expect(document.querySelector(".box-chip-menu")).toBeNull();
  });

  it("the logo moves the window once the press travels, and only the caret opens the list", async () => {
    startWindowDrag.mockClear();
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

    // Narrow down to boxA first, so a stray "All projects" click would show.
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
    expect(pillNames(container)).toEqual(["p1"]);

    // A later plain click is "All projects" again.
    await act(async () => {
      fireEvent.mouseDown(logo, { button: 0, clientX: 10, clientY: 10 });
      fireEvent.mouseUp(window);
      fireEvent.click(logo);
    });
    expect(startWindowDrag).toHaveBeenCalledTimes(1);
    expect(pillNames(container).sort()).toEqual(["p1", "p2"]);
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

  it("caps the row at MAX_BOX_PILLS, counts the rest on the chip, and always seats the selected box", async () => {
    const many = Array.from({ length: MAX_BOX_PILLS + 2 }, (_, i) =>
      box(`box${i}`, [], i + 1),
    );
    useBoxesStore.setState({ boxes: many, openBox: vi.fn(openBoxScope) });
    useProjectsStore.setState({ projects: [proj("p1", 10)], activeId: null, loaded: true });

    const container = await renderSwitcher();
    expect(boxPillNames(container)).toEqual(many.slice(0, MAX_BOX_PILLS).map((b) => b.name));
    expect(chip(container)!.textContent).toContain("+2");

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
    // A hidden box has no pill, but the chip still counts it and lists it.
    expect(boxPillNames(container)).toEqual(["boxA"]);
    expect(chip(container)!.textContent).toContain("+1");

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
    expect(ctx.textContent).toContain("Delete box");
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
    const boxProjects = vi.fn().mockResolvedValue(box("newBox", ["p2", "p1"]));
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
      pointer("pointermove", 120, 10, window, { altKey: true });
      pointer("pointerup", 120, 10, window, { altKey: true });
    });

    expect(boxProjects).toHaveBeenCalledWith(["p2", "p1"], { name: "New Box" });
    expect(reorderProjects).not.toHaveBeenCalled();
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
