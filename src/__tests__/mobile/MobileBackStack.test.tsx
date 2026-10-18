import { act, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackNest, canGoBack, goBack, resetBackStackForTests, useBackLayer } from "../../../mobile-web/src/backStack";
import { BRAND } from "../../lib/brand";

/** The page's history as the phone's browser keeps it: entries above the
 * page's own, and a back that pops one and fires `popstate` a moment later. */
let entries = 0;
let pushes = 0;
let ownBacks = 0;

function pressBack() {
  // What Android's gesture does: the browser pops an entry, then tells the page.
  entries = Math.max(0, entries - 1);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
}

function Sheet({ name, onClose, log }: { name: string; onClose: () => void; log: string[] }) {
  useBackLayer(() => { log.push(name); onClose(); });
  return <p>{name}</p>;
}

describe(`${BRAND.display} Mobile Back`, () => {
  beforeEach(() => {
    resetBackStackForTests();
    entries = 0;
    pushes = 0;
    ownBacks = 0;
    vi.spyOn(window.history, "pushState").mockImplementation(() => { entries += 1; pushes += 1; });
    vi.spyOn(window.history, "back").mockImplementation(() => {
      ownBacks += 1;
      entries = Math.max(0, entries - 1);
      queueMicrotask(() => window.dispatchEvent(new PopStateEvent("popstate")));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("puts one guard on while a sheet is open and Back closes it", async () => {
    const log: string[] = [];
    function Host() {
      const [open, setOpen] = useState(true);
      return open ? <Sheet name="sheet" log={log} onClose={() => setOpen(false)} /> : null;
    }
    const view = render(<Host />);
    expect(entries).toBe(1);
    expect(canGoBack()).toBe(true);
    act(() => pressBack());
    await settle();
    expect(log).toEqual(["sheet"]);
    expect(view.queryByText("sheet")).toBeNull();
    // Closed by Back: the guard is already gone, nothing is pushed again.
    expect(entries).toBe(0);
    expect(ownBacks).toBe(0);
    expect(canGoBack()).toBe(false);
  });

  it("takes the guard off when the sheet closes by its own button", async () => {
    const log: string[] = [];
    let close = () => {};
    function Host() {
      const [open, setOpen] = useState(true);
      close = () => setOpen(false);
      return open ? <Sheet name="sheet" log={log} onClose={() => setOpen(false)} /> : null;
    }
    render(<Host />);
    expect(entries).toBe(1);
    act(() => close());
    await settle();
    expect(ownBacks).toBe(1);
    expect(entries).toBe(0);
    // Our own pop steps nothing back.
    expect(log).toEqual([]);
  });

  it("steps back the top layer first and keeps one guard for the rest", async () => {
    const log: string[] = [];
    function Host() {
      const [screen, setScreen] = useState(true);
      const [sheet, setSheet] = useState(false);
      useBackLayer(() => { log.push("screen"); setScreen(false); }, screen);
      return <BackNest>
        {screen && <button onClick={() => setSheet(true)}>open</button>}
        {sheet && <Sheet name="sheet" log={log} onClose={() => setSheet(false)} />}
      </BackNest>;
    }
    const view = render(<Host />);
    act(() => view.getByText("open").click());
    expect(entries).toBe(1);
    act(() => pressBack());
    await settle();
    expect(log).toEqual(["sheet"]);
    expect(entries).toBe(1);
    act(() => pressBack());
    await settle();
    expect(log).toEqual(["sheet", "screen"]);
    expect(entries).toBe(0);
  });

  it("puts a sheet opened on a screen's arrival above the screen", async () => {
    const log: string[] = [];
    function Host() {
      const [screen, setScreen] = useState(true);
      const [sheet, setSheet] = useState(true);
      useBackLayer(() => { log.push("screen"); setScreen(false); }, screen);
      // Mounted in the same commit: its effect runs before the host's.
      return <BackNest>{sheet && <Sheet name="sheet" log={log} onClose={() => setSheet(false)} />}</BackNest>;
    }
    render(<Host />);
    act(() => pressBack());
    await settle();
    expect(log).toEqual(["sheet"]);
  });

  it("re-guards a layer that stays open after stepping back", async () => {
    const steps: number[] = [];
    function Library() {
      const [trail, setTrail] = useState(3);
      useBackLayer(() => { steps.push(trail); setTrail((n) => n - 1); });
      return <p>{trail}</p>;
    }
    render(<Library />);
    act(() => pressBack());
    await settle();
    expect(steps).toEqual([3]);
    expect(entries).toBe(1);
    expect(pushes).toBe(2);
  });

  it("an in-app back goes through the guard, and does nothing with nothing open", async () => {
    const log: string[] = [];
    function Host() {
      const [open, setOpen] = useState(true);
      return open ? <Sheet name="sheet" log={log} onClose={() => setOpen(false)} /> : null;
    }
    render(<Host />);
    act(() => goBack());
    await settle();
    expect(log).toEqual(["sheet"]);
    expect(entries).toBe(0);
    const backs = ownBacks;
    act(() => goBack());
    await settle();
    expect(ownBacks).toBe(backs);
  });

  it("a hidden subtree takes no Back", () => {
    const log: string[] = [];
    render(<BackNest off><Sheet name="tucked" log={log} onClose={() => {}} /></BackNest>);
    expect(entries).toBe(0);
    expect(canGoBack()).toBe(false);
  });
});
