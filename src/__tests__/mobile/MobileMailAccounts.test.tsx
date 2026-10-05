import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    const picker = await screen.findByLabelText("Mail account") as HTMLSelectElement;
    expect(Array.from(picker.options).map((option) => option.text)).toEqual(["Work · 2 unread", "Home · 5 unread"]);
    expect(folderNames()).toEqual(["Inbox", "Sent"]);
    fireEvent.change(picker, { target: { value: "home" } });
    expect(folderNames()).toEqual(["Post", "Bin"]);
    expect(localStorage.getItem(storageKey("mobile.mailAccount"))).toBe("home");
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
    const folderPicker = await screen.findByLabelText("Folder") as HTMLSelectElement;
    expect(folderPicker.value).toBe("w-sent");
    expect(Array.from(folderPicker.options).map((option) => option.text)).toEqual(["Inbox (2)", "Sent"]);
    fireEvent.change(screen.getByLabelText("Mail account"), { target: { value: "home" } });
    await waitFor(() => expect((screen.getByLabelText("Folder") as HTMLSelectElement).value).toBe("h-inbox"));
    fireEvent.change(screen.getByLabelText("Folder"), { target: { value: "h-trash" } });
    await waitFor(() => expect(paths[paths.length - 1]).toBe("/api/v1/mail/folders/h-trash?offset=0"));
    expect(paths).toContain("/api/v1/mail/folders/h-inbox?offset=0");
  });
});
