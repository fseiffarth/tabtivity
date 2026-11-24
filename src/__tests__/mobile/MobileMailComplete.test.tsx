/**
 * The phone's reply box completion (docs/mail_autocomplete_plan.md D4): a tap
 * strip under the field, the Terminal composer's `.composer-complete`, led by
 * the word it finishes; a tap appends the continuation and keeps the keyboard
 * (pointer-down is held back). The opened message is warmed once, when the
 * reply box first takes the focus. The two calls live in `api.ts`.
 */
import { cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, completeMailReply, warmMailReply, type MobileMailView } from "../../../mobile-web/src/api";
import { Mail } from "../../../mobile-web/src/screens/Mail";

vi.mock("../../../mobile-web/src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../mobile-web/src/api")>();
  return { ...actual, api: vi.fn(), completeMailReply: vi.fn(), warmMailReply: vi.fn() };
});

const header = {
  id: "msg-1", subject: "Meeting", sender: { name: "Ada", address: "ada@example.test" },
  date: "2026-09-03T09:00:00Z", seen: true, flagged: false, answered: false, has_attachments: false, preview: "Are we on?",
};
const folderView = (): Extract<MobileMailView, { view: "folder" }> => ({
  view: "folder", folder: { id: "folder-1", name: "Inbox", kind: "inbox", unread: 0, total: 1 }, messages: [header], total: 1, offset: 0,
});

async function openReply(writes: { actions?: boolean; reply?: boolean }) {
  vi.mocked(api).mockImplementation(async (path: string) => {
    if (path === "/api/v1/mail") return { mail: { view: "overview", accounts: [{ id: "acc", label: "Work", address: "me@example.test", folders: [folderView().folder] }], ...writes } };
    if (path.endsWith("/messages/msg-1?offset=0")) return { mail: { view: "message", message: header, body: "Are we on?", truncated: false, attachments: [] } };
    if (path.startsWith("/api/v1/mail/folders/folder-1?")) return { mail: folderView() };
    throw new Error(`unexpected ${path}`);
  });
  render(createElement(Mail));
  fireEvent.click(await screen.findByText("Inbox"));
  fireEvent.click(await screen.findByText("Meeting"));
  await screen.findByText("Are we on?", { selector: "pre" });
}

const field = () => screen.getByLabelText("Reply text") as HTMLTextAreaElement;
const strip = () => screen.queryByRole("button", { name: /^Take the suggested continuation/ });

beforeEach(() => {
  vi.mocked(completeMailReply).mockResolvedValue({ status: "ok", text: " slides for me", model: "qwen3:4b" });
  vi.mocked(warmMailReply).mockResolvedValue({ status: "warmed", text: null });
});
afterEach(() => {
  cleanup();
  vi.mocked(api).mockReset();
  vi.mocked(completeMailReply).mockReset();
  vi.mocked(warmMailReply).mockReset();
});

describe("phone reply completion", () => {
  it("asks once the typing rests and shows the continuation, led by the word it finishes", async () => {
    await openReply({ reply: true });
    fireEvent.change(field(), { target: { value: "Thanks for the" } });
    expect(strip()).toBeNull();
    const shown = await screen.findByRole("button", { name: "Take the suggested continuation: slides for me" });
    expect(shown.textContent).toContain("… slides for me");
    expect(completeMailReply).toHaveBeenCalledTimes(1);
    expect(completeMailReply).toHaveBeenCalledWith("folder-1", "msg-1", 0, "Thanks for the");
    // Mid-word: the strip leads with the word being finished.
    vi.mocked(completeMailReply).mockResolvedValue({ status: "ok", text: "ides for me", model: "qwen3:4b" });
    fireEvent.change(field(), { target: { value: "Thanks for the sl" } });
    expect((await screen.findByRole("button", { name: "Take the suggested continuation: slides for me" })).textContent).toContain("… slides for me");
  });

  it("appends it on a tap, keeping the keyboard up", async () => {
    await openReply({ reply: true });
    fireEvent.change(field(), { target: { value: "Thanks for the" } });
    const button = await screen.findByRole("button", { name: /^Take the suggested continuation/ });
    const down = createEvent.pointerDown(button);
    fireEvent(button, down);
    expect(down.defaultPrevented).toBe(true);
    fireEvent.click(button);
    expect(field().value).toBe("Thanks for the slides for me");
    expect(strip()).toBeNull();
  });

  it("warms the model once per opened message, when the reply box first takes the focus", async () => {
    await openReply({ reply: true });
    expect(warmMailReply).not.toHaveBeenCalled();
    fireEvent.focus(field());
    fireEvent.focus(field());
    expect(warmMailReply).toHaveBeenCalledTimes(1);
    expect(warmMailReply).toHaveBeenCalledWith("folder-1", "msg-1", 0);
  });

  it("ignores a warm-up that fails", async () => {
    vi.mocked(warmMailReply).mockRejectedValue(new Error("desktop_unavailable"));
    await openReply({ reply: true });
    fireEvent.focus(field());
    await waitFor(() => expect(warmMailReply).toHaveBeenCalled());
    expect(screen.queryByText(/desktop_unavailable/)).toBeNull();
  });

  it("shows no strip, and asks nothing, for a status that says it is not to be had", async () => {
    vi.mocked(completeMailReply).mockResolvedValue({ status: "off", text: null });
    await openReply({ reply: true });
    fireEvent.change(field(), { target: { value: "Thanks for the" } });
    await waitFor(() => expect(completeMailReply).toHaveBeenCalledTimes(1));
    expect(strip()).toBeNull();
    // Backed off: a further draft is not asked about within the minute.
    fireEvent.change(field(), { target: { value: "Thanks for the slides" } });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(completeMailReply).toHaveBeenCalledTimes(1);
  });

  it("asks nothing where the desktop does not let the phone reply", async () => {
    await openReply({});
    expect(screen.queryByLabelText("Reply text")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(completeMailReply).not.toHaveBeenCalled();
    expect(warmMailReply).not.toHaveBeenCalled();
  });

  it("asks nothing while the send is being confirmed", async () => {
    await openReply({ reply: true });
    fireEvent.change(field(), { target: { value: "Thanks for the" } });
    await screen.findByRole("button", { name: /^Take the suggested continuation/ });
    fireEvent.click(screen.getByLabelText("Send reply…"));
    expect(strip()).toBeNull();
  });
});
