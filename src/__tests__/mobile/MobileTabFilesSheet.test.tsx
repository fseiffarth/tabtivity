/**
 * An agent tab card's ⋯ → Files: the files that tab's conversation produced
 * and got, in the chat's own groups, reached without opening the chat; a tap
 * opens the file over the list, and closing it comes back to the list.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Project } from "../../../mobile-web/src/screens/Project";
import { tabActions } from "../../../mobile-web/src/components/TabCard";
import { resetTips } from "../../../mobile-web/src/components/HintMessage";
import { resetInboxFiles } from "../../../mobile-web/src/terminal/inboxRefs";
import { NAMES } from "../../lib/brand";

const secs = (iso: string) => Date.parse(iso) / 1000;
const PHOTO = "20261004-101500-photo.jpg";
const TAB = { id: "tab-7", label: "claude 1", kind: "agent", available: true, viewer_busy: false };
const TRANSCRIPT = {
  available: true,
  version: "1:1",
  truncated: false,
  entries: [
    { kind: "prompt", text: `what is on this? @${NAMES.inboxDir}/${PHOTO}`, at: "2026-10-04T10:15:05Z" },
    { kind: "answer", text: "A whiteboard. Here is it typed up.", at: "2026-10-04T10:16:00Z" },
  ],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fetchMock = vi.fn((input: string | URL | Request) => {
  const url = String(input);
  if (url.includes("/inbox?names=")) return Promise.resolve(json({ files: [{ name: PHOTO, original: "photo.jpg", kind: "image/jpeg", size: 300_000, modified: secs("2026-10-04T10:15:00Z") }] }));
  if (url.endsWith("/outbox")) {
    return Promise.resolve(json({ files: [
      { name: "board.md", kind: "text/markdown", size: 900, modified: secs("2026-10-04T10:16:10Z"), from_tab: true },
      { name: "theirs.png", kind: "image/png", size: 9_000, modified: secs("2026-10-04T10:17:00Z") },
    ] }));
  }
  if (url.includes("/transcript")) return Promise.resolve(json({ transcript: TRANSCRIPT }));
  if (url.startsWith("/api/v1/projects/p1")) {
    return Promise.resolve(json({ project: { id: "p1", label: "Alpha", status: "active", live_sessions: 1 }, desktop_available: true, tabs: [TAB], agents: [] }));
  }
  return Promise.resolve(json({ error: "not_found" }, 404));
});

const settle = () => act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });

beforeEach(() => {
  localStorage.clear();
  resetTips();
  resetInboxFiles();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockClear();
  vi.unstubAllGlobals();
});

describe("Mobile tab card ⋯ → Files", () => {
  it("is offered on agent tabs only, not on a cloud session or a tab on the remote host", () => {
    const agent = { id: "a", label: "a", kind: "agent" as const, available: true, viewer_busy: false };
    expect(tabActions(agent, false)).toContain("files");
    expect(tabActions({ ...agent, kind: "shell" }, false)).not.toContain("files");
    expect(tabActions({ ...agent, cloud: true }, false)).not.toContain("files");
    expect(tabActions({ ...agent, on_host: true }, false)).not.toContain("files");
  });

  it("lists what the chat produced and got, and opens a file over the list", async () => {
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "More for claude 1" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "claude 1" })).getByRole("button", { name: "Files" }));
    await settle();
    await settle();

    const sheet = screen.getByRole("dialog", { name: "Files of claude 1" });
    // Another tab's send stays out; this chat's two, split by side.
    expect(within(sheet).getAllByRole("region").map((section) => section.getAttribute("aria-label")))
      .toEqual(["Sent by the agent (1)", "Sent by you (1)"]);
    expect(within(sheet).queryByText("theirs.png")).toBeNull();

    fireEvent.click(within(sheet).getByRole("button", { name: "Open photo.jpg · From you" }));
    expect(screen.getByRole("dialog", { name: "photo.jpg" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Files of claude 1" })).toBeNull();
    fireEvent.click(within(screen.getByRole("dialog", { name: "photo.jpg" })).getAllByRole("button", { name: "Close" })[0]);
    await settle();
    expect(screen.getByRole("dialog", { name: "Files of claude 1" })).toBeTruthy();
  });
});
