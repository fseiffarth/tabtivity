/**
 * Steering inside the side panel, rows first (`lib/shortcuts/steeringSidePanel`):
 * B lands in the list, ↑/↓ go a line at a time without wrapping, ←/→ go along a
 * row / into a folder and back out / between views, the number keys switch
 * views, Enter opens a file as a double-click and takes steering to its tab.
 *
 * The panel here is a small stand-in with the real panel's markup where the
 * keys look (view tabs with `data-view`, a focusable `.file-tree` holding a
 * breadcrumb and `.file-entry` rows, `.side-panel-scroll`): the real one pulls
 * in the whole app. jsdom has no layout, so every element's box comes from its
 * `data-y` / `data-h`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useState, useSyncExternalStore } from "react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: vi.fn().mockResolvedValue(false),
    setFullscreen: vi.fn(),
  }),
}));

import { useKeyboard } from "../../hooks/useKeyboard";
import { SideViewKey } from "../../components/files/SideViewKey";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useTabsStore } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { useProjectsStore } from "../../stores/projects";
import { clearRegionCursor, forgetRegionCursors, regionCursor } from "../../lib/shortcuts/steeringRegion";
import { forgetSidePanelRows } from "../../lib/shortcuts/steeringSidePanel";
import type { Settings } from "../../types";

// ── The stand-in panel ───────────────────────────────────────────────────

const VIEWS = ["files", "git", "windows"] as const;
type View = (typeof VIEWS)[number];

interface Entry {
  name: string;
  dir?: boolean;
  zip?: boolean;
  /** A button on the row, like the sync arrow. */
  button?: boolean;
}

const LISTING: Record<string, Entry[]> = {
  "": [
    { name: "docs", dir: true },
    { name: "empty", dir: true },
    { name: "a.txt", button: true },
    { name: "b.zip", zip: true },
    { name: "c.txt" },
    { name: "d.txt" },
    { name: "e.txt" },
    { name: "f.txt" },
  ],
  docs: [{ name: "d1.md" }, { name: "d2.md" }, { name: "sub", dir: true }],
  "docs/sub": [{ name: "deep.md" }],
  empty: [],
  b: [{ name: "x.txt" }],
};

/** What survives the panel unmounting, as the app's settings / folder state do. */
const kept = { view: "files" as View, dir: "" };
const opened: string[] = [];

let panelOpen = false;
const listeners = new Set<() => void>();
const setPanel = (open: boolean) => {
  panelOpen = open;
  listeners.forEach((l) => l());
};
const onSidePanel = (open: boolean) => setPanel(open);

function Panel() {
  const [view, setViewState] = useState<View>(kept.view);
  const [dir, setDirState] = useState(kept.dir);
  const [loading, setLoading] = useState(false);
  const setView = (v: View) => {
    kept.view = v;
    setViewState(v);
  };
  // A folder takes a moment to list, as over the bridge.
  const go = (to: string) => {
    setLoading(true);
    window.setTimeout(() => {
      kept.dir = to;
      setDirState(to);
      setLoading(false);
    }, 20);
  };
  const entries = LISTING[dir] ?? [];
  const parent = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
  const segments = dir.split("/").filter(Boolean);
  return (
    <div className="side-panel open">
      <div className="side-panel-header" data-y="0">
        <button id="menu" type="button">
          menu
        </button>
      </div>
      <div className="side-panel-toolbars">
        <div className="side-panel-toolbar side-panel-views" data-y="20">
          {VIEWS.map((v, i) => (
            <button
              key={v}
              id={`tab-${v}`}
              type="button"
              data-view={v}
              className={`toolbar-btn toolbar-btn--tab${view === v ? " active" : ""}`}
              aria-pressed={view === v}
              onClick={() => setView(v)}
            >
              {v}
              <SideViewKey n={i} />
            </button>
          ))}
        </div>
      </div>
      {view === "files" && (
        <div className="side-panel-scroll" data-y="80" data-h="100">
          <div className="file-tree" tabIndex={0}>
            <div className="file-tree-head">
              <div className="file-tree-breadcrumb" data-y="60">
                {dir && (
                  <button id="up" type="button" className="file-tree-up" onClick={() => go(parent)}>
                    ↑
                  </button>
                )}
                <button type="button" className={`file-tree-crumb${dir ? "" : " current"}`}>
                  ⌂
                </button>
                {/* One crumb per folder on the path, the last one current — as the tree draws it. */}
                {segments.map((seg, i) => (
                  <button key={i} type="button" className={`file-tree-crumb${i === segments.length - 1 ? " current" : ""}`}>
                    {seg}
                  </button>
                ))}
              </div>
            </div>
            {loading && <div className="file-tree-skeleton" />}
            {entries.map((e, i) => {
              const path = dir ? `${dir}/${e.name}` : e.name;
              return (
                <div
                  key={path}
                  id={`row-${path}`}
                  role="button"
                  className={`file-entry ${e.dir ? "dir" : "file"}`}
                  data-entry-path={path}
                  data-y={100 + i * 30}
                  data-h="20"
                  data-steer-open={e.dir ? undefined : "dblclick"}
                  data-steer-stay={e.zip ? "" : undefined}
                  onClick={e.dir ? () => go(path) : undefined}
                  onDoubleClick={
                    e.dir
                      ? undefined
                      : () => {
                          opened.push(path);
                          if (e.zip) go(path.slice(0, path.lastIndexOf(".")));
                        }
                  }
                >
                  <span className="file-name">{e.name}</span>
                  {e.button && (
                    <button id={`btn-${e.name}`} type="button">
                      sync
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {view === "git" && (
        <div className="side-panel-scroll" data-y="80" data-h="100">
          <div id="git-row" role="button" data-y="100" data-h="20">
            changes
            <button id="git-b1" type="button">
              stage
            </button>
            <button id="git-b2" type="button">
              discard
            </button>
          </div>
          <div id="git-row2" role="button" data-y="130" data-h="20">
            history
          </div>
        </div>
      )}
      {view === "windows" && <div className="side-panel-scroll" data-y="80" data-h="100" />}
    </div>
  );
}

function PanelHost() {
  const open = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => panelOpen,
  );
  return open ? <Panel /> : null;
}

/** Apart from everything that re-renders: the hook's effect re-running would
 *  drop the pending cursor placement. */
function Keyboard() {
  useKeyboard({ onTogglePanels: () => {}, onSidePanel });
  return null;
}

function mount() {
  render(
    <>
      <Keyboard />
      <PanelHost />
    </>,
  );
}

function press(init: Partial<KeyboardEventInit> & { key: string }) {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });
}

const steering = () => useKeyboardSteeringStore.getState();
/** What the cursor is on, by id (or entry path for a row). */
const at = () => regionCursor()?.id.replace(/^row-/, "");

/** Steering on, B pressed, the cursor landed in the list. */
async function openPanel(landed = "docs") {
  press({ key: " ", shiftKey: true });
  press({ key: "b" });
  await waitFor(() => expect(at()).toBe(landed));
}

beforeEach(() => {
  localStorage.clear();
  kept.view = "files";
  kept.dir = "";
  opened.length = 0;
  panelOpen = false;
  useTabsStore.setState({
    scope: "p",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
    fullscreenGroupId: null,
  });
  useTabsStore.getState().addTab({ label: "t", cmd: "bash", cwd: "/p", kind: "shell" });
  useSettingsStore.setState({ settings: null });
  useProjectsStore.setState({ projects: [], activeId: null });
  useKeyboardSteeringStore.getState().exit();
  forgetRegionCursors();
  forgetSidePanelRows();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const host = this.closest<HTMLElement>("[data-y]");
    const y = Number(host?.dataset.y ?? 0);
    const h = Number(this.dataset.h ?? host?.dataset.h ?? 10);
    return { width: 10, height: h, x: 0, y, top: y, left: 0, right: 10, bottom: y + h, toJSON: () => ({}) };
  });
});

afterEach(() => {
  cleanup();
  clearRegionCursor();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("steering in the side panel", () => {
  it("B lands in the list, on the first row, not on the panel's header", async () => {
    mount();
    await openPanel();
    expect(steering()).toMatchObject({ level: "region", region: "side" });
    expect(regionCursor()?.classList.contains("steer-cursor")).toBe(true);
  });

  it("↑/↓ move one line per press and stop at both ends instead of wrapping", async () => {
    mount();
    await openPanel();
    press({ key: "ArrowDown" });
    expect(at()).toBe("empty");
    press({ key: "ArrowDown" });
    // a.txt's own button is part of its line: one press passes both.
    expect(at()).toBe("a.txt");
    press({ key: "ArrowDown" });
    expect(at()).toBe("b.zip");
    for (let i = 0; i < 10; i++) press({ key: "ArrowDown" });
    expect(at()).toBe("f.txt");
    press({ key: "ArrowDown" });
    expect(at()).toBe("f.txt");

    // Up through the list, then the head one line at a time, to the first line.
    for (let i = 0; i < 7; i++) press({ key: "ArrowUp" });
    expect(at()).toBe("docs");
    press({ key: "ArrowUp" });
    expect(regionCursor()?.textContent).toBe("⌂");
    press({ key: "ArrowUp" });
    // The view row: the cursor lands on the active tab, not the first one.
    expect(at()).toBe("tab-files");
    press({ key: "ArrowUp" });
    expect(at()).toBe("menu");
    press({ key: "ArrowUp" });
    expect(at()).toBe("menu");
  });

  it("↑/↓ also answer to the home-row letters", async () => {
    mount();
    await openPanel();
    press({ key: "d" });
    expect(at()).toBe("empty");
    press({ key: "e" });
    expect(at()).toBe("docs");
  });

  it("Shift+↑/↓ move a screenful, clamped at the ends", async () => {
    mount();
    await openPanel();
    // The list is 100 high and a row 20: five lines, less one.
    press({ key: "ArrowDown", shiftKey: true });
    expect(at()).toBe("c.txt");
    press({ key: "ArrowDown", shiftKey: true });
    expect(at()).toBe("f.txt");
    press({ key: "ArrowUp", shiftKey: true });
    expect(at()).toBe("b.zip");
    // Past the first row the head's lines count too: the breadcrumb, the view
    // row and the header are three more lines.
    press({ key: "ArrowUp", shiftKey: true });
    expect(regionCursor()?.textContent).toBe("⌂");
    press({ key: "ArrowUp", shiftKey: true });
    expect(at()).toBe("menu");
    press({ key: "ArrowUp", shiftKey: true });
    expect(at()).toBe("menu");
  });

  it("a screenful is ten lines when nothing measures", async () => {
    mount();
    await openPanel();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const y = Number(this.closest<HTMLElement>("[data-y]")?.dataset.y ?? 0);
      // Boxes exist (the cursor can land), but the list reports no height.
      return { width: 10, height: this.classList.contains("side-panel-scroll") ? 0 : 10, x: 0, y, top: y, left: 0, right: 10, bottom: y + 10, toJSON: () => ({}) };
    });
    press({ key: "ArrowDown", shiftKey: true });
    expect(at()).toBe("f.txt");
  });

  it("←/→ on a file row go through the row's own buttons, without wrapping", async () => {
    mount();
    await openPanel();
    press({ key: "ArrowDown" });
    press({ key: "ArrowDown" });
    expect(at()).toBe("a.txt");
    press({ key: "ArrowRight" });
    expect(at()).toBe("btn-a.txt");
    press({ key: "ArrowRight" });
    expect(at()).toBe("btn-a.txt");
    press({ key: "ArrowLeft" });
    expect(at()).toBe("a.txt");
    // A tree row at the root has no parent: ← does nothing.
    press({ key: "ArrowLeft" });
    expect(at()).toBe("a.txt");
    // → on a file with no button stays put as well.
    press({ key: "ArrowDown" });
    press({ key: "ArrowRight" });
    expect(at()).toBe("b.zip");
  });

  it("→ opens a folder onto its first row; ← goes back up onto the folder just left", async () => {
    mount();
    await openPanel();
    press({ key: "ArrowRight" });
    await waitFor(() => expect(at()).toBe("docs/d1.md"));
    press({ key: "ArrowDown" });
    expect(at()).toBe("docs/d2.md");
    press({ key: "ArrowLeft" });
    await waitFor(() => expect(at()).toBe("docs"));
    // And at the root again, ← has nowhere to go.
    press({ key: "ArrowLeft" });
    expect(at()).toBe("docs");
  });

  it("an empty folder puts the cursor on the breadcrumb line", async () => {
    mount();
    await openPanel();
    press({ key: "ArrowDown" });
    expect(at()).toBe("empty");
    press({ key: "ArrowRight" });
    await waitFor(() => expect(at()).toBe("up"));
    // No row to press ← on: ← at the breadcrumb's left end is the way out.
    press({ key: "ArrowLeft" });
    await waitFor(() => expect(at()).toBe("empty"));
    expect(kept.dir).toBe("");
  });

  it("← on the breadcrumb goes up from a nested folder too, where the ↑ button stays", async () => {
    kept.dir = "docs/sub";
    mount();
    await openPanel("docs/sub/deep.md");
    press({ key: "ArrowUp" });
    expect(at()).toBe("up");
    press({ key: "ArrowLeft" });
    await waitFor(() => expect(at()).toBe("docs/sub"));
    expect(kept.dir).toBe("docs");
  });

  it("a cursor whose row went away comes back into the list, not to the panel's top", async () => {
    mount();
    await openPanel();
    press({ key: "ArrowDown" });
    expect(at()).toBe("empty");
    act(() => clearRegionCursor());
    expect(regionCursor()).toBeNull();
    press({ key: "ArrowDown" });
    // The row it was last on — the panel's first line is its header ("menu").
    expect(at()).toBe("empty");
  });

  it("←/→ elsewhere step along the line's controls; ← from the first button returns to the row", async () => {
    mount();
    kept.view = "git";
    await openPanel("git-row");
    press({ key: "ArrowRight" });
    expect(at()).toBe("git-b1");
    press({ key: "ArrowRight" });
    expect(at()).toBe("git-b2");
    press({ key: "ArrowRight" });
    expect(at()).toBe("git-b2");
    press({ key: "ArrowLeft" });
    press({ key: "ArrowLeft" });
    expect(at()).toBe("git-row");
    press({ key: "ArrowLeft" });
    expect(at()).toBe("git-row");
    press({ key: "ArrowDown" });
    expect(at()).toBe("git-row2");
  });

  it("←/→ on the view tabs switch the view (wrapping) and the cursor follows the active tab", async () => {
    mount();
    await openPanel();
    for (let i = 0; i < 2; i++) press({ key: "ArrowUp" });
    expect(at()).toBe("tab-files");
    press({ key: "ArrowRight" });
    await waitFor(() => expect(document.getElementById("tab-git")!.classList.contains("steer-cursor")).toBe(true));
    expect(at()).toBe("tab-git");
    expect(kept.view).toBe("git");
    // Still on the view row: the next → goes on.
    press({ key: "ArrowRight" });
    await waitFor(() => expect(at()).toBe("tab-windows"));
    press({ key: "ArrowRight" });
    await waitFor(() => expect(at()).toBe("tab-files"));
    press({ key: "ArrowLeft" });
    await waitFor(() => expect(at()).toBe("tab-windows"));
    expect(kept.view).toBe("windows");
    // ↓ from the view row goes into the list of the view now shown.
    press({ key: "ArrowLeft" });
    await waitFor(() => expect(at()).toBe("tab-git"));
    press({ key: "ArrowDown" });
    expect(at()).toBe("git-row");
  });

  it("a number key switches to that view and lands in its list; the active view's own number lands in the list", async () => {
    mount();
    await openPanel();
    press({ key: "ArrowDown" });
    press({ key: "ArrowDown" });
    expect(at()).toBe("a.txt");
    press({ key: "2" });
    await waitFor(() => expect(at()).toBe("git-row"));
    expect(kept.view).toBe("git");
    expect(steering()).toMatchObject({ level: "region", region: "side" });
    // Back to Files: the row it was on there.
    press({ key: "1" });
    await waitFor(() => expect(at()).toBe("a.txt"));
    // From the head, the active view's number goes into the list, onto the
    // last row the cursor was on there (the climb passed docs last).
    for (let i = 0; i < 4; i++) press({ key: "ArrowUp" });
    expect(at()).toBe("tab-files");
    press({ key: "1" });
    await waitFor(() => expect(at()).toBe("docs"));
    // A number beyond the views the panel has does nothing.
    press({ key: "9" });
    expect(at()).toBe("docs");
    expect(kept.view).toBe("files");
  });

  it("a view with nothing to land on holds the cursor on its tab", async () => {
    mount();
    await openPanel();
    press({ key: "3" });
    await waitFor(() => expect(at()).toBe("tab-windows"));
    expect(kept.view).toBe("windows");
  });

  it("follows a rebound slot key, and the tab wears it", async () => {
    useSettingsStore.setState({ settings: { steering_keys: { slot2: ["g"] } } as unknown as Settings });
    mount();
    await openPanel();
    expect([...document.querySelectorAll(".side-view-key")].map((k) => k.textContent)).toEqual(["1", "G", "3"]);
    press({ key: "g" });
    await waitFor(() => expect(at()).toBe("git-row"));
    expect(kept.view).toBe("git");
    // The default digit is no longer the slot's key.
    press({ key: "1" });
    await waitFor(() => expect(kept.view).toBe("files"));
    press({ key: "2" });
    expect(kept.view).toBe("files");
  });

  it("Enter on a file opens it as a double-click, goes to the tabs and closes the panel B opened", async () => {
    mount();
    await openPanel();
    for (let i = 0; i < 2; i++) press({ key: "ArrowDown" });
    expect(at()).toBe("a.txt");
    press({ key: "Enter" });
    expect(opened).toEqual(["a.txt"]);
    expect(steering()).toMatchObject({ active: true, level: "tabs" });
    expect(steering().region).toBeNull();
    await waitFor(() => expect(document.querySelector(".side-panel")).toBeNull());
    expect(document.querySelector(".steer-cursor")).toBeNull();
  });

  it("Enter on a file leaves a panel steering did not open where it is", async () => {
    setPanel(true);
    mount();
    press({ key: " ", shiftKey: true });
    press({ key: "b" });
    await waitFor(() => expect(at()).toBe("docs"));
    for (let i = 0; i < 4; i++) press({ key: "ArrowDown" });
    expect(at()).toBe("c.txt");
    press({ key: "Enter" });
    expect(opened).toEqual(["c.txt"]);
    expect(steering()).toMatchObject({ level: "tabs" });
    expect(document.querySelector(".side-panel")).not.toBeNull();
  });

  it("Shift+Enter opens the file and stays in the panel", async () => {
    mount();
    await openPanel();
    for (let i = 0; i < 4; i++) press({ key: "ArrowDown" });
    press({ key: "Enter", shiftKey: true });
    expect(opened).toEqual(["c.txt"]);
    expect(steering()).toMatchObject({ level: "region", region: "side" });
    expect(at()).toBe("c.txt");
    press({ key: "ArrowDown" });
    expect(at()).toBe("d.txt");
  });

  it("a .zip extracts and steering stays in the panel, on the new folder's first row", async () => {
    mount();
    await openPanel();
    for (let i = 0; i < 3; i++) press({ key: "ArrowDown" });
    expect(at()).toBe("b.zip");
    press({ key: "Enter" });
    expect(opened).toEqual(["b.zip"]);
    expect(steering()).toMatchObject({ level: "region", region: "side" });
    await waitFor(() => expect(at()).toBe("b/x.txt"));
  });

  it("Enter on a folder row opens the folder as → does, the cursor going in with it", async () => {
    mount();
    await openPanel();
    press({ key: "Enter" });
    await waitFor(() => expect(at()).toBe("docs/d1.md"));
    expect(kept.dir).toBe("docs");
    expect(opened).toEqual([]);
    expect(steering()).toMatchObject({ level: "region", region: "side" });
  });

  it("remembers the row in each view across closing and reopening the panel", async () => {
    mount();
    await openPanel();
    for (let i = 0; i < 5; i++) press({ key: "ArrowDown" });
    expect(at()).toBe("d.txt");
    // Close (the key that opened it) and open again.
    press({ key: "b" });
    await waitFor(() => expect(document.querySelector(".side-panel")).toBeNull());
    expect(steering()).toMatchObject({ level: "tabs" });
    press({ key: "b" });
    await waitFor(() => expect(at()).toBe("d.txt"));
    // Another project does not share it.
    press({ key: "b" });
    await waitFor(() => expect(document.querySelector(".side-panel")).toBeNull());
    useProjectsStore.setState({ activeId: "other" });
    press({ key: "b" });
    await waitFor(() => expect(at()).toBe("docs"));
  });

  it("Esc and the opening key still leave the panel", async () => {
    mount();
    await openPanel();
    press({ key: "Escape" });
    expect(steering()).toMatchObject({ active: true, level: "tabs" });
    await waitFor(() => expect(document.querySelector(".side-panel")).toBeNull());
  });
});

describe("the view tabs' slot keys", () => {
  it("show only while steering is in the side panel", async () => {
    mount();
    act(() => setPanel(true));
    expect(document.querySelector(".side-panel")).not.toBeNull();
    expect(document.querySelectorAll(".side-view-key")).toHaveLength(0);
    press({ key: " ", shiftKey: true });
    expect(document.querySelectorAll(".side-view-key")).toHaveLength(0);
    press({ key: "b" });
    await waitFor(() => expect(document.querySelectorAll(".side-view-key")).toHaveLength(3));
    expect([...document.querySelectorAll(".side-view-key")].map((k) => k.textContent)).toEqual(["1", "2", "3"]);
    expect(document.querySelector(".side-view-key")?.getAttribute("aria-hidden")).toBe("true");
    press({ key: "b" });
    await waitFor(() => expect(document.querySelectorAll(".side-view-key")).toHaveLength(0));
  });

  it("only the first nine views have one", () => {
    act(() => steering().enter());
    act(() => steering().enterRegion("side"));
    const { container } = render(
      <>
        <SideViewKey n={8} />
        <SideViewKey n={9} />
      </>,
    );
    expect(container.querySelectorAll(".side-view-key")).toHaveLength(1);
    expect(container.textContent).toBe("9");
  });
});
