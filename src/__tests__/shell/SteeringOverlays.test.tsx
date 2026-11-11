/**
 * Steering over whatever floats on top: any dialog (`.modal-backdrop`), a
 * right-click menu (`ContextMenuPortal`) and the top bar's hover menus are
 * walked as the "overlay" region instead of ending steering — Escape closes
 * them the way their own Escape does (or their ×), and steering comes back to
 * the surface they were opened from, the cursor where it was. ↑ on the
 * projects level walks the top bar; `.` opens a right-click menu.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect, useState } from "react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: vi.fn().mockResolvedValue(false),
    setFullscreen: vi.fn(),
  }),
}));

import { useKeyboard } from "../../hooks/useKeyboard";
import { useModalFocus } from "../../hooks/useModalFocus";
import { ContextMenuPortal } from "../../components/common/ContextMenuPortal";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { useTabsStore } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { useProjectsStore } from "../../stores/projects";
import { steeringKeysFor, type SteeringLegendState } from "../../lib/shortcuts/shortcuts";
import {
  clearRegionCursor,
  forgetRegionCursors,
  regionCursor,
  topLayer,
} from "../../lib/shortcuts/steeringRegion";

/** Apart from what re-renders, as in the app: the hook's effect re-running
 *  would drop its pending timers. */
function Keyboard() {
  useKeyboard({ onTogglePanels: () => {} });
  return null;
}

/** A plain dialog in the shared frame: closes on its own Escape (a window
 *  listener, as most do) unless `noEscape`, then only by its ×. */
function Dialog({
  id,
  onClose,
  noEscape,
  autoFocus,
}: {
  id: string;
  onClose: () => void;
  noEscape?: boolean;
  /** Puts the caret in its name field, as New Folder does. */
  autoFocus?: boolean;
}) {
  useEffect(() => {
    if (noEscape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, noEscape]);
  return (
    <div className="modal-backdrop" id={id}>
      <div className="project-dialog">
        <button type="button" className="dialog-close-btn" onClick={onClose}>
          ×
        </button>
        <div data-y="10">
          <input
            id={`${id}-name`}
            type="text"
            autoFocus={autoFocus}
            onKeyDown={(e) => {
              if (e.key === "Enter") onClose();
            }}
          />
        </div>
        <div data-y="20">
          <button type="button" id={`${id}-cancel`} onClick={onClose}>
            cancel
          </button>
          <button type="button" id={`${id}-ok`} onClick={onClose}>
            ok
          </button>
        </div>
      </div>
    </div>
  );
}

/** A surface with a button that raises a second dialog over the first. */
function Stack() {
  const [outer, setOuter] = useState(false);
  const [inner, setInner] = useState(false);
  useEffect(() => {
    const open = () => setOuter(true);
    window.addEventListener("test:open-outer", open);
    return () => window.removeEventListener("test:open-outer", open);
  }, []);
  return (
    <>
      {outer && (
        <div className="modal-backdrop" id="outer">
          <div className="project-dialog">
            <div data-y="10">
              <button type="button" id="outer-a">
                a
              </button>
            </div>
            <div data-y="20">
              <button type="button" id="outer-raise" onClick={() => setInner(true)}>
                raise
              </button>
            </div>
            <div data-y="30">
              <button type="button" id="outer-close" onClick={() => setOuter(false)}>
                close
              </button>
            </div>
          </div>
        </div>
      )}
      {inner && <Dialog id="inner" onClose={() => setInner(false)} />}
    </>
  );
}

/** A tab bar's active tab with its right-click menu. */
function Tab({ inlineRename }: { inlineRename?: boolean } = {}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [label, setLabel] = useState("tab");
  const [editing, setEditing] = useState(false);
  return (
    <div className="subwindow focused">
      <div
        className="tab active"
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {editing ? (
          <input
            id="tab-rename"
            type="text"
            autoFocus
            defaultValue={label}
            onKeyDown={(e) => {
              if (e.key === "Enter") setLabel(e.currentTarget.value);
              if (e.key === "Enter" || e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          label
        )}
      </div>
      {menu && (
        <ContextMenuPortal x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <div data-y="10">
            <button
              type="button"
              id="rename"
              onClick={() => {
                setMenu(null);
                if (inlineRename) setEditing(true);
              }}
            >
              rename
            </button>
          </div>
          <div data-y="20">
            <button type="button" id="color">
              colour
            </button>
          </div>
        </ContextMenuPortal>
      )}
    </div>
  );
}

/** A top bar: one hover menu (the shared hover store, as the indicators) and
 *  a plain button. */
function Header({ onPlain }: { onPlain: () => void }) {
  const open = useHeaderHoverMenuStore((s) => s.openId === "m");
  const reveal = () => useHeaderHoverMenuStore.getState().open("m");
  return (
    <header className="app-header">
      <div className="global-apps-menu" onMouseEnter={reveal}>
        <button type="button" id="menu-btn" aria-haspopup="menu" aria-expanded={open}>
          menu
        </button>
        {open && (
          <div className="tab-new-menu" role="menu">
            <div data-y="40">
              <button type="button" id="item-1" onClick={() => useHeaderHoverMenuStore.getState().close("m")}>
                one
              </button>
            </div>
            <div data-y="50">
              <button type="button" id="item-2">
                two
              </button>
            </div>
          </div>
        )}
      </div>
      <button type="button" id="plain" onClick={onPlain}>
        plain
      </button>
    </header>
  );
}

function press(init: Partial<KeyboardEventInit> & { key: string }) {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
}

const steering = () => useKeyboardSteeringStore.getState();
const on = () => {
  press({ key: " ", shiftKey: true });
  expect(steering().active).toBe(true);
};

beforeEach(() => {
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
  useSettingsStore.setState({ settings: null });
  useProjectsStore.setState({ projects: [] });
  useHeaderHoverMenuStore.setState({ openId: null });
  useKeyboardSteeringStore.getState().exit();
  forgetRegionCursors();
  // jsdom has no layout: every element gets a box, its row set by the
  // nearest `data-y` so ↑/↓ can tell the rows apart.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const y = Number(this.closest<HTMLElement>("[data-y]")?.dataset.y ?? 0);
    return { width: 10, height: 5, x: 0, y, top: y, left: 0, right: 10, bottom: y + 5, toJSON: () => ({}) };
  });
});

afterEach(() => {
  cleanup();
  clearRegionCursor();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("steering over dialogs", () => {
  it("a dialog that comes up takes the cursor; Escape closes it as its own Escape does and steering returns", async () => {
    function App() {
      const [open, setOpen] = useState(false);
      useEffect(() => {
        const show = () => setOpen(true);
        window.addEventListener("test:open", show);
        return () => window.removeEventListener("test:open", show);
      }, []);
      return (
        <>
          {open && <Dialog id="d" onClose={() => setOpen(false)} />}
        </>
      );
    }
    render(
      <>
        <Keyboard />
        <App />
      </>,
    );
    on();
    // Raised by something else (the app, the pointer) while steering is on
    // the tabs: the next key walks it instead of acting behind it.
    act(() => void window.dispatchEvent(new Event("test:open")));
    press({ key: "d" });
    expect(steering()).toMatchObject({ active: true, level: "region", region: "overlay", regionReturn: "tabs" });
    await settle();
    // Rows: ↓ goes row to row (the field, then the buttons), ←/→ along one.
    expect(regionCursor()?.id).toBe("d-name");
    press({ key: "d" });
    expect(regionCursor()?.id).toBe("d-cancel");
    press({ key: "f" });
    expect(regionCursor()?.id).toBe("d-ok");

    press({ key: "Escape" });
    await settle();
    expect(document.getElementById("d")).toBeNull();
    expect(steering()).toMatchObject({ active: true, level: "tabs", region: null });
  });

  it("Enter on a button that closes the dialog goes back too; Enter on a field hands it the caret", async () => {
    function App() {
      const [open, setOpen] = useState(true);
      return (
        <>
          {open && <Dialog id="d" onClose={() => setOpen(false)} />}
        </>
      );
    }
    render(
      <>
        <Keyboard />
        <App />
      </>,
    );
    // The chord over an open dialog starts steering on it.
    on();
    expect(steering()).toMatchObject({ level: "region", region: "overlay" });
    await settle();
    press({ key: "Enter" });
    expect(steering()).toMatchObject({ active: false, handedTo: "field" });
    expect(document.activeElement?.id).toBe("d-name");

    on();
    await settle();
    press({ key: "d" });
    expect(regionCursor()?.id).toBe("d-cancel");
    press({ key: "Enter" });
    await settle();
    expect(document.getElementById("d")).toBeNull();
    expect(steering()).toMatchObject({ active: true, level: "tabs", region: null });
  });

  it("a dialog that focuses its own field gets the keys; Esc steers it, its closing brings steering back", async () => {
    function App() {
      const [open, setOpen] = useState(false);
      useEffect(() => {
        const show = () => setOpen(true);
        window.addEventListener("test:open", show);
        return () => window.removeEventListener("test:open", show);
      }, []);
      return <>{open && <Dialog id="d" autoFocus onClose={() => setOpen(false)} />}</>;
    }
    render(
      <>
        <Keyboard />
        <App />
      </>,
    );
    on();
    act(() => void window.dispatchEvent(new Event("test:open")));
    await settle();
    expect(document.activeElement?.id).toBe("d-name");
    expect(steering()).toMatchObject({ active: false, handedTo: "field" });
    expect(steering().handoffReturn).toMatchObject({ level: "region", region: "overlay" });
    // A steering key is typed into the field, not swallowed.
    const typed = new KeyboardEvent("keydown", { key: "d", bubbles: true, cancelable: true });
    act(() => void document.activeElement!.dispatchEvent(typed));
    expect(typed.defaultPrevented).toBe(false);

    // Esc: steering walks the dialog again, the dialog stays up.
    act(() => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await settle();
    expect(document.getElementById("d")).not.toBeNull();
    expect(steering()).toMatchObject({ active: true, level: "region", region: "overlay", handedTo: null });
    expect(regionCursor()?.id).toBe("d-name");

    // Enter on the field hands it the keyboard again; Enter in it submits,
    // and steering comes back where the dialog was raised from.
    press({ key: "Enter" });
    expect(steering()).toMatchObject({ active: false, handedTo: "field" });
    act(() => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await settle();
    expect(document.getElementById("d")).toBeNull();
    expect(steering()).toMatchObject({ active: true, level: "tabs", region: null, handedTo: null });
  });

  it("a dialog that ignores Escape is closed by its ×", async () => {
    function App() {
      const [open, setOpen] = useState(true);
      return (
        <>
          {open && <Dialog id="d" noEscape onClose={() => setOpen(false)} />}
        </>
      );
    }
    render(
      <>
        <Keyboard />
        <App />
      </>,
    );
    on();
    await settle();
    press({ key: "Escape" });
    // The × is pressed a moment after the Escape went unanswered; steering
    // follows as the dialog unmounts.
    await settle();
    expect(document.getElementById("d")).toBeNull();
    expect(steering()).toMatchObject({ active: true, level: "tabs" });
  });

  it("a dialog raised from a dialog stacks: closing it comes back to the first, cursor where it was", async () => {
    render(
      <>
        <Keyboard />
        <Stack />
      </>,
    );
    on();
    act(() => void window.dispatchEvent(new Event("test:open-outer")));
    press({ key: "d" });
    await settle();
    expect(regionCursor()?.id).toBe("outer-a");
    press({ key: "d" });
    expect(regionCursor()?.id).toBe("outer-raise");
    press({ key: "Enter" });
    await settle();
    expect(topLayer()?.id).toBe("inner");
    expect(regionCursor()?.id).toBe("inner-name");

    press({ key: "Escape" });
    await settle();
    expect(document.getElementById("inner")).toBeNull();
    expect(steering()).toMatchObject({ active: true, region: "overlay" });
    expect(regionCursor()?.id).toBe("outer-raise");

    press({ key: "d" });
    press({ key: "Enter" });
    await settle();
    expect(document.getElementById("outer")).toBeNull();
    expect(steering()).toMatchObject({ active: true, level: "tabs", region: null });
  });
});

describe("right-click menus", () => {
  it("Escape closes a picker over a modal and restores the picker trigger", async () => {
    function Modal({ onClose }: { onClose: () => void }) {
      const modalRef = useModalFocus(onClose);
      const [pickerOpen, setPickerOpen] = useState(false);
      return (
        <div className="modal-backdrop">
          <div ref={modalRef} id="parent-modal" role="dialog" aria-modal="true">
            <button type="button" id="picker-trigger" onClick={() => setPickerOpen(true)}>Open picker</button>
            {pickerOpen && (
              <ContextMenuPortal x={10} y={10} onClose={() => setPickerOpen(false)}>
                <button type="button" id="picker-option">Picker choice</button>
              </ContextMenuPortal>
            )}
          </div>
        </div>
      );
    }
    function App() {
      const [open, setOpen] = useState(true);
      return open && <Modal onClose={() => setOpen(false)} />;
    }
    render(<><Keyboard /><App /></>);
    on();
    expect(regionCursor()?.id).toBe("picker-trigger");
    press({ key: "Enter" });
    await settle();
    expect(regionCursor()?.id).toBe("picker-option");

    press({ key: "Escape" });
    await settle();
    expect(document.getElementById("picker-option")).toBeNull();
    expect(document.getElementById("parent-modal")).not.toBeNull();
    expect(regionCursor()?.id).toBe("picker-trigger");

    press({ key: "Escape" });
    await settle();
    expect(document.getElementById("parent-modal")).toBeNull();
  });

  it(". opens the active tab's menu, walked as the overlay; Escape closes it back to the tabs", async () => {
    render(
      <>
        <Keyboard />
        <Tab />
      </>,
    );
    on();
    press({ key: "." });
    await settle();
    expect(document.querySelector(".context-menu-portal")).not.toBeNull();
    expect(steering()).toMatchObject({ level: "region", region: "overlay", regionReturn: "tabs" });
    expect(regionCursor()?.id).toBe("rename");
    press({ key: "ArrowDown" });
    expect(regionCursor()?.id).toBe("color");

    press({ key: "Escape" });
    await settle();
    expect(document.querySelector(".context-menu-portal")).toBeNull();
    expect(steering()).toMatchObject({ active: true, level: "tabs", region: null });

    // A pick closes it the same way.
    press({ key: "." });
    await settle();
    press({ key: "Enter" });
    await settle();
    expect(document.querySelector(".context-menu-portal")).toBeNull();
    expect(steering()).toMatchObject({ active: true, level: "tabs" });
  });
});

describe("an inline field a steering key opened", () => {
  it("Rename from the tab's menu takes the keys; Enter commits and Esc cancels, steering back on the tabs", async () => {
    render(
      <>
        <Keyboard />
        <Tab inlineRename />
      </>,
    );
    on();
    press({ key: "." });
    await settle();
    expect(regionCursor()?.id).toBe("rename");
    press({ key: "Enter" });
    await settle();
    expect(document.activeElement?.id).toBe("tab-rename");
    expect(steering()).toMatchObject({ active: false, handedTo: "field" });
    expect(steering().handoffReturn).toMatchObject({ level: "tabs", region: null });
    const field = () => document.getElementById("tab-rename") as HTMLInputElement;
    const typed = new KeyboardEvent("keydown", { key: "d", bubbles: true, cancelable: true });
    act(() => void field().dispatchEvent(typed));
    expect(typed.defaultPrevented).toBe(false);
    act(() => {
      field().value = "named";
    });
    act(() => void field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await settle();
    expect(field()).toBeNull();
    expect(document.querySelector(".tab.active")?.textContent).toBe("named");
    expect(steering()).toMatchObject({ active: true, level: "tabs", handedTo: null });

    // Esc is the rename's own: it cancels, and steering comes back.
    press({ key: "." });
    await settle();
    press({ key: "Enter" });
    await settle();
    expect(steering().handedTo).toBe("field");
    act(() => void field().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await settle();
    expect(field()).toBeNull();
    expect(document.querySelector(".tab.active")?.textContent).toBe("named");
    expect(steering()).toMatchObject({ active: true, level: "tabs", handedTo: null });
  });

  it("a press elsewhere drops the field's handoff; steering stays off", async () => {
    render(
      <>
        <Keyboard />
        <Tab inlineRename />
      </>,
    );
    on();
    press({ key: "." });
    await settle();
    press({ key: "Enter" });
    await settle();
    expect(steering().handedTo).toBe("field");
    act(() => void document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(steering()).toMatchObject({ active: false, handedTo: null });
  });
});

describe("the active tab's card", () => {
  it("A walks the card over the terminal; Escape leaves it up, a press that closes it goes back", async () => {
    function Card() {
      const [up, setUp] = useState(true);
      return (
        <div className="subwindow focused">
          {up && (
            <div className="hint-bubble terminal-sign-in terminal-undo-clear" role="status">
              <button type="button" className="hint-bubble-close" id="card-x" onClick={() => setUp(false)}>
                ×
              </button>
              <button type="button" id="undo" onClick={() => setUp(false)}>
                undo
              </button>
            </div>
          )}
        </div>
      );
    }
    render(
      <>
        <Keyboard />
        <Card />
      </>,
    );
    on();
    press({ key: "a" });
    expect(steering()).toMatchObject({ level: "region", region: "card", regionReturn: "tabs" });
    await settle();
    expect(regionCursor()?.id).toBe("card-x");
    press({ key: "Escape" });
    expect(steering()).toMatchObject({ level: "tabs", region: null });
    expect(document.getElementById("undo")).not.toBeNull();

    press({ key: "a" });
    await settle();
    press({ key: "ArrowRight" });
    expect(regionCursor()?.id).toBe("undo");
    press({ key: "Enter" });
    await settle();
    expect(document.getElementById("undo")).toBeNull();
    expect(steering()).toMatchObject({ active: true, level: "tabs", region: null });
  });
});

describe("the agent tab's subagents", () => {
  /** An agent tab's pane, as `TerminalView` draws it: the prompt strip's top
   *  bar holding the Subagents list (portaled there by the Chat), then the
   *  Chat, which shows an open subagent's bar. */
  function Pane({ agents = 2 }: { agents?: number }) {
    const [listOpen, setListOpen] = useState(false);
    const [opened, setOpened] = useState<number | null>(null);
    return (
      <div className="subwindow focused">
        <div className="pane-host">
          <div className="terminal-prompt-strip">
            <button type="button" id="other">other</button>
            <span className="reader-topbar-navigation">
              {agents > 0 && (
                <nav className="terminal-reader-subagent-index">
                  <button type="button" id="toggle" className="terminal-reader-subagent-toggle" aria-expanded={listOpen} onClick={() => setListOpen((was) => !was)}>
                    Subagents
                  </button>
                  {listOpen && (
                    <div className="terminal-reader-subagent-list">
                      {Array.from({ length: agents }, (_, i) => (
                        <button type="button" key={i} id={`agent-${i}`} onClick={() => { setOpened(i); setListOpen(false); }}>
                          agent {i}
                        </button>
                      ))}
                    </div>
                  )}
                </nav>
              )}
            </span>
          </div>
          <div className="terminal-reader">
            {opened !== null && (
              <nav className="terminal-reader-subagent-bar">
                <button type="button" id="sub-back" className="terminal-reader-subagent-nav" onClick={() => setOpened(null)}>‹</button>
                <strong id="sub-title">agent {opened}</strong>
              </nav>
            )}
            <button type="button" id="chat-link">a link in the chat</button>
          </div>
        </div>
      </div>
    );
  }

  it("G opens the list on its first subagent; Enter opens it and the cursor moves to its bar", async () => {
    render(
      <>
        <Keyboard />
        <Pane />
      </>,
    );
    on();
    press({ key: "g" });
    expect(steering()).toMatchObject({ level: "region", region: "subagents", regionReturn: "tabs" });
    await settle();
    expect(regionCursor()?.id).toBe("agent-0");
    press({ key: "ArrowDown" });
    expect(regionCursor()?.id).toBe("agent-1");
    // The walk keeps to the subagent controls: on round to the toggle.
    press({ key: "ArrowDown" });
    expect(regionCursor()?.id).toBe("toggle");
    press({ key: "ArrowUp" });
    press({ key: "Enter" });
    await settle();
    expect(document.getElementById("sub-title")?.textContent).toBe("agent 1");
    expect(steering()).toMatchObject({ level: "region", region: "subagents" });
    expect(regionCursor()?.id).toBe("sub-back");

    // Back out, then G again with a subagent open: straight onto its bar.
    press({ key: "Escape" });
    expect(steering()).toMatchObject({ level: "tabs", region: null });
    press({ key: "g" });
    await settle();
    expect(document.querySelector(".terminal-reader-subagent-list")).toBeNull();
    expect(regionCursor()?.id).toBe("sub-back");
  });

  it("Escape closes the list it opened", async () => {
    render(
      <>
        <Keyboard />
        <Pane />
      </>,
    );
    on();
    press({ key: "g" });
    await settle();
    expect(document.querySelector(".terminal-reader-subagent-list")).not.toBeNull();
    press({ key: "Escape" });
    expect(steering()).toMatchObject({ level: "tabs", region: null });
    expect(document.querySelector(".terminal-reader-subagent-list")).toBeNull();
  });

  it("G does nothing on a tab without subagents, and the legend lists it only with them", () => {
    render(
      <>
        <Keyboard />
        <Pane agents={0} />
      </>,
    );
    on();
    press({ key: "g" });
    expect(steering()).toMatchObject({ level: "tabs", region: null });
    const base: SteeringLegendState = {
      level: "tabs",
      sideRegion: false,
      multiPane: false,
      apps: { mail: false, calendar: false, todo: false },
      statusCounts: { decision: 0, working: 0, done: 0 },
    };
    const listed = (s: SteeringLegendState) => steeringKeysFor(s).some((row) => row.actions.includes("subagents"));
    expect(listed(base)).toBe(false);
    expect(listed({ ...base, subagents: true })).toBe(true);
  });
});

describe("the top bar", () => {
  it("↑ from the projects walks it; ↓ drops a button's menu, Escape takes it back to the button", async () => {
    const plain = vi.fn();
    render(
      <>
        <Keyboard />
        <Header onPlain={plain} />
      </>,
    );
    on();
    press({ key: "e" }); // tabs → projects (one subwindow)
    expect(steering().level).toBe("projects");
    press({ key: "e" });
    expect(steering()).toMatchObject({ level: "region", region: "header", regionReturn: "projects" });
    await settle();
    expect(regionCursor()?.id).toBe("menu-btn");

    press({ key: "d" });
    await settle();
    expect(useHeaderHoverMenuStore.getState().openId).toBe("m");
    expect(steering().region).toBe("overlay");
    expect(regionCursor()?.id).toBe("item-1");
    press({ key: "d" });
    expect(regionCursor()?.id).toBe("item-2");

    // The hover menu has no Escape of its own: steering closes it.
    press({ key: "Escape" });
    await settle();
    expect(useHeaderHoverMenuStore.getState().openId).toBeNull();
    expect(steering().region).toBe("header");
    expect(regionCursor()?.id).toBe("menu-btn");

    // A pick closes it too.
    press({ key: "d" });
    await settle();
    press({ key: "Enter" });
    await settle();
    expect(steering().region).toBe("header");

    // → to the plain button; Enter presses it; ↓ there goes back down.
    press({ key: "f" });
    expect(regionCursor()?.id).toBe("plain");
    press({ key: "Enter" });
    expect(plain).toHaveBeenCalledTimes(1);
    press({ key: "d" });
    expect(steering()).toMatchObject({ active: true, level: "projects", region: null });
  });

  it("the legend lists the bar's keys there and the row keys in a dialog", () => {
    const base: SteeringLegendState = {
      level: "region",
      sideRegion: false,
      multiPane: false,
      apps: { mail: false, calendar: false, todo: false },
      statusCounts: { decision: 0, working: 0, done: 0 },
    };
    const labels = (s: Partial<SteeringLegendState>) => steeringKeysFor({ ...base, ...s }).map((k) => k.labelKey);
    const header = labels({ headerRegion: true });
    expect(header).toContain("steering.headerOpen.label");
    expect(header).toContain("steering.menu.label");
    expect(labels({ overlayRegion: true })).toContain("steering.overlayRow.label");
    expect(labels({})).not.toContain("steering.headerOpen.label");
    expect(labels({ level: "projects" })).toContain("steering.header.label");
  });
});
