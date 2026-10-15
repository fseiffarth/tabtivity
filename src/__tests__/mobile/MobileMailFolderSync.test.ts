/**
 * The background sync fetches Inbox, Sent and Drafts only; every other folder
 * fills when it is checked on its own. The phone has no Check mail button, so
 * opening a folder from it is that check — before, Archive and every user
 * folder read as empty on the phone and all mail looked like inbox mail.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { mailFolderPage } from "../../components/mobile/MobileBridgeHost";

const header = (id: string) => ({
  id, account_id: "acct", folder_id: "", subject: id, from: { address: "a@b.test" }, to: [], cc: [],
  date: "2026-10-15T10:00:00Z", seen: true, flagged: false, answered: false, has_attachments: false, preview: "",
});

/** One account with one folder; `sync` decides when `mail_sync` settles. */
function serve(folderId: string, sync: () => Promise<void>) {
  let synced = false;
  const calls: string[] = [];
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    calls.push(cmd);
    const a = args as Record<string, unknown> | undefined;
    switch (cmd) {
      case "mobile_opaque_id": return `opaque:${String(a?.value)}`;
      case "mail_accounts_list": return [{ id: "acct", label: "Work", address: "me@work.test" }];
      case "mail_folders": return [{ id: folderId, account_id: "acct", path: "Archive", name: "Archive", kind: "archive", unread: 0, total: synced ? 1 : 0 }];
      case "mail_sync":
        expect(a).toEqual({ accountId: "acct", folderId });
        await sync();
        synced = true;
        return { account_id: "acct", new_messages: 1, filtered: 0 };
      case "mail_headers": return synced ? { items: [header("m1")], total: 1 } : { items: [], total: 0 };
      default: throw new Error(`unexpected ${cmd}`);
    }
  });
  return calls;
}

const opaque = (folderId: string) => `opaque:folder:${folderId}`;

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(invoke).mockReset();
});

describe("phone mail folder fetch", () => {
  it("fetches the folder from the server before answering its first page", async () => {
    const calls = serve("acct|archive-1", async () => {});
    const answer = await mailFolderPage(opaque("acct|archive-1"), 0, true);
    expect(calls).toContain("mail_sync");
    expect(answer).toMatchObject({ status: "mail", mail: { view: "folder", total: 1, folder: { total: 1 } } });
    expect(answer.status === "mail" && "syncing" in answer.mail).toBe(false);

    // Opened again within the minute: read from the index, no second fetch.
    calls.length = 0;
    await mailFolderPage(opaque("acct|archive-1"), 0, true);
    expect(calls).not.toContain("mail_sync");
  });

  it("answers with what the index holds and `syncing` while a fetch runs long", async () => {
    vi.useFakeTimers();
    let release = () => {};
    serve("acct|archive-2", () => new Promise<void>((resolve) => { release = resolve; }));
    const first = mailFolderPage(opaque("acct|archive-2"), 0, true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await first).toMatchObject({ mail: { view: "folder", total: 0, syncing: true } });

    release();
    await vi.advanceTimersByTimeAsync(0);
    const again = await mailFolderPage(opaque("acct|archive-2"), 0, true);
    expect(again).toMatchObject({ mail: { view: "folder", total: 1 } });
    expect(again.status === "mail" && "syncing" in again.mail).toBe(false);
  });

  it("does not fetch for a later page or for a write re-reading its page", async () => {
    const calls = serve("acct|archive-3", async () => {});
    await mailFolderPage(opaque("acct|archive-3"), 25, true);
    await mailFolderPage(opaque("acct|archive-3"), 0);
    expect(calls).not.toContain("mail_sync");
  });
});
