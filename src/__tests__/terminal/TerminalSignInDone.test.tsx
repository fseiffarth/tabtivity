import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { TerminalSignInDoneCard } from "../../components/terminal/TerminalSignInCard";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("TerminalSignInDoneCard", () => {
  it("sends Enter through Continue when the program waits for it, and stays", () => {
    vi.useFakeTimers();
    const onContinue = vi.fn();
    const onDismiss = vi.fn();
    const { getByRole } = render(
      <TerminalSignInDoneCard host={document.body} pressEnter onContinue={onContinue} onDismiss={onDismiss} />,
    );
    act(() => void vi.advanceTimersByTime(60_000));
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.click(getByRole("button", { name: "Continue" }));
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it("closes by itself when the program needs nothing more", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const { getByText } = render(
      <TerminalSignInDoneCard host={document.body} pressEnter={false} onContinue={vi.fn()} onDismiss={onDismiss} />,
    );
    expect(getByText("Signed in")).toBeTruthy();
    act(() => void vi.advanceTimersByTime(8_000));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
