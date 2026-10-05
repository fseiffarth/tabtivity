import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, type MobileMailView } from "../../../mobile-web/src/api";
import { Mail } from "../../../mobile-web/src/screens/Mail";
import { BRAND } from "../../lib/brand";

vi.mock("../../../mobile-web/src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../mobile-web/src/api")>();
  return { ...actual, api: vi.fn() };
});

afterEach(() => {
  cleanup();
  vi.mocked(api).mockReset();
});

const header = (seen: boolean, flagged = false, answered = false) => ({
  id: "msg-1", subject: "Meeting", sender: { name: "Ada", address: "ada@example.test" },
  date: "2026-09-03T09:00:00Z", seen, flagged, answered, has_attachments: false, preview: "Are we on?",
});
const folderView = (seen: boolean, flagged = false, answered = false): Extract<MobileMailView, { view: "folder" }> => ({
  view: "folder",
  folder: { id: "folder-1", name: "Inbox", kind: "inbox", unread: seen ? 0 : 1, total: 1 },
  messages: [header(seen, flagged, answered)],
  total: 1,
  offset: 0,
});
const messageView = (seen: boolean): MobileMailView => ({
  view: "message", message: header(seen), body: "Are we on?", truncated: false, attachments: [],
});

/** Overview → folder → message, with the desktop's write capabilities as given. */
async function openMessage(writes: { actions?: boolean; reply?: boolean }) {
  vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/v1/mail") {
      return { mail: { view: "overview", accounts: [{ id: "acc", label: "Work", address: "me@example.test", folders: [folderView(false).folder] }], ...writes } };
    }
    if (path.endsWith("/messages/msg-1?offset=0")) return { mail: messageView(false) };
    if (path.startsWith("/api/v1/mail/folders/folder-1?")) return { mail: folderView(false) };
    throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
  });
  render(createElement(Mail));
  fireEvent.click(await screen.findByText("Inbox"));
  fireEvent.click(await screen.findByText("Meeting"));
  await screen.findByText("Are we on?", { selector: "pre" });
}

describe("phone mail writes", () => {
  it("shows no write controls when the desktop reports neither capability", async () => {
    await openMessage({});
    expect(screen.queryByText("Mark read")).toBeNull();
    expect(screen.queryByText("★ Star")).toBeNull();
    expect(screen.queryByLabelText("Reply text")).toBeNull();
    expect(screen.getByText(/Read-only mail/)).toBeTruthy();
  });

  it("marks read through the mark route and takes the header back from the desktop's answer", async () => {
    await openMessage({ actions: true });
    const calls: { path: string; body: unknown }[] = [];
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return { mail: folderView(true, true) };
    });
    fireEvent.click(screen.getByText("Mark read"));
    await screen.findByText("Mark unread");
    expect(calls).toEqual([{
      path: "/api/v1/mail/folders/folder-1/messages/msg-1/mark",
      body: { action: "seen", offset: 0 },
    }]);
    // The star came back set in the same answer: the phone believes the page,
    // not its own click.
    expect(screen.getByText("☆ Unstar")).toBeTruthy();
  });

  it("explains a desktop-side refusal instead of echoing the code", async () => {
    await openMessage({ actions: true });
    vi.mocked(api).mockRejectedValue(new ApiError(403, "mail_actions_disabled"));
    fireEvent.click(screen.getByText("★ Star"));
    await screen.findByText(new RegExp(String.raw`Switched off in ${BRAND.display}`));
  });

  it("sends a reply only after a second, explicit confirmation naming the recipient", async () => {
    await openMessage({ reply: true });
    const calls: { path: string; body: unknown }[] = [];
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return { mail: folderView(true, false, true) };
    });
    const send = screen.getByText("Send reply…") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reply text"), { target: { value: "Yes, 10 am." } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    // Nothing has left the phone yet.
    expect(calls).toEqual([]);
    expect(screen.getByText(/Send this reply to ada@example.test now/)).toBeTruthy();
    fireEvent.click(screen.getByText("Send"));
    await screen.findByText("Reply sent from the desktop.");
    expect(calls).toEqual([{
      path: "/api/v1/mail/folders/folder-1/messages/msg-1/reply",
      body: { body: "Yes, 10 am.", offset: 0 },
    }]);
    await waitFor(() => expect((screen.getByLabelText("Reply text") as HTMLTextAreaElement).value).toBe(""));
  });

  it("refuses to offer a reply longer than the sidecar accepts", async () => {
    await openMessage({ reply: true });
    fireEvent.change(screen.getByLabelText("Reply text"), { target: { value: "x".repeat(16 * 1024 + 1) } });
    expect((screen.getByText("Send reply…") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/longer than the phone may send/)).toBeTruthy();
  });
});
