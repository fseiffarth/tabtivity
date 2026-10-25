import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HintMessage } from "../../../mobile-web/src/components/HintMessage";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("phone hint messages", () => {
  it("closes for one visit and returns on the next launch without the checkbox", () => {
    const first = render(<HintMessage hint="agentHold" floating />);
    expect(screen.getByRole("status").textContent).toContain("hold the ＋ button");
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
    expect(screen.queryByText(/Your default agent is open/)).toBeNull();
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
});
