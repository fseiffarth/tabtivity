import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { ReaderSubagentDock } from "../../components/terminal/ReaderSubagentDock";
import type { DockAgent } from "../../lib/agents/subagentDock";

function Dock({ agents, active = true, onPick = () => {}, main }: {
  agents: DockAgent[] | null;
  active?: boolean;
  onPick?: (agent: DockAgent, fromList: boolean) => void;
  main?: { label: string; title: string; onUp: () => void };
}) {
  const [open, setOpen] = useState(false);
  return <ReaderSubagentDock agents={agents} earlier={0} active={active} listOpen={open} onListOpen={setOpen} listId="dock-list" onPick={onPick} onEarlier={() => {}} main={main} />;
}

afterEach(() => vi.useRealTimers());

describe("the Chat's subagent dock", () => {
  it("draws nothing with nothing to say", () => {
    const { container } = render(<Dock agents={[]} />);
    expect(container.querySelector(".terminal-reader-agent-dock")).toBeNull();
    render(<Dock agents={null} />);
    expect(document.querySelector(".terminal-reader-agent-dock")).toBeNull();
  });

  it("opens the picked pill, marks a waiting one disabled, and toggles the list from the done pill", () => {
    const onPick = vi.fn();
    render(<Dock onPick={onPick} agents={[
      { key: "a", token: "t-a", role: "Explore", task: "Find the parser", atWork: true },
      { key: "b", role: "Plan", task: "Not recorded yet", atWork: true },
      { key: "c", token: "t-c", role: "Explore", task: "Find the tests", atWork: false },
    ]} />);
    const pills = [...document.querySelectorAll<HTMLButtonElement>(".terminal-reader-agent-pill:not(.done)")];
    expect(pills.map((pill) => pill.querySelector("b")?.textContent)).toEqual(["Explore", "Plan"]);
    expect(pills[1].classList.contains("waiting")).toBe(true);
    expect(pills[1].disabled).toBe(true);
    fireEvent.click(pills[0]);
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ key: "a" }), false);
    const done = screen.getByRole("button", { name: /1 done/ });
    expect(done.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(done);
    const list = document.getElementById("dock-list")!;
    expect(list.closest(".terminal-reader-agents-done")).not.toBeNull();
    fireEvent.click(within(list).getByText("Find the tests").closest("button")!);
    expect(onPick).toHaveBeenLastCalledWith(expect.objectContaining({ key: "c" }), true);
    // Esc closes it and hands the focus back to the done pill.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.getElementById("dock-list")).toBeNull();
    expect(document.activeElement).toBe(done);
  });

  it("leads with a Main pill while a subagent is open", () => {
    const onUp = vi.fn();
    render(<Dock main={{ label: "Main", title: "Back to the main conversation", onUp }} agents={[
      { key: "a", token: "t-a", task: "Find the parser", atWork: false, selected: true },
    ]} />);
    const pills = [...document.querySelectorAll<HTMLButtonElement>(".terminal-reader-agent-pill")];
    expect(pills[0].classList.contains("main")).toBe(true);
    expect(pills[1].classList.contains("selected")).toBe(true);
    expect(pills[1].classList.contains("finished")).toBe(true);
    // A finished one shows no dots and no time.
    expect(pills[1].querySelector(".terminal-reader-working-dots")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to the main conversation" }));
    expect(onUp).toHaveBeenCalledTimes(1);
  });

  it("counts the running pills' time on each second, and never while the pane is hidden", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T08:00:52Z"));
    const agents: DockAgent[] = [{ key: "a", token: "t-a", task: "Find the parser", at: "2026-09-30T08:00:10Z", atWork: true }];
    const setInterval = vi.spyOn(window, "setInterval");
    const view = render(<Dock agents={agents} active={false} />);
    const time = () => document.querySelector(".terminal-reader-agent-pill-time")?.textContent;
    expect(time()).toBe("42s");
    act(() => { vi.advanceTimersByTime(5000); });
    expect(time()).toBe("42s");
    expect(setInterval).not.toHaveBeenCalled();
    view.rerender(<Dock agents={agents} active />);
    expect(time()).toBe("47s");
    act(() => { vi.advanceTimersByTime(2000); });
    expect(time()).toBe("49s");
    expect(setInterval).toHaveBeenCalledTimes(1);
    setInterval.mockRestore();
  });
});
