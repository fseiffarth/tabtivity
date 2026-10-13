/**
 * The header's global inbox: hidden while empty, a count while files wait,
 * rows that open by leaf name, and a delete that arms before it deletes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { InboxIndicator, displayName } from "../../components/header/InboxIndicator";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { useOpenExternalStore } from "../../stores/openExternal";

const invokeMock = vi.mocked(invoke);

const files = [
  { name: "20260921-120000-ticket.pdf", size: 2048, modified: 2 },
  { name: "20260921-110000-photo.jpg", size: 10, modified: 1 },
];

describe("InboxIndicator", () => {
  beforeEach(() => useHeaderHoverMenuStore.setState({ openId: null }));
  afterEach(() => {
    cleanup();
    invokeMock.mockReset();
    useOpenExternalStore.setState({ pending: null, queue: [], answeredAt: 0 });
    useHeaderHoverMenuStore.setState({ openId: null });
  });

  it("strips the inbox stamp from a name", () => {
    expect(displayName("20260921-120000-ticket.pdf")).toBe("ticket.pdf");
    expect(displayName("plain.txt")).toBe("plain.txt");
  });

  it("renders nothing while the inbox is empty", async () => {
    invokeMock.mockResolvedValue([]);
    const { container } = render(<InboxIndicator />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("global_inbox_list"));
    expect(container.innerHTML).toBe("");
  });

  it("lists the waiting files, opens one, and deletes only on the second click", async () => {
    let listed = files;
    invokeMock.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "global_inbox_list") return listed;
      if (command === "global_inbox_delete") {
        const { name } = args as { name: string };
        listed = listed.filter((f) => f.name !== name);
        return true;
      }
      return undefined;
    });
    render(<InboxIndicator />);
    const button = await screen.findByRole("button", { name: "Sent from your phone — 2 waiting" });
    expect(button.textContent).toContain("2");

    act(() => useHeaderHoverMenuStore.getState().open("inbox"));
    const del = screen.getByRole("button", { name: "Delete ticket.pdf" });
    fireEvent.click(del);
    expect(invokeMock).not.toHaveBeenCalledWith("global_inbox_delete", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Delete ticket.pdf" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("global_inbox_delete", { name: "20260921-120000-ticket.pdf" }),
    );
    expect(await screen.findByRole("button", { name: "Sent from your phone — 1 waiting" })).toBeTruthy();

    // Gap 21 (C2): a check first, then the question, then the open.
    fireEvent.click(screen.getByRole("menuitem", { name: /photo\.jpg/ }));
    const name = "20260921-110000-photo.jpg";
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("global_inbox_open", { name, checkOnly: true }));
    await waitFor(() => expect(useOpenExternalStore.getState().pending?.request.name).toBe(name));
    expect(invokeMock).not.toHaveBeenCalledWith("global_inbox_open", { name });
    act(() => useOpenExternalStore.getState().answer(true));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("global_inbox_open", { name }));
  });

  it("opens nothing when the user declines or the backend refuses a launcher", async () => {
    invokeMock.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "global_inbox_list") return files;
      if (command === "global_inbox_open" && (args as { name: string }).name.endsWith(".pdf")) {
        throw "open_refused_launcher";
      }
      return undefined;
    });
    render(<InboxIndicator />);
    await screen.findByRole("button", { name: "Sent from your phone — 2 waiting" });
    act(() => useHeaderHoverMenuStore.getState().open("inbox"));
    fireEvent.click(screen.getByRole("menuitem", { name: /photo\.jpg/ }));
    await waitFor(() => expect(useOpenExternalStore.getState().pending?.request.kind).toBe("confirm"));
    act(() => useOpenExternalStore.getState().answer(false));
    act(() => useHeaderHoverMenuStore.getState().open("inbox"));
    fireEvent.click(screen.getByRole("menuitem", { name: /ticket\.pdf/ }));
    await waitFor(() => expect(useOpenExternalStore.getState().pending?.request.kind).toBe("refused"));
    act(() => useOpenExternalStore.getState().answer(false));
    await new Promise((r) => setTimeout(r, 0));
    const opens = invokeMock.mock.calls.filter(([c, a]) => c === "global_inbox_open" && !(a as { checkOnly?: boolean }).checkOnly);
    expect(opens).toEqual([]);
  });
});
