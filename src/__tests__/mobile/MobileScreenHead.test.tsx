import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScreenHead } from "../../../mobile-web/src/components/ScreenHead";
import { OptionSheet } from "../../../mobile-web/src/components/OptionSheet";

afterEach(cleanup);

describe("ScreenHead", () => {
  it("renders the title, the subtitle and the action buttons", () => {
    const onOther = vi.fn();
    render(<ScreenHead title="Mail" subtitle={<button>Work · 3 unread</button>}
      actions={<button className="home-head-button" aria-label="Info" onClick={onOther}>i</button>} />);
    expect(screen.getByRole("heading", { level: 1, name: "Mail" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Work · 3 unread" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Info" }));
    expect(onOther).toHaveBeenCalledTimes(1);
  });

  it("draws the refresh button first, labelled, and disables it while refreshing", () => {
    const onRefresh = vi.fn();
    const { container, rerender } = render(<ScreenHead title="To-do" onRefresh={onRefresh} actions={<button aria-label="More">m</button>} />);
    const buttons = [...container.querySelectorAll(".screen-head-actions > button")];
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Refresh", "More"]);
    expect(buttons[0].classList.contains("home-head-button")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    rerender(<ScreenHead title="To-do" onRefresh={onRefresh} refreshing />);
    expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a back row with the parent's name only when given one, and it fires", () => {
    const onBack = vi.fn();
    const { container, rerender } = render(<ScreenHead title="Inbox" back={{ label: "Mail", onClick: onBack }} />);
    const back = container.querySelector(".screen-head-back");
    expect(back?.textContent).toBe("Mail");
    expect(back?.querySelector("svg")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mail" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    rerender(<ScreenHead title="Mail" />);
    expect(container.querySelector(".screen-head-back")).toBeNull();
    expect(container.querySelector(".screen-head-actions")).toBeNull();
  });
});

describe("OptionSheet additions", () => {
  const base = { title: "Sheet", busy: false, onPick: () => {}, onClose: () => {} };

  it("keeps a disabled row visible but not tappable", () => {
    const onPick = vi.fn();
    render(<OptionSheet {...base} onPick={onPick} waiting="" options={[
      { key: "a", label: "Move up", current: false, disabled: true },
      { key: "b", label: "Move down", current: false },
    ]} />);
    const up = screen.getByRole("button", { name: "Move up" }) as HTMLButtonElement;
    expect(up.disabled).toBe(true);
    fireEvent.click(up);
    fireEvent.click(screen.getByRole("button", { name: "Move down" }));
    expect(onPick.mock.calls).toEqual([["b"]]);
  });

  it("draws no empty waiting line for a sheet of only a note", () => {
    const { container } = render(<OptionSheet {...base} waiting="" note={{ text: "Rules" }} options={[]} />);
    expect(container.querySelectorAll(".sheet-note")).toHaveLength(1);
    expect(screen.getByText("Rules")).toBeTruthy();
  });
});
