import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HintMessage, HintQueue, resetTips } from "../../../mobile-web/src/components/HintMessage";
import { readFlag, readHintReads, writeFlag, writeHintReads, writeTipShownAt } from "../../../mobile-web/src/prefs";

beforeEach(() => {
  localStorage.clear();
  resetTips();
});
/** Moves the phone's clock past the half hour between two tips. */
function halfHourLater(): void {
  const now = Date.now() + 30 * 60_000;
  vi.spyOn(Date, "now").mockReturnValue(now);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("phone hint messages", () => {
  it("closes for one visit and returns after the half hour", () => {
    const first = render(<HintMessage hint="agentHold" floating vars={{ agent: "Claude" }} />);
    expect(screen.getByRole("status").textContent).toBe("Tapping ＋ opens Claude; hold ＋ to start a different agent.");
    fireEvent.click(screen.getByRole("button", { name: "Close tip" }));
    expect(screen.queryByRole("complementary", { name: "Tip" })).toBeNull();
    first.unmount();
    render(<HintMessage hint="agentHold" floating />);
    expect(screen.queryByRole("complementary", { name: "Tip" })).toBeNull();
    cleanup();
    halfHourLater();
    render(<HintMessage hint="agentHold" floating />);
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("Skip closes the tip for this visit without counting a read", () => {
    const first = render(<HintMessage hint="agentHold" />);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(screen.queryByRole("complementary", { name: "Tip" })).toBeNull();
    expect(readHintReads()).toEqual({});
    first.unmount();
    halfHourLater();
    render(<HintMessage hint="agentHold" />);
    expect(screen.getByText(/Tapping ＋ opens/)).toBeTruthy();
  });

  it("Read counts a read for that tip only and keeps it away for this launch", () => {
    const first = render(<HintMessage hint="agentHold" />);
    fireEvent.click(screen.getByRole("button", { name: "Read" }));
    expect(screen.queryByRole("complementary", { name: "Tip" })).toBeNull();
    expect(readHintReads()).toEqual({ agentHold: 1 });
    first.unmount();
    halfHourLater();
    render(<><HintMessage hint="agentHold" /><HintMessage hint="agentDefault" /></>);
    expect(screen.queryByText(/Tapping ＋ opens/)).toBeNull();
    expect(screen.getByText(/Tap ☆ beside an agent/)).toBeTruthy();
  });

  it("a read tip shows on a later launch only when it wins its halved draw", () => {
    writeHintReads({ projectFiles: 2 });
    vi.spyOn(Math, "random").mockReturnValue(0.3);
    const lost = render(<HintMessage hint="projectFiles" />);
    // Read twice: a quarter chance, and 0.3 misses it.
    expect(screen.queryByRole("complementary", { name: "Tip" })).toBeNull();
    lost.unmount();
    // The draw holds for the rest of the launch, whatever the next roll says.
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    render(<HintMessage hint="projectFiles" />);
    expect(screen.queryByRole("complementary", { name: "Tip" })).toBeNull();
    cleanup();
    resetTips();
    writeHintReads({ projectFiles: 2 });
    render(<HintMessage hint="projectFiles" />);
    expect(screen.getByText(/Tap ☰ to open/)).toBeTruthy();
  });

  it("Turn off tips says where to turn them on and silences every tip", () => {
    const first = render(<HintMessage hint="agentHold" />);
    fireEvent.click(screen.getByRole("button", { name: "Turn off tips" }));
    expect(screen.getByText(/This device → Tips/)).toBeTruthy();
    expect(readFlag("hintsOff")).toBe(true);
    first.unmount();
    render(<><HintMessage hint="agentHold" /><HintMessage hint="agentDefault" /></>);
    expect(screen.queryByRole("complementary", { name: "Tip" })).toBeNull();
  });

  it("Reset tips brings back read, turned-off and old never-again tips", () => {
    writeFlag("hintsOff", true);
    writeFlag("hintAgentDefault", true);
    resetTips();
    render(<HintMessage hint="agentDefault" />);
    expect(screen.getByText(/Tap ☆ beside an agent/)).toBeTruthy();
    expect(readHintReads()).toEqual({});
  });

  it("queues tips for one spot: closing ends the spot for the visit, a turned-off one is skipped", () => {
    writeFlag("hintSendHold", true);
    const first = render(<HintQueue hints={["sendHold", "chatMenu", "chatSwipe"]} />);
    expect(screen.queryByText(/Hold the send button/)).toBeNull();
    expect(screen.getByText(/Chat ▾/)).toBeTruthy();
    expect(screen.getAllByRole("complementary", { name: "Tip" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Read" }));
    // The next tip never takes the closed one's place.
    expect(screen.queryByRole("complementary", { name: "Tip" })).toBeNull();
    first.unmount();
    halfHourLater();
    render(<HintQueue hints={["sendHold", "chatMenu", "chatSwipe"]} />);
    expect(screen.getByText(/Swipe right over the chat/)).toBeTruthy();
  });

  it("shows one tip per half hour across screens; the open one comes back until closed", () => {
    const chat = render(<HintQueue hints={["chatMenu"]} />);
    expect(screen.getByText(/Chat ▾/)).toBeTruthy();
    // Another screen's tip waits while this one holds the half hour.
    const todo = render(<HintQueue hints={["todoDone"]} />);
    expect(screen.getAllByRole("complementary", { name: "Tip" })).toHaveLength(1);
    todo.unmount();
    chat.unmount();
    // Left open, it is back on its screen; closed, it waits like the others.
    render(<HintQueue hints={["chatMenu"]} />);
    expect(screen.getByText(/Chat ▾/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    cleanup();
    render(<><HintQueue hints={["chatMenu"]} /><HintQueue hints={["todoDone"]} /></>);
    expect(screen.queryByRole("complementary", { name: "Tip" })).toBeNull();
    cleanup();
    halfHourLater();
    render(<HintQueue hints={["todoDone"]} />);
    expect(screen.getAllByRole("complementary", { name: "Tip" })).toHaveLength(1);
  });

  it("the half hour holds across a reload, and a stored time ahead of the clock does not block", () => {
    writeTipShownAt(Date.now() - 60_000);
    render(<HintMessage hint="agentDefault" />);
    expect(screen.queryByRole("complementary", { name: "Tip" })).toBeNull();
    cleanup();
    writeTipShownAt(Date.now() + 3_600_000);
    render(<HintMessage hint="agentDefault" />);
    expect(screen.getByText(/Tap ☆ beside an agent/)).toBeTruthy();
  });
});
