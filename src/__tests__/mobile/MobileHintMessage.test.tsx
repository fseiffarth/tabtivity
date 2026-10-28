import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HintMessage, HintQueue, resetTips } from "../../../mobile-web/src/components/HintMessage";
import { readFlag, readHintReads, writeFlag, writeHintReads } from "../../../mobile-web/src/prefs";

beforeEach(() => {
  localStorage.clear();
  resetTips();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("phone hint messages", () => {
  it("closes for one visit and returns on the next launch", () => {
    const first = render(<HintMessage hint="agentHold" floating vars={{ agent: "Claude" }} />);
    expect(screen.getByRole("status").textContent).toBe("Tapping ＋ opens Claude; hold ＋ to start a different agent.");
    fireEvent.click(screen.getByRole("button", { name: "Close tip" }));
    expect(screen.queryByRole("complementary", { name: "Tip" })).toBeNull();
    first.unmount();
    render(<HintMessage hint="agentHold" floating />);
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("Read counts a read for that tip only and keeps it away for this launch", () => {
    const first = render(<HintMessage hint="agentHold" />);
    fireEvent.click(screen.getByRole("button", { name: "Read" }));
    expect(screen.queryByRole("complementary", { name: "Tip" })).toBeNull();
    expect(readHintReads()).toEqual({ agentHold: 1 });
    first.unmount();
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
    render(<HintQueue hints={["sendHold", "chatMenu", "chatSwipe"]} />);
    expect(screen.getByText(/Swipe right over the chat/)).toBeTruthy();
  });
});
