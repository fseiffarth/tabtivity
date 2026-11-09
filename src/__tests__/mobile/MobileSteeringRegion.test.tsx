/**
 * Keyboard steering over a sheet (the `region` level): a sheet on top makes it
 * the surface the keys belong to, the cursor walks its controls, Back closes it
 * through the back stack, a field that took the caret by itself takes typing,
 * and a files library or viewer keeps its own keys.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackNest } from "../../../mobile-web/src/backStack";
import { NameSheet } from "../../../mobile-web/src/components/ConfirmSheet";
import { OptionSheet } from "../../../mobile-web/src/components/OptionSheet";
import { getSteering } from "../../../mobile-web/src/steering/steeringState";
import { usePhoneSteering } from "../../../mobile-web/src/steering/usePhoneSteering";
import { press as fire, resetSteering, stubLayout, type KeyMods } from "../helpers/mobileSteering";

let layout: ReturnType<typeof stubLayout>;

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ tabs: [], desktop_available: true }), { status: 200 }))));
  layout = stubLayout();
  vi.spyOn(window.history, "pushState").mockImplementation(() => {});
  vi.spyOn(window.history, "back").mockImplementation(() => { queueMicrotask(() => window.dispatchEvent(new PopStateEvent("popstate"))); });
});

afterEach(() => {
  cleanup();
  resetSteering();
  layout.restore();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function press(target: EventTarget | null, key: string, mods: KeyMods = {}): boolean {
  let prevented = false;
  act(() => { prevented = fire(target, key, mods); });
  return prevented;
}

function Engine() {
  usePhoneSteering({
    enabled: true,
    base: "tabs",
    sectionLabel: null,
    place: { kind: "list", section: "projects", projectId: "p" },
    openTab: () => {},
    openSection: () => {},
    restore: () => {},
    findProject: () => {},
  });
  return null;
}

const OPTIONS = [
  { key: "a", label: "Alpha", current: false },
  { key: "b", label: "Beta", current: false },
  { key: "c", label: "Gamma", current: false },
];

function sheet(props: { onPick?: (key: string) => void; onClose?: () => void } = {}) {
  return <OptionSheet title="Pick one" options={OPTIONS} waiting="" busy={false} onPick={props.onPick ?? (() => {})} onClose={props.onClose ?? (() => {})} />;
}

describe("Mobile steering — a sheet on top is the region", () => {
  it("makes the sheet the level, walks its choices with the arrows and presses one with Enter", async () => {
    const onPick = vi.fn();
    render(<><BackNest><main className="screen"><button>behind</button></main>{sheet({ onPick })}</BackNest><Engine /></>);
    // The sheet put the focus on its first choice.
    expect(document.activeElement?.textContent).toContain("Alpha");
    press(null, " ", { shift: true });
    expect(getSteering().view?.level).toBe("region");
    press(null, "ArrowDown");
    expect(document.activeElement?.textContent).toContain("Beta");
    press(null, "d");
    expect(document.activeElement?.textContent).toContain("Gamma");
    press(null, "ArrowUp");
    press(null, "Enter");
    expect(onPick).toHaveBeenCalledWith("b");
    // The screen behind the sheet is inert: the cursor never leaves the sheet.
    for (let i = 0; i < 6; i++) press(null, "ArrowDown");
    expect(document.activeElement?.closest("[role='dialog']")).toBeTruthy();
  });

  it("→ presses a choice too", async () => {
    const onPick = vi.fn();
    render(<><BackNest>{sheet({ onPick })}</BackNest><Engine /></>);
    press(null, " ", { shift: true });
    press(null, "ArrowRight");
    expect(onPick).toHaveBeenCalledWith("a");
  });

  it("← and S close the sheet through the back stack", async () => {
    const onClose = vi.fn();
    render(<><BackNest>{sheet({ onClose })}</BackNest><Engine /></>);
    press(null, " ", { shift: true });
    press(null, "ArrowLeft");
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    press(null, "s");
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
  });

  it("Esc closes the sheet and does not leave the mode", async () => {
    const onClose = vi.fn();
    render(<><BackNest>{sheet({ onClose })}</BackNest><Engine /></>);
    press(null, " ", { shift: true });
    expect(press(null, "Escape")).toBe(true);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(getSteering().active).toBe(true);
  });

  it("the chord leaves the mode over a sheet; Y with no confirm in it does nothing", async () => {
    const onPick = vi.fn();
    render(<><BackNest>{sheet({ onPick })}</BackNest><Engine /></>);
    press(null, " ", { shift: true });
    expect(press(null, "y")).toBe(true);
    expect(onPick).not.toHaveBeenCalled();
    press(null, " ", { shift: true });
    expect(getSteering().active).toBe(false);
  });
});

describe("Mobile steering — a field that took the caret by itself", () => {
  it("takes typing untouched, and Esc puts it away and carries on in the sheet", async () => {
    const run = vi.fn();
    render(<><BackNest><NameSheet ask={{ title: "Name it", label: "Name", action: "Save", run }} busy={false} onClose={() => {}} /></BackNest><Engine /></>);
    const input = screen.getByLabelText("Name") as HTMLInputElement;
    // `autoFocus` took the caret before steering was on.
    expect(document.activeElement).toBe(input);
    press(null, " ", { shift: true });
    expect(getSteering().active).toBe(true);
    // Entering blurs a focused field.
    expect(document.activeElement).not.toBe(input);
    input.focus();
    for (const key of ["q", "d", "e", "s", "1", "Enter", " ", "ArrowDown"]) expect(press(input, key), key).toBe(false);
    await waitFor(() => expect(getSteering().view?.typing).toBe("field"));
    expect(press(input, "Escape")).toBe(true);
    expect(document.activeElement).not.toBe(input);
    expect(getSteering().active).toBe(true);
    await waitFor(() => expect(getSteering().view?.typing).toBe("none"));
    expect(getSteering().view?.level).toBe("region");
  });
});

describe("Mobile steering — surfaces with their own keys", () => {
  it("an outbox viewer on top passes every key through; the chord still works", async () => {
    render(<><BackNest>
      <div className="outbox-viewer" role="dialog" aria-modal="true"><button>Next picture</button></div>
    </BackNest><Engine /></>);
    press(null, " ", { shift: true });
    expect(getSteering().active).toBe(true);
    expect(getSteering().view?.paused).toBe(true);
    for (const key of ["e", "d", "s", "f", "Enter", "ArrowLeft", "ArrowRight", "Escape", "/", "q", "1"]) expect(press(null, key), key).toBe(false);
    expect(press(null, " ", { shift: true })).toBe(true);
    expect(getSteering().active).toBe(false);
  });

  it("a files library on top is paused too", async () => {
    render(<><BackNest><section className="files-library" role="dialog" aria-modal="true"><button>File</button></section></BackNest><Engine /></>);
    press(null, " ", { shift: true });
    expect(getSteering().view?.paused).toBe(true);
    expect(press(null, "ArrowDown")).toBe(false);
  });

  it("a sheet opened over such a surface is walked as a region", async () => {
    const onPick = vi.fn();
    render(<><BackNest>
      <div className="outbox-viewer" role="dialog" aria-modal="true"><button>Next picture</button></div>
      {sheet({ onPick })}
    </BackNest><Engine /></>);
    press(null, " ", { shift: true });
    expect(getSteering().view?.paused).toBe(false);
    expect(getSteering().view?.level).toBe("region");
    press(null, "ArrowDown");
    expect(document.activeElement?.textContent).toContain("Beta");
    press(null, "Enter");
    expect(onPick).toHaveBeenCalledWith("b");
  });
});
