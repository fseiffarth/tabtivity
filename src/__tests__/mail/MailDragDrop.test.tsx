import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { MailPane } from "../../components/mail/MailPane";
import { useMailStore } from "../../stores/mail";
import type { MailAccount, MailFolder, MailHeader } from "../../types/mail";

const folders: MailFolder[] = [
  { id: "inbox", account_id: "a1", path: "INBOX", name: "Inbox", kind: "inbox", unread: 3, total: 3 },
  { id: "archive", account_id: "a1", path: "Archive", name: "Archive", kind: "archive", unread: 0, total: 0 },
];
const headers: MailHeader[] = ["m1", "m2", "m3"].map((id) => ({
  id, account_id: "a1", folder_id: "inbox", uid: 1, subject: `subject ${id}`,
  from: { address: "sender@example.com" }, to: [], cc: [], date: "2026-07-01T09:00:00Z",
  seen: false, flagged: false, answered: false, has_attachments: false, size: 10, preview: "",
}));
const row = (id: string) => screen.getByText(`subject ${id}`).closest(".mail-row")!;
const target = () => document.querySelector<HTMLElement>("[data-mail-drop-folder='archive']")!;

/** The row drag is pointer-driven: jsdom has no layout, so a point right of
 *  x=500 is "over" the Archive folder and anything else over nothing. */
const savedEFP = document.elementFromPoint;
function stubHitTest() {
  document.elementFromPoint = ((x: number) =>
    x >= 500 ? target() : null) as typeof document.elementFromPoint;
}

function pointer(type: string, x: number, y: number, el: EventTarget = window) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, { clientX: x, clientY: y, button: 0, pointerId: 1 });
  act(() => {
    el.dispatchEvent(ev);
  });
}

/** Press on `id`, travel to `x`, and (unless `release` is false) let go. */
function drag(id: string, x: number, release = true) {
  pointer("pointerdown", 10, 10, row(id));
  pointer("pointermove", 30, 10);
  pointer("pointermove", x, 10);
  if (release) pointer("pointerup", x, 10);
}

beforeEach(() => {
  vi.spyOn(useMailStore.getState(), "loadAccounts").mockResolvedValue(undefined);
  vi.spyOn(useMailStore.getState(), "moveMessages").mockResolvedValue(undefined);
  useMailStore.setState({
    accounts: [{ id: "a1", label: "Mail", address: "me@example.com" } as MailAccount],
    accountsLoaded: true, selectedAccountId: "a1", selectedFolderId: "inbox", selectedPriority: null,
    selectedMessageId: null, headers, foldersByAccount: { a1: folders }, checkedIds: [], anchorId: null,
    loadingHeaders: false, headerTotal: 3, headerOffset: 0, query: "", unreadOnly: false, agentOnly: false,
    agentDrafts: [], agentMarks: [], sync: {}, error: null, accountDialog: null,
  });
  stubHitTest();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.elementFromPoint = savedEFP;
});

function mount() {
  // No encryption/keyring reads are needed to exercise the list and rail.
  render(<MailPane visible={false} />);
}

describe("mail list to folder drag-and-drop", () => {
  it("keeps a Ctrl selection intact through pressing, dragging and dropping", async () => {
    mount();
    fireEvent.click(row("m1"));
    fireEvent.click(row("m3"), { ctrlKey: true });
    expect(useMailStore.getState().checkedIds).toEqual(["m1", "m3"]);
    drag("m1", 600, false);
    expect(target().classList.contains("drop-target")).toBe(true);
    expect(screen.getByText("2 messages")).toBeTruthy();
    pointer("pointerup", 600, 10);
    await waitFor(() => expect(useMailStore.getState().moveMessages).toHaveBeenCalledWith(["m1", "m3"], "archive"));
    expect(useMailStore.getState().selectedMessageId).toBeNull();
    expect(useMailStore.getState().headers.every((h) => !h.seen)).toBe(true);
    expect(target().classList.contains("drop-target")).toBe(false);
    expect(screen.queryByText("2 messages")).toBeNull();
  });

  it("drags a Shift range", () => {
    mount();
    fireEvent.click(row("m1"));
    fireEvent.click(row("m3"), { shiftKey: true });
    drag("m2", 600);
    expect(useMailStore.getState().moveMessages).toHaveBeenCalledWith(["m1", "m2", "m3"], "archive");
  });

  it("a press that never travels is a click, not a drag", () => {
    mount();
    pointer("pointerdown", 10, 10, row("m2"));
    pointer("pointermove", 12, 11);
    pointer("pointerup", 12, 11);
    expect(useMailStore.getState().moveMessages).not.toHaveBeenCalled();
    expect(screen.queryByText("1 messages")).toBeNull();
  });

  it("moves nothing when released off a folder or aborted with Escape", () => {
    mount();
    drag("m2", 200);
    drag("m2", 600, false);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(target().classList.contains("drop-target")).toBe(false);
    pointer("pointerup", 600, 10);
    expect(useMailStore.getState().moveMessages).not.toHaveBeenCalled();
  });

  it("refuses a mixed-account selection", () => {
    useMailStore.setState({ headers: [headers[0], { ...headers[1], account_id: "b1" }], checkedIds: ["m1", "m2"] });
    mount();
    drag("m1", 600, false);
    expect(target().classList.contains("drop-target")).toBe(false);
    pointer("pointerup", 600, 10);
    expect(useMailStore.getState().moveMessages).not.toHaveBeenCalled();
  });

  it("refuses a drop on the folder every dragged row is already in", () => {
    document.elementFromPoint = ((x: number) =>
      x >= 500 ? document.querySelector("[data-mail-drop-folder='inbox']") : null) as typeof document.elementFromPoint;
    mount();
    drag("m1", 600);
    expect(useMailStore.getState().moveMessages).not.toHaveBeenCalled();
  });
});
