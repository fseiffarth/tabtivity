/**
 * Keyboard steering on the list levels (`usePhoneSteering`): the chord, the
 * cursor over a project's tab cards, open / close-with-confirm, the exits, the
 * held-key rule, typing safety with the mode off, cursor repair and a status
 * jump with its way back. The hook is mounted in a small harness beside the
 * real `Project` screen (there is no `App` here).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackNest } from "../../../mobile-web/src/backStack";
import { Home } from "../../../mobile-web/src/screens/Home";
import { Project } from "../../../mobile-web/src/screens/Project";
import { SteeringConfirm } from "../../../mobile-web/src/steering/SteeringConfirm";
import { getSteering, requestFind, setConfirm, type Place } from "../../../mobile-web/src/steering/steeringState";
import { usePhoneSteering, type PhoneSteeringInput, type SteeringBase } from "../../../mobile-web/src/steering/usePhoneSteering";
import { keyInit, press as fire, resetSteering, stubLayout, type KeyMods } from "../helpers/mobileSteering";

const fetchMock = vi.fn();
let layout: ReturnType<typeof stubLayout>;

const tabRow = (id: string, extra: Record<string, unknown> = {}) => ({ id, label: id, kind: "agent", available: true, viewer_busy: false, ...extra });
let tabs: unknown[] = [];
let activity: unknown[] = [];

function answer(url: string, method: string): Response {
  if (url === "/api/v1/projects/p") {
    return new Response(JSON.stringify({ project: { id: "p", label: "Alpha", status: "active", live_sessions: 3 }, desktop_available: true, tabs, agents: [] }), { status: 200 });
  }
  if (url.endsWith("/outbox")) return new Response(JSON.stringify({ files: [] }), { status: 200 });
  if (url === "/api/v1/activity") return new Response(JSON.stringify({ tabs: activity, desktop_available: true }), { status: 200 });
  if (method === "DELETE") return new Response(JSON.stringify({ closed: true }), { status: 200 });
  return new Response("{}", { status: 200 });
}

beforeEach(() => {
  localStorage.clear();
  tabs = [tabRow("a"), tabRow("b"), tabRow("c")];
  activity = [];
  fetchMock.mockImplementation((input: string | URL | Request, init?: RequestInit) => Promise.resolve(answer(String(input), init?.method ?? "GET")));
  vi.stubGlobal("fetch", fetchMock);
  layout = stubLayout();
  // The browser's Back: pop an entry, then tell the page.
  vi.spyOn(window.history, "pushState").mockImplementation(() => {});
  vi.spyOn(window.history, "back").mockImplementation(() => { queueMicrotask(() => window.dispatchEvent(new PopStateEvent("popstate"))); });
});

afterEach(() => {
  cleanup();
  resetSteering();
  layout.restore();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A key press the way the browser delivers it: inside act, so the state it sets renders. */
function press(target: EventTarget | null, key: string, mods: KeyMods = {}): boolean {
  let prevented = false;
  act(() => { prevented = fire(target, key, mods); });
  return prevented;
}

const LIST_PLACE: Place = { kind: "list", section: "projects", projectId: "p" };

function Harness(props: Partial<PhoneSteeringInput> & { base?: SteeringBase }) {
  usePhoneSteering({
    enabled: true,
    base: "tabs",
    sectionLabel: null,
    place: LIST_PLACE,
    openTab: () => {},
    openSection: () => {},
    restore: () => {},
    findProject: () => {},
    ...props,
  });
  return null;
}

async function mountProject(harness: Partial<PhoneSteeringInput> = {}, terminal: (row: { id: string }) => void = () => {}) {
  const view = render(<>
    <BackNest>
      <Project id="p" back={() => {}} terminal={terminal as never} />
      <SteeringConfirm />
    </BackNest>
    <Harness {...harness} />
    <input aria-label="free" />
  </>);
  await screen.findByText("c");
  return view;
}

const opens = () => [...document.querySelectorAll<HTMLElement>(".tab-card-open")];
const active = () => getSteering().active;

describe("Mobile steering — the chord and the cursor on the tab cards", () => {
  it("Shift+Space turns the mode on, marks the page, and puts the cursor on the first card", async () => {
    await mountProject();
    expect(active()).toBe(false);
    expect(press(null, " ", { shift: true })).toBe(true);
    expect(active()).toBe(true);
    expect(document.documentElement.hasAttribute("data-steering")).toBe(true);
    expect(document.activeElement).toBe(opens()[0]);
    expect(layout.scrollIntoView).toHaveBeenCalled();
  });

  it("D moves to the second card and wraps; E goes back up", async () => {
    await mountProject();
    press(null, " ", { shift: true });
    press(null, "d");
    expect(document.activeElement).toBe(opens()[1]);
    press(null, "ArrowDown");
    press(null, "ArrowDown");
    expect(document.activeElement).toBe(opens()[0]);
    press(null, "e");
    expect(document.activeElement).toBe(opens()[2]);
  });

  it("Enter opens the cursor's card, once per press: a held Enter does nothing", async () => {
    const opened: string[] = [];
    await mountProject({}, (row) => opened.push(row.id));
    press(null, " ", { shift: true });
    press(null, "d");
    expect(press(null, "Enter", { repeat: true })).toBe(true);
    expect(opened).toEqual([]);
    press(null, "Enter");
    expect(opened).toEqual(["b"]);
  });

  it("a held D keeps moving the cursor", async () => {
    await mountProject();
    press(null, " ", { shift: true });
    press(null, "d", { repeat: true });
    press(null, "d", { repeat: true });
    expect(document.activeElement).toBe(opens()[2]);
  });

  it("Esc and the chord both leave; the chord's Space keyup is swallowed so the focused card is not clicked", async () => {
    await mountProject();
    press(null, " ", { shift: true });
    press(null, "Escape");
    expect(active()).toBe(false);
    expect(document.documentElement.hasAttribute("data-steering")).toBe(false);

    press(null, " ", { shift: true });
    expect(active()).toBe(true);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", keyInit(" ", { shift: true }))); });
    expect(active()).toBe(false);
    const up = new KeyboardEvent("keyup", keyInit(" ", { shift: true }));
    act(() => { window.dispatchEvent(up); });
    expect(up.defaultPrevented).toBe(true);
    // Only the key it prevented: the next keyup is untouched.
    const other = new KeyboardEvent("keyup", keyInit("a"));
    window.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
  });

  it("a pointer press leaves the mode", async () => {
    await mountProject();
    press(null, " ", { shift: true });
    act(() => { fireEvent.pointerDown(document.body); });
    expect(active()).toBe(false);
  });

  it("the page going hidden leaves the mode", async () => {
    await mountProject();
    press(null, " ", { shift: true });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(active()).toBe(false);
  });
});

describe("Mobile steering — closing a tab asks first", () => {
  it("W opens the confirm for the cursor's card, Y closes it, Esc cancels", async () => {
    await mountProject();
    press(null, " ", { shift: true });
    press(null, "d");
    press(null, "w");
    expect(await screen.findByRole("dialog", { name: "Close b?" })).toBeTruthy();
    expect(getSteering().confirm).toEqual({ tabId: "b", label: "b" });
    expect(getSteering().view?.level).toBe("region");
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);
    press(null, "y");
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url) === "/api/v1/tabs/b" && (init as RequestInit | undefined)?.method === "DELETE")).toBe(true));
    await waitFor(() => expect(getSteering().confirm).toBeNull());
  });

  it("Esc cancels the confirm, keeps the mode on, and the cursor is back on the card", async () => {
    await mountProject();
    press(null, " ", { shift: true });
    press(null, "d");
    press(null, "w");
    await screen.findByRole("dialog", { name: "Close b?" });
    press(null, "Escape");
    await waitFor(() => expect(getSteering().confirm).toBeNull());
    expect(active()).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(opens()[1]));
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);
  });

  it("a tap on the confirm's own button still closes the tab (the tap leaves the mode, not the sheet)", async () => {
    await mountProject();
    press(null, " ", { shift: true });
    press(null, "d");
    press(null, "w");
    const sheet = await screen.findByRole("dialog", { name: "Close b?" });
    const button = [...sheet.querySelectorAll<HTMLButtonElement>("[data-steer-confirm]")][0];
    expect(button).toBeTruthy();
    // A finger on the glass: pointerdown first (it leaves the mode), then the click.
    act(() => { fireEvent.pointerDown(button); });
    expect(active()).toBe(false);
    act(() => { fireEvent.click(button); });
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url) === "/api/v1/tabs/b" && (init as RequestInit | undefined)?.method === "DELETE")).toBe(true));
    await waitFor(() => expect(getSteering().confirm).toBeNull());
  });

  it("a confirm for a card that is gone does nothing", async () => {
    await mountProject();
    act(() => setConfirm({ tabId: "gone", label: "gone" }));
    await screen.findByRole("dialog", { name: "Close gone?" });
    press(null, " ", { shift: true });
    press(null, "y");
    await waitFor(() => expect(getSteering().confirm).toBeNull());
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);
  });
});

describe("Mobile steering — typing is never eaten", () => {
  it("with the mode off only the entry chord is prevented, and Shift+Space in a non-empty field types a space", async () => {
    await mountProject();
    const field = screen.getByLabelText("free") as HTMLInputElement;
    field.focus();
    field.value = "hello";
    for (const key of ["h", "q", "e", "d", "s", "f", "1", "w", "Enter", "ArrowDown", "Escape", "Tab", "Backspace", " "]) {
      expect(press(field, key), key).toBe(false);
    }
    expect(press(field, " ", { shift: true })).toBe(false);
    expect(active()).toBe(false);
    // An empty field: the chord is a leading space nobody means.
    field.value = "";
    expect(press(field, " ", { shift: true })).toBe(true);
    expect(active()).toBe(true);
  });

  it("with the mode on, a field that has the caret gets every key but Esc; Esc blurs it and the cursor returns to a card", async () => {
    await mountProject();
    press(null, " ", { shift: true });
    const field = screen.getByLabelText("free") as HTMLInputElement;
    field.focus();
    for (const key of ["q", "e", "d", "s", "1", "Enter", "ArrowDown", " "]) expect(press(field, key), key).toBe(false);
    expect(active()).toBe(true);
    expect(press(field, "Escape")).toBe(true);
    expect(document.activeElement).not.toBe(field);
    await waitFor(() => expect(opens()).toContain(document.activeElement));
    expect(active()).toBe(true);
  });

  it("the mode never stops propagation and leaves keys it does not resolve alone", async () => {
    await mountProject();
    press(null, " ", { shift: true });
    const seen: string[] = [];
    const spy = (event: KeyboardEvent) => seen.push(event.key);
    document.addEventListener("keydown", spy);
    expect(press(document.body, "Tab")).toBe(false);
    expect(press(document.body, "F5")).toBe(false);
    expect(press(document.body, "z")).toBe(false);
    press(document.body, "d");
    document.removeEventListener("keydown", spy);
    expect(seen).toEqual(["Tab", "F5", "z", "d"]);
  });

  it("Ctrl, Meta and IME keys are ignored in the mode", async () => {
    await mountProject();
    press(null, " ", { shift: true });
    expect(press(null, "d", { ctrl: true })).toBe(false);
    expect(press(null, "d", { meta: true })).toBe(false);
    expect(press(null, "d", { isComposing: true })).toBe(false);
    expect(press(null, "d", { alt: true })).toBe(false);
    expect(document.activeElement).toBe(opens()[0]);
  });
});

describe("Mobile steering — cursor repair", () => {
  it("puts the cursor back on the remembered card when the list re-renders and focus is lost", async () => {
    await mountProject();
    press(null, " ", { shift: true });
    press(null, "d");
    const second = opens()[1];
    // A poll moved the focused node: the browser blurred it.
    second.blur();
    expect(document.activeElement).toBe(document.body);
    document.body.append(document.createElement("i"));
    await waitFor(() => expect(document.activeElement).toBe(second));
  });

  it("does nothing while the mode is off", async () => {
    await mountProject();
    document.body.append(document.createElement("i"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(document.activeElement).toBe(document.body);
  });
});

describe("Mobile steering — status jumps, section keys and the way back", () => {
  const elsewhere = { id: "x1", label: "x1", kind: "agent", available: true, viewer_busy: false, agent_status: "question", project_id: "q", project_label: "Other" };

  it("Q opens the next tab that waits on you and remembers where it left; Backspace restores that place", async () => {
    activity = [elsewhere];
    const openTab = vi.fn();
    const restore = vi.fn();
    await mountProject({ openTab, restore });
    press(null, " ", { shift: true });
    press(null, "q");
    await waitFor(() => expect(openTab).toHaveBeenCalledTimes(1));
    expect(openTab.mock.calls[0][0]).toBe("q");
    expect(openTab.mock.calls[0][1].id).toBe("x1");
    expect(getSteering().jumpBack).toEqual(LIST_PLACE);
    press(null, "Backspace");
    expect(restore).toHaveBeenCalledWith(LIST_PLACE);
    expect(getSteering().jumpBack).toBeNull();
    press(null, "Backspace");
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it("a jump with nothing to find flashes a message and opens nothing", async () => {
    const openTab = vi.fn();
    await mountProject({ openTab });
    press(null, " ", { shift: true });
    press(null, "r");
    await waitFor(() => expect(getSteering().flash?.key).toBe("mobile.steering.none.working"));
    expect(openTab).not.toHaveBeenCalled();
    expect(getSteering().jumpBack).toBeNull();
  });

  it("M, C and T open the sections and / asks for the search", async () => {
    const openSection = vi.fn();
    const findProject = vi.fn();
    await mountProject({ openSection, findProject });
    press(null, " ", { shift: true });
    press(null, "m");
    press(null, "c");
    press(null, "t");
    press(null, "/");
    expect(openSection.mock.calls.map(([name]) => name)).toEqual(["mail", "calendar", "todo"]);
    expect(findProject).toHaveBeenCalledTimes(1);
  });

  it("the legend key folds and unfolds the bar", async () => {
    await mountProject();
    press(null, " ", { shift: true });
    press(null, "h");
    expect(getSteering().legendFolded).toBe(true);
    press(null, "h");
    expect(getSteering().legendFolded).toBe(false);
  });
});

describe("Mobile steering — Home", () => {
  const projects = [
    { id: "p1", label: "Alpha", status: "active", live_sessions: 1 },
    { id: "p2", label: "Beta", status: "active", live_sessions: 0 },
    { id: "p3", label: "Gamma", status: "active", live_sessions: 0 },
  ];

  beforeEach(() => {
    fetchMock.mockImplementation((input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("/api/v1/alerts")) return Promise.resolve(new Response(JSON.stringify({ alerts: { enabled: false, items: [] } }), { status: 200 }));
      if (url.startsWith("/api/v1/activity")) return Promise.resolve(new Response(JSON.stringify({ tabs: [], desktop_available: true }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({ projects }), { status: 200 }));
    });
  });

  async function mountHome(open: (id: string) => void = () => {}) {
    render(<>
      <BackNest><Home tabby={() => {}} open={open} openTab={() => {}} todo={() => {}} mail={() => {}} /></BackNest>
      <Harness base="projects" place={{ kind: "list", section: "projects", projectId: null }} />
    </>);
    await screen.findByText("Gamma");
  }

  it("the cursor walks the project rows, Enter opens one and a digit opens that row", async () => {
    const open = vi.fn();
    await mountHome(open);
    press(null, " ", { shift: true });
    expect(document.activeElement?.textContent).toContain("Alpha");
    press(null, "d");
    expect(document.activeElement?.textContent).toContain("Beta");
    press(null, "Enter");
    expect(open).toHaveBeenLastCalledWith("p2");
    press(null, "3");
    expect(open).toHaveBeenLastCalledWith("p3");
    press(null, "9");
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("N presses the new-project button", async () => {
    await mountHome();
    press(null, " ", { shift: true });
    press(null, "n");
    expect(await screen.findByRole("dialog", { name: "New project" })).toBeTruthy();
  });

  it("a find request opens the search with the caret in it, and Esc lands on the first result", async () => {
    await mountHome();
    press(null, " ", { shift: true });
    act(() => requestFind());
    const box = await screen.findByPlaceholderText("Project name");
    await waitFor(() => expect(document.activeElement).toBe(box));
    expect(press(box, "e")).toBe(false);
    expect(press(box, "Escape")).toBe(true);
    await waitFor(() => expect(document.activeElement?.textContent).toContain("Alpha"));
    expect(getSteering().active).toBe(true);
  });
});
