/**
 * The header's global inbox: hidden while empty, a count while files wait,
 * rows that open by leaf name, and a delete that arms before it deletes. Its
 * "Added to projects" section: uploads alone show the button, Undo arms
 * before it undoes, Keep hides a row across a remount.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { InboxIndicator, displayName } from "../../components/header/InboxIndicator";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { storageKey } from "../../lib/brand";

const invokeMock = vi.mocked(invoke);

const files = [
  { name: "20260921-120000-ticket.pdf", size: 2048, modified: 2 },
  { name: "20260921-110000-photo.jpg", size: 10, modified: 1 },
];

describe("InboxIndicator", () => {
  beforeEach(() => {
    useHeaderHoverMenuStore.setState({ openId: null });
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    invokeMock.mockReset();
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
      if (command === "phone_uploads_list") return [];
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

    fireEvent.click(screen.getByRole("menuitem", { name: /photo\.jpg/ }));
    expect(invokeMock).toHaveBeenCalledWith("global_inbox_open", { name: "20260921-110000-photo.jpg" });
  });

  const uploads = [
    { id: "u1", projectName: "Paper", rel: "docs/report.pdf", size: 4096, at: Date.now() / 1000 - 120, phone: "Pixel" },
    { id: "u2", projectName: "Paper", rel: "scan.jpg", size: 10, at: Date.now() / 1000 - 7_200 },
  ];

  it("shows the button for uploads alone and opens the list instead of the folder", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "global_inbox_list") return [];
      if (command === "phone_uploads_list") return uploads;
      return undefined;
    });
    render(<InboxIndicator />);
    const button = await screen.findByRole("button", { name: "Sent from your phone — 2 waiting" });
    fireEvent.click(button);
    expect(invokeMock).not.toHaveBeenCalledWith("global_inbox_reveal");
    expect(screen.getByText("Added to projects")).toBeTruthy();
    expect(screen.getByText("Paper · docs/report.pdf")).toBeTruthy();
    expect(screen.getByText(/2 min ago · Pixel/)).toBeTruthy();
    expect(screen.queryByText("Show in folder")).toBeNull();
  });

  it("undoes an upload only on the second click, and the row goes", async () => {
    let listed = uploads;
    invokeMock.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "global_inbox_list") return [];
      if (command === "phone_uploads_list") return listed;
      if (command === "phone_upload_undo") {
        const { id } = args as { id: string };
        listed = listed.filter((u) => u.id !== id);
        return undefined;
      }
      return undefined;
    });
    render(<InboxIndicator />);
    await screen.findByRole("button", { name: "Sent from your phone — 2 waiting" });
    act(() => useHeaderHoverMenuStore.getState().open("inbox"));
    fireEvent.click(screen.getByRole("button", { name: "Undo docs/report.pdf" }));
    expect(invokeMock).not.toHaveBeenCalledWith("phone_upload_undo", expect.anything());
    expect(screen.getByRole("button", { name: "Undo docs/report.pdf" }).textContent).toBe("Undo?");
    fireEvent.click(screen.getByRole("button", { name: "Undo docs/report.pdf" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("phone_upload_undo", { id: "u1" }));
    expect(await screen.findByRole("button", { name: "Sent from your phone — 1 waiting" })).toBeTruthy();
    expect(screen.queryByText("Paper · docs/report.pdf")).toBeNull();
  });

  it("drops the row of a refused undo (the file was edited) on the re-read", async () => {
    let listed = uploads;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "global_inbox_list") return [];
      if (command === "phone_uploads_list") return listed;
      if (command === "phone_upload_undo") {
        // Edited on the desktop: refused, and no longer listed.
        listed = listed.filter((u) => u.id !== "u1");
        throw "file_not_found";
      }
      return undefined;
    });
    render(<InboxIndicator />);
    await screen.findByRole("button", { name: "Sent from your phone — 2 waiting" });
    act(() => useHeaderHoverMenuStore.getState().open("inbox"));
    fireEvent.click(screen.getByRole("button", { name: "Undo docs/report.pdf" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo docs/report.pdf" }));
    expect(await screen.findByRole("button", { name: "Sent from your phone — 1 waiting" })).toBeTruthy();
    expect(screen.getByText("Paper · scan.jpg")).toBeTruthy();
  });

  it("hides a kept upload, also after a remount", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "global_inbox_list") return [];
      if (command === "phone_uploads_list") return uploads;
      return undefined;
    });
    const first = render(<InboxIndicator />);
    await screen.findByRole("button", { name: "Sent from your phone — 2 waiting" });
    act(() => useHeaderHoverMenuStore.getState().open("inbox"));
    fireEvent.click(screen.getByRole("button", { name: "Keep docs/report.pdf" }));
    expect(await screen.findByRole("button", { name: "Sent from your phone — 1 waiting" })).toBeTruthy();
    expect(invokeMock).not.toHaveBeenCalledWith("phone_upload_undo", expect.anything());
    first.unmount();

    render(<InboxIndicator />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("phone_uploads_list"));
    expect(await screen.findByRole("button", { name: "Sent from your phone — 1 waiting" })).toBeTruthy();
    act(() => useHeaderHoverMenuStore.getState().open("inbox"));
    expect(screen.queryByText("Paper · docs/report.pdf")).toBeNull();
    expect(screen.getByText("Paper · scan.jpg")).toBeTruthy();
  });

  it("a failed list read keeps the Keep marks, so kept rows stay hidden after it", async () => {
    // `phone_uploads_list` rejects (`list_failed`) when projects.json or the
    // upload log cannot be read, rather than answering an empty list that
    // would prune every Keep.
    localStorage.setItem(storageKey("inbox.keptUploads"), JSON.stringify(["u1"]));
    let failing = true;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "global_inbox_list") return files.slice(0, 1);
      if (command === "phone_uploads_list") {
        if (failing) throw "list_failed";
        return uploads;
      }
      return undefined;
    });
    const first = render(<InboxIndicator />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("phone_uploads_list"));
    await screen.findByRole("button", { name: "Sent from your phone — 1 waiting" });
    expect(JSON.parse(localStorage.getItem(storageKey("inbox.keptUploads")) ?? "[]")).toEqual(["u1"]);
    first.unmount();

    failing = false;
    render(<InboxIndicator />);
    expect(await screen.findByRole("button", { name: "Sent from your phone — 2 waiting" })).toBeTruthy();
    act(() => useHeaderHoverMenuStore.getState().open("inbox"));
    expect(screen.queryByText("Paper · docs/report.pdf")).toBeNull();
    expect(screen.getByText("Paper · scan.jpg")).toBeTruthy();
  });

  it("a read in flight when Undo is confirmed does not paint the row back", async () => {
    let listed = uploads;
    let hold = false;
    let release: (() => void) | null = null;
    invokeMock.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "global_inbox_list") return [];
      if (command === "phone_uploads_list") {
        if (!hold) return listed;
        hold = false;
        // A poll that read the log before the undo: it still lists u1.
        const snapshot = listed;
        return new Promise((resolve) => {
          release = () => resolve(snapshot);
        });
      }
      if (command === "phone_upload_undo") {
        const { id } = args as { id: string };
        listed = listed.filter((u) => u.id !== id);
        return undefined;
      }
      return undefined;
    });
    render(<InboxIndicator />);
    await screen.findByRole("button", { name: "Sent from your phone — 2 waiting" });
    act(() => useHeaderHoverMenuStore.getState().open("inbox"));

    hold = true;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(release).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Undo docs/report.pdf" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo docs/report.pdf" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("phone_upload_undo", { id: "u1" }));
    expect(await screen.findByRole("button", { name: "Sent from your phone — 1 waiting" })).toBeTruthy();

    await act(async () => {
      release?.();
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Sent from your phone — 1 waiting" })).toBeTruthy();
    expect(screen.queryByText("Paper · docs/report.pdf")).toBeNull();
  });

  it("Keep never drops a Keep another viewer of the same storage made meanwhile", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "global_inbox_list") return [];
      if (command === "phone_uploads_list") return uploads;
      return undefined;
    });
    render(<InboxIndicator />);
    await screen.findByRole("button", { name: "Sent from your phone — 2 waiting" });
    // A second browser tab of the web client keeps u1 after this one mounted.
    localStorage.setItem(storageKey("inbox.keptUploads"), JSON.stringify(["u1"]));
    act(() => useHeaderHoverMenuStore.getState().open("inbox"));
    fireEvent.click(screen.getByRole("button", { name: "Keep scan.jpg" }));
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey("inbox.keptUploads")) ?? "[]");
    expect(stored).toEqual(expect.arrayContaining(["u1", "u2"]));
    // Both are hidden here now, so nothing is left to show.
    await waitFor(() => expect(screen.queryByRole("button", { name: /Sent from your phone/ })).toBeNull());
  });
});
