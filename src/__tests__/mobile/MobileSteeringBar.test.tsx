/**
 * The steering legend (`SteeringBar`): the ladder and the keys per level, the
 * status keys that hide at a count of zero, the answer key that follows the
 * live question, H folding it, and the one-time keyboard tip.
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SteeringBar } from "../../../mobile-web/src/steering/SteeringBar";
import { usePhoneSteering } from "../../../mobile-web/src/steering/usePhoneSteering";
import {
  flash,
  getSteering,
  registerInside,
  setActive,
  setActivity,
  setJumpBack,
  setView,
  type Place,
  type SteeringView,
} from "../../../mobile-web/src/steering/steeringState";
import { readFlag, writeFlag } from "../../../mobile-web/src/prefs";
import type { ActivityTab } from "../../../mobile-web/src/api";
import { press as fire, resetSteering, type KeyMods } from "../helpers/mobileSteering";

const PLACE: Place = { kind: "list", section: "projects", projectId: null };
function Harness({ base = "projects" as const }: { base?: "projects" | "tabs" | "inside" | "section" }) {
  usePhoneSteering({
    enabled: true, base, sectionLabel: null, place: PLACE,
    openTab: () => {}, openSection: () => {}, restore: () => {}, findProject: () => {},
  });
  return null;
}

function press(target: EventTarget | null, key: string, mods: KeyMods = {}): boolean {
  let prevented = false;
  act(() => { prevented = fire(target, key, mods); });
  return prevented;
}

const view = (level: SteeringView["level"], extra: Partial<SteeringView> = {}): SteeringView =>
  ({ level, paused: false, typing: "none", sectionLabel: null, ...extra });
const show = (v: SteeringView) => act(() => { setActive(true); setView(v); });

const tab = (id: string, status: string, extra: Record<string, unknown> = {}) =>
  ({ id, label: id, kind: "agent", available: true, viewer_busy: false, agent_status: status, project_id: "p", project_label: "P", ...extra }) as unknown as ActivityTab;

const bar = () => document.querySelector<HTMLElement>(".steer-bar")!;
const keys = () => [...document.querySelectorAll(".steer-keys li")].map((li) => li.textContent ?? "");
/** The bold ladder entry, without its untested pill. */
const current = () => (document.querySelector(".steer-ladder .current")?.firstChild?.textContent ?? "").trim();

beforeEach(() => {
  localStorage.clear();
  // The engine refreshes the legend counts while the mode is on.
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ tabs: [], desktop_available: true }), { status: 200 }))));
});
afterEach(() => {
  cleanup();
  resetSteering();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SteeringBar", () => {
  it("renders nothing while the mode is off", () => {
    render(<SteeringBar />);
    expect(document.querySelector(".steer-bar")).toBeNull();
  });

  it("shows the badge, the ladder with the current level bold, and the level's keys", () => {
    render(<SteeringBar />);
    show(view("projects"));
    within(bar()).getByText("Steering");
    expect([...document.querySelectorAll(".steer-ladder li")].map((li) => li.textContent)).toEqual(["Projects", "Tabs", "Inside the tab"]);
    expect(current()).toBe("Projects");
    const text = keys().join("|");
    expect(text).toContain("Move");
    expect(text).toContain("Back");
    expect(text).toContain("Open");
    expect(text).toContain("New project");
    expect(text).toContain("1–9");
    expect(text).toContain("Exit");
    // Up and down read as one chip.
    expect(keys().filter((k) => k.includes("Move"))).toHaveLength(1);
    expect(document.querySelector(".steer-legend")?.textContent).toContain("Keys");

    act(() => setView(view("tabs")));
    expect(current()).toBe("Tabs");
    expect(keys().join("|")).toContain("Close");
    expect(keys().join("|")).not.toContain("New project");

    act(() => setView(view("inside")));
    expect(current()).toBe("Inside the tab");
    const inside = keys().join("|");
    expect(inside).toContain("Scroll");
    expect(inside).toContain("Latest");
    expect(inside).toContain("Type to the agent");
  });

  it("puts a sheet and a section off the ladder", () => {
    render(<SteeringBar />);
    show(view("region"));
    expect(current()).toBe("Sheet");
    expect(keys().join("|")).toContain("Yes");
    act(() => setView(view("section", { sectionLabel: "mobile.tabs.mail" })));
    expect(current()).toBe("Mail");
  });

  it("lists Mail, Calendar and To-do as one chip", () => {
    render(<SteeringBar />);
    show(view("projects"));
    const chip = keys().find((k) => k.includes("Mail"))!;
    expect(chip).toContain("M C T");
    expect(chip).toContain("Calendar");
    expect(chip).toContain("To-do");
  });

  it("hides the status keys at a count of zero and shows the counts otherwise", () => {
    render(<SteeringBar />);
    show(view("projects"));
    expect(keys().join("|")).not.toContain("Needs an answer");
    expect(keys().join("|")).not.toContain("Working");
    act(() => setActivity([tab("a", "question"), tab("b", "interrupted"), tab("c", "working"), tab("d", "working", { available: false })]));
    const ask = keys().find((k) => k.includes("Needs an answer"))!;
    const working = keys().find((k) => k.includes("Working"))!;
    expect(ask).toMatch(/Q.*2/);
    expect(working).toMatch(/R.*1/);
    expect(keys().join("|")).not.toContain("Done");
    act(() => setActivity([]));
    expect(keys().join("|")).not.toContain("Needs an answer");
  });

  it("shows the answer key only while a question is up, and Jump back only after a jump", () => {
    render(<SteeringBar />);
    show(view("inside"));
    expect(keys().join("|")).not.toContain("Answer");
    act(() => registerInside({ answer: () => "answered", focusComposer: () => "focused", hasQuestion: () => true }));
    expect(keys().find((k) => k.includes("Answer"))).toContain("1–9");
    act(() => registerInside(null));
    expect(keys().join("|")).not.toContain("Answer");
    expect(keys().join("|")).not.toContain("Jump back");
    act(() => setJumpBack(PLACE));
    expect(keys().join("|")).toContain("Jump back");
  });

  it("says what the view is doing instead of listing keys: paused, typing", () => {
    render(<SteeringBar />);
    show(view("tabs", { paused: true }));
    within(bar()).getByText("This view has its own keys");
    expect(document.querySelector(".steer-keys")).toBeNull();
    act(() => setView(view("inside", { typing: "composer" })));
    within(bar()).getByText("Typing — Enter sends, Esc back to steering");
    act(() => setView(view("region", { typing: "field" })));
    within(bar()).getByText("Typing — Esc back to steering");
  });

  it("announces a flash in a polite status line", () => {
    render(<SteeringBar />);
    show(view("projects"));
    const line = document.querySelector(".steer-flash")!;
    expect(line.getAttribute("role")).toBe("status");
    expect(line.getAttribute("aria-live")).toBe("polite");
    act(() => flash("mobile.steering.noOption", { n: 7 }));
    expect(line.textContent).toBe("No option 7");
    expect(document.querySelector(".steer-keys")).toBeNull();
  });

  it("H folds the legend and unfolds it, and the root attribute follows", async () => {
    render(<><SteeringBar /><Harness /></>);
    press(document.body, " ", { shift: true });
    expect(getSteering().active).toBe(true);
    expect(document.documentElement.hasAttribute("data-steer-bar")).toBe(true);
    press(document.body, "h");
    expect(document.querySelector(".steer-bar.folded")?.textContent).toBe("Steering — H shows the keys");
    expect(document.documentElement.hasAttribute("data-steer-bar")).toBe(false);
    press(document.body, "h");
    expect(document.querySelector(".steer-bar.folded")).toBeNull();
    expect(document.documentElement.hasAttribute("data-steer-bar")).toBe(true);
    await act(async () => {});
  });
});

describe("the keyboard tip", () => {
  it("shows once on the first hardware key, names the chord and keys, and never again", () => {
    const { unmount } = render(<SteeringBar />);
    expect(screen.queryByRole("status")).toBeNull();
    press(document.body, "ArrowDown");
    expect(screen.getByRole("status").textContent).toContain("Keyboard connected — Shift+Space steers with E S D F");
    expect(readFlag("hintSteering")).toBe(true);
    // The next key dismisses it.
    press(document.body, "ArrowDown");
    expect(screen.queryByRole("status")).toBeNull();
    // A reload (a new mount) with the flag set stays silent.
    unmount();
    render(<SteeringBar />);
    press(document.body, "ArrowDown");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("goes away on its own after about 8 seconds", () => {
    vi.useFakeTimers();
    render(<SteeringBar />);
    press(document.body, "Tab");
    expect(document.querySelector(".steer-tip")).not.toBeNull();
    act(() => { vi.advanceTimersByTime(8100); });
    expect(document.querySelector(".steer-tip")).toBeNull();
  });

  it("is silent while tips are off, and does not use itself up", () => {
    writeFlag("hintsOff", true);
    render(<SteeringBar />);
    press(document.body, "ArrowDown");
    expect(document.querySelector(".steer-tip")).toBeNull();
    expect(readFlag("hintSteering")).toBe(false);
  });

  it("does not take typing on an on-screen keyboard for a hardware key", () => {
    render(<><SteeringBar /><textarea aria-label="draft" /></>);
    const field = screen.getByLabelText("draft");
    field.focus();
    press(field, "a");
    press(field, "Enter");
    expect(document.querySelector(".steer-tip")).toBeNull();
    expect(readFlag("hintSteering")).toBe(false);
  });

  it("is not shown to someone who already pressed the chord", async () => {
    render(<><SteeringBar /><Harness /></>);
    press(document.body, " ", { shift: true });
    expect(document.querySelector(".steer-tip")).toBeNull();
    expect(readFlag("hintSteering")).toBe(true);
    await act(async () => {});
  });
});
