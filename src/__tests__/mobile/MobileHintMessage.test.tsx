import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HintMessage, HintQueue } from "../../../mobile-web/src/components/HintMessage";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("phone hint messages", () => {
  it("closes for one visit and returns on the next launch without the checkbox", () => {
    const first = render(<HintMessage hint="agentHold" floating vars={{ agent: "Claude" }} />);
    expect(screen.getByRole("status").textContent).toBe("Tapping ＋ opens Claude; hold ＋ to start a different agent.");
    fireEvent.click(screen.getByRole("button", { name: "Close tip" }));
    expect(screen.queryByRole("complementary", { name: "Tip" })).toBeNull();
    first.unmount();
    render(<HintMessage hint="agentHold" floating />);
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("remembers suppression across remounts, only for the selected message", () => {
    const first = render(<HintMessage hint="agentHold" />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Never show this message again" }));
    // Saving does not take away the chance to uncheck before closing.
    expect(screen.getByRole("button", { name: "Close tip" })).toBeTruthy();
    first.unmount();
    render(<><HintMessage hint="agentHold" /><HintMessage hint="agentDefault" /></>);
    expect(screen.queryByText(/Tapping ＋ opens/)).toBeNull();
    expect(screen.getByText(/Tap ☆ beside an agent/)).toBeTruthy();
  });

  it("restores future messages when the checkbox is unchecked", () => {
    const first = render(<HintMessage hint="projectFiles" />);
    const checkbox = screen.getByRole("checkbox", { name: "Never show this message again" });
    fireEvent.click(checkbox);
    fireEvent.click(checkbox);
    first.unmount();
    render(<HintMessage hint="projectFiles" />);
    expect(screen.getByText(/Tap ☰ to open/)).toBeTruthy();
  });

  it("queues tips for one spot: × ends the spot for the visit, a turned-off one is skipped", () => {
    localStorage.clear();
    const first = render(<HintQueue hints={["sendHold", "chatMenu", "chatSwipe"]} />);
    expect(screen.getByText(/Hold the send button/)).toBeTruthy();
    expect(screen.getAllByRole("complementary", { name: "Tip" })).toHaveLength(1);
    // Ticking the checkbox keeps the card up until it is closed.
    fireEvent.click(screen.getByRole("checkbox", { name: "Never show this message again" }));
    expect(screen.getByText(/Hold the send button/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close tip" }));
    // The next tip never takes the closed one's place.
    expect(screen.queryByRole("complementary", { name: "Tip" })).toBeNull();
    first.unmount();
    render(<HintQueue hints={["sendHold", "chatMenu", "chatSwipe"]} />);
    expect(screen.queryByText(/Hold the send button/)).toBeNull();
    expect(screen.getByText(/Chat ▾/)).toBeTruthy();
  });
});
