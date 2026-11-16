import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReaderSelectionMenu } from "../../components/terminal/ReaderSelectionMenu";
import { copyText } from "../../lib/terminal/copyText";

vi.mock("../../lib/terminal/copyText", () => ({ copyText: vi.fn().mockResolvedValue(undefined) }));

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  vi.clearAllMocks();
});

function Chat({ onInsert, enabled = true }: { onInsert?: (text: string) => void; enabled?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  return <>
    <div ref={root}><p data-testid="answer">First line{"\n"}Second line</p></div>
    <p data-testid="outside">Another pane</p>
    <ReaderSelectionMenu root={root} enabled={enabled} onInsert={onInsert} />
  </>;
}

function select(element: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

const menu = () => document.querySelector(".context-menu-portal");
const button = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });

describe("Chat selected-text menu", () => {
  it("copies the captured selection after the browser selection clears", async () => {
    render(<Chat />);
    select(screen.getByTestId("answer"));
    fireEvent.contextMenu(screen.getByTestId("answer"));
    window.getSelection()?.removeAllRanges();
    fireEvent.click(button("Copy"));
    await waitFor(() => expect(menu()).toBeNull());
    expect(copyText).toHaveBeenCalledWith("First line\nSecond line");
    expect(screen.queryByRole("button", { name: /Add to draft/ })).toBeNull();
  });

  it.each([
    ["Add to draft", "First line\nSecond line"],
    ["Quote in reply", "\n\n> First line\n> Second line\n\n"],
  ])("%s inserts selected text into the draft", (action, expected) => {
    const insert = vi.fn();
    render(<Chat onInsert={insert} />);
    select(screen.getByTestId("answer"));
    fireEvent.contextMenu(screen.getByTestId("answer"));
    fireEvent.click(button(action));
    expect(insert).toHaveBeenCalledWith(expected);
    expect(menu()).toBeNull();
  });

  it("ignores empty selections and selections belonging to another pane", () => {
    render(<Chat />);
    fireEvent.contextMenu(screen.getByTestId("answer"));
    expect(menu()).toBeNull();
    select(screen.getByTestId("outside"));
    fireEvent.contextMenu(screen.getByTestId("answer"));
    expect(menu()).toBeNull();
  });

  it("dismisses when the chat is hidden", () => {
    const view = render(<Chat />);
    select(screen.getByTestId("answer"));
    fireEvent.contextMenu(screen.getByTestId("answer"));
    expect(menu()).not.toBeNull();
    view.rerender(<Chat enabled={false} />);
    expect(menu()).toBeNull();
  });
});
