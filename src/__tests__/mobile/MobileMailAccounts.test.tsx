import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type MobileMailFolder, type MobileMailView } from "../../../mobile-web/src/api";
import { Mail } from "../../../mobile-web/src/screens/Mail";
import { storageKey } from "../../lib/brand";

vi.mock("../../../mobile-web/src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../mobile-web/src/api")>();
  return { ...actual, api: vi.fn() };
});

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.mocked(api).mockReset();
  vi.useRealTimers();
});

const folder = (id: string, name: string, kind: string, unread = 0): MobileMailFolder => ({ id, name, kind, unread, total: 4 });
const accounts = [
  { id: "work", label: "Work", address: "me@work.test", folders: [folder("w-sent", "Sent", "sent"), folder("w-inbox", "Inbox", "inbox", 2)] },
  { id: "home", label: "Home", address: "me@home.test", folders: [folder("h-trash", "Bin", "trash"), folder("h-inbox", "Post", "inbox", 5)] },
];
const page = (target: MobileMailFolder): MobileMailView => ({ view: "folder", folder: target, messages: [], total: 0, offset: 0 });

function serve(paths: string[]) {
  vi.mocked(api).mockImplementation(async (path: string) => {
    paths.push(path);
    if (path === "/api/v1/mail") return { mail: { view: "overview", accounts } };
    const id = /^\/api\/v1\/mail\/folders\/([^?]+)\?/.exec(path)?.[1];
    const target = accounts.flatMap((item) => item.folders).find((item) => item.id === id);
    if (target) return { mail: page(target) };
    throw new Error(`unexpected ${path}`);
  });
}

const folderNames = () => Array.from(document.querySelectorAll(".mail-mobile-folders button span")).map((node) => node.textContent);

describe("phone mail account picker", () => {
  it("lists one account's folders, inbox first, and remembers the account picked", async () => {
    serve([]);
    render(createElement(Mail));
    const switcher = await screen.findByRole("button", { name: /Switch account/ });
    expect(switcher.textContent).toContain("Work · 2 unread");
    expect(folderNames()).toEqual(["Inbox", "Sent"]);
    fireEvent.click(switcher);
    const sheet = within(screen.getByRole("dialog", { name: "Mail account" }));
    expect(sheet.getAllByRole("button").map((button) => button.textContent).filter((text) => /unread/.test(text ?? ""))).toEqual(["Work · 2 unread", "Home · 5 unread"]);
    fireEvent.click(sheet.getByText("Home · 5 unread"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(folderNames()).toEqual(["Post", "Bin"]);
    expect(localStorage.getItem(storageKey("mobile.mailAccount"))).toBe("home");
  });

  it("shows a single account as plain text, not a button", async () => {
    vi.mocked(api).mockImplementation(async () => ({ mail: { view: "overview", accounts: [accounts[0]] } }));
    render(createElement(Mail));
    await screen.findByText("Work · 2 unread");
    expect(screen.queryByRole("button", { name: /Switch account/ })).toBeNull();
  });

  it("opens on the stored account and falls back when the desktop no longer lists it", async () => {
    localStorage.setItem(storageKey("mobile.mailAccount"), "home");
    serve([]);
    render(createElement(Mail));
    await screen.findByText("Post");
    cleanup();
    localStorage.setItem(storageKey("mobile.mailAccount"), "gone");
    render(createElement(Mail));
    await screen.findByText("Inbox");
  });

  it("switches account and folder from inside a folder without going back", async () => {
    const paths: string[] = [];
    serve(paths);
    render(createElement(Mail));
    fireEvent.click(await screen.findByText("Sent"));
    const switcher = await screen.findByRole("button", { name: /Switch account/ });
    fireEvent.click(switcher);
    // This account's folders first, then the other accounts.
    const sheet = within(screen.getByRole("dialog", { name: "Mail account" }));
    expect(sheet.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Folder", "Inbox2", "Sent", "Account", "Home · 5 unread"]);
    fireEvent.click(sheet.getByText("Home · 5 unread"));
    await waitFor(() => expect(paths).toContain("/api/v1/mail/folders/h-inbox?offset=0"));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Post"));
    fireEvent.click(screen.getByRole("button", { name: /Switch account/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Mail account" })).getByText("Bin"));
    await waitFor(() => expect(paths[paths.length - 1]).toBe("/api/v1/mail/folders/h-trash?offset=0"));
  });
});

describe("phone mail folder list", () => {
  it("folds empty folders under one row that opens in place, never the inbox", async () => {
    const empty = (id: string, name: string, kind: string) => ({ ...folder(id, name, kind), total: 0 });
    const solo = { id: "solo", label: "Solo", address: "me@solo.test", folders: [empty("s-inbox", "Inbox", "inbox"), empty("s-drafts", "Drafts", "drafts"), empty("s-bin", "Bin", "trash"), folder("s-sent", "Sent", "sent")] };
    vi.mocked(api).mockImplementation(async () => ({ mail: { view: "overview", accounts: [solo] } }));
    render(createElement(Mail));
    await screen.findByText("Sent");
    expect(folderNames().slice(0, 2)).toEqual(["Inbox", "Sent"]);
    expect(screen.queryByText("Drafts")).toBeNull();
    const more = screen.getByRole("button", { name: /More folders · 2 empty/ });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Drafts")).toBeTruthy();
    expect(screen.getByText("Bin")).toBeTruthy();
  });
});

describe("phone mail folder still being fetched", () => {
  it("says so and asks again until the desktop's fetch is done", async () => {
    const paths: string[] = [];
    let rounds = 0;
    const mail = { id: "m1", subject: "Filed away", sender: { address: "a@b.test" }, date: "2026-10-15T10:00:00Z", seen: true, has_attachments: false, preview: "" };
    vi.mocked(api).mockImplementation(async (path: string) => {
      paths.push(path);
      if (path === "/api/v1/mail") return { mail: { view: "overview", accounts } };
      const target = accounts[0].folders[0];
      rounds += 1;
      return rounds === 1
        ? { mail: { ...page(target), syncing: true } }
        : { mail: { view: "folder", folder: target, messages: [mail], total: 1, offset: 0 } };
    });
    render(createElement(Mail));
    fireEvent.click(await screen.findByText("Sent"));
    await screen.findByText("Fetching this folder from the server…");
    await screen.findByText("Filed away", undefined, { timeout: 3_000 });
    expect(screen.queryByText("Fetching this folder from the server…")).toBeNull();
    expect(paths.filter((path) => path === "/api/v1/mail/folders/w-sent?offset=0")).toHaveLength(2);
  });
});

describe("phone mail date groups", () => {
  it("groups messages across local midnight and labels recent and older days", async () => {
    vi.setSystemTime(new Date(2026, 0, 8, 0, 5));
    const recent = new Date(2026, 0, 6, 12);
    const older = new Date(2025, 11, 31, 12);
    const header = (id: string, subject: string, date: string) => ({
      id, subject, date, sender: { address: "a@b.test" }, seen: true, has_attachments: false, preview: "",
    });
    const messages = [
      header("m1", "After midnight", new Date(2026, 0, 8, 0, 4).toISOString()),
      header("m2", "Before midnight", new Date(2026, 0, 7, 23, 59).toISOString()),
      header("m3", "Yesterday morning", new Date(2026, 0, 7, 9).toISOString()),
      header("m4", "Earlier this week", recent.toISOString()),
      header("m5", "Last year", older.toISOString()),
      header("m6", "Missing timestamp", ""),
    ];
    vi.mocked(api).mockImplementation(async (path: string) => ({
      mail: path === "/api/v1/mail"
        ? { view: "overview", accounts }
        : { ...page(accounts[0].folders[1]), messages, total: messages.length },
    }));

    render(createElement(Mail));
    fireEvent.click(await screen.findByText("Inbox"));
    await screen.findByRole("heading", { name: "Today" });

    const sections = Array.from(document.querySelectorAll<HTMLElement>("main > section"));
    expect(sections.map((section) => within(section).getByRole("heading").textContent)).toEqual([
      "Today",
      "Yesterday",
      recent.toLocaleDateString("en", { weekday: "long" }),
      older.toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" }),
      "Unknown date",
    ]);
    const subjects = sections.map((section) => Array.from(section.querySelectorAll("button b"), (subject) => subject.textContent));
    expect(subjects).toEqual([["After midnight"], ["Before midnight", "Yesterday morning"], ["Earlier this week"], ["Last year"], ["Missing timestamp"]]);
  });
});
