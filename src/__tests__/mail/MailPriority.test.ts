import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Important / Urgent lists (`stores/mail`'s `selectedPriority`).
 *
 * These are the two states of ONE list: a folder is showing, or a priority list
 * is, never both — and `loadPage` is the single fork between them. Everything
 * downstream (the pager, the search box, the sort menu, `MailList` itself) is
 * deliberately unaware of which it has, so the fork is the only place the
 * distinction can be got wrong, and it is what most of this file pins down.
 *
 * The second thing pinned down here is the one the *backend* cannot check: that
 * selecting one clears the other. A stale `selectedFolderId` under a priority
 * list is not a cosmetic bug — `markFolderRead` and `mailMove` take a folder id,
 * so a leftover one is a command aimed at a folder the user is not looking at.
 */

const invoked: Array<{ cmd: string; args: Record<string, unknown> }> = [];
/** Per-command canned answers, set by each test. */
let answers: Record<string, unknown> = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args: Record<string, unknown>) => {
    invoked.push({ cmd, args });
    if (cmd in answers) return Promise.resolve(answers[cmd]);
    return Promise.resolve(undefined);
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { useMailStore } from "../../stores/mail";
import type { MailHeader } from "../../types/mail";
import { isViewShown, useRootOverlayStore } from "../../stores/rootOverlay";
import { useSettingsStore } from "../../stores/settings";

function header(over: Partial<MailHeader> & { id: string }): MailHeader {
  return {
    account_id: "a1",
    folder_id: "a1|INBOX",
    uid: 1,
    subject: "hello",
    from: { address: "sender@example.com" },
    to: [],
    cc: [],
    date: "2026-07-01T09:00:00Z",
    seen: false,
    flagged: false,
    answered: false,
    has_attachments: false,
    size: 10,
    preview: "",
    ...over,
  };
}

const page = (items: MailHeader[]) => ({ items, total: items.length });

beforeEach(() => {
  invoked.length = 0;
  answers = {};
  useMailStore.setState({
    selectedAccountId: "a1",
    selectedFolderId: "a1|INBOX",
    selectedPriority: null,
    selectedMessageId: null,
    headers: [],
    headerTotal: 0,
    headerOffset: 0,
    query: "",
    sort: "date",
    sortDesc: true,
    error: null,
    priorityCounts: { important: 0, urgent: 0, important_unread: 0, urgent_unread: 0 },
  });
});

const cmds = () => invoked.map((i) => i.cmd);
const argsOf = (cmd: string) => invoked.find((i) => i.cmd === cmd)?.args;

describe("opening a priority list", () => {
  it("reads the cross-account page, not the folder page", () => {
    answers["mail_priority_page"] = page([header({ id: "m1" })]);
    return useMailStore
      .getState()
      .openPriority("important")
      .then(() => {
        expect(cmds()).toContain("mail_priority_page");
        expect(cmds()).not.toContain("mail_headers");
        expect(argsOf("mail_priority_page")).toMatchObject({
          priority: "important",
          offset: 0,
        });
        expect(useMailStore.getState().headers.map((h) => h.id)).toEqual(["m1"]);
      });
  });

  it("clears the folder selection", async () => {
    // The load-bearing one. `markFolderRead` and `mailMove` are addressed by
    // folder id, so a folder left selected under a cross-account list is a
    // command pointed at something the user is not looking at.
    await useMailStore.getState().openPriority("urgent");
    expect(useMailStore.getState().selectedFolderId).toBeNull();
    expect(useMailStore.getState().selectedPriority).toBe("urgent");
  });

  it("keeps the account selection, so the rail still has folders under it", async () => {
    await useMailStore.getState().openPriority("urgent");
    expect(useMailStore.getState().selectedAccountId).toBe("a1");
  });

  it("drops the open message — it may not be on the new list at all", async () => {
    useMailStore.setState({ selectedMessageId: "m9" });
    await useMailStore.getState().openPriority("important");
    expect(useMailStore.getState().selectedMessageId).toBeNull();
  });
});

describe("leaving a priority list", () => {
  it("openFolder goes back to the folder page", async () => {
    await useMailStore.getState().openPriority("important");
    invoked.length = 0;
    answers["mail_headers"] = page([]);

    await useMailStore.getState().openFolder("a1|Archive");
    expect(useMailStore.getState().selectedPriority).toBeNull();
    expect(cmds()).toContain("mail_headers");
    expect(cmds()).not.toContain("mail_priority_page");
  });

  it("selectAccount leaves it too", async () => {
    // Otherwise the pane would show every account's marked mail with one
    // account's name highlighted beside it.
    answers["mail_folders"] = [];
    await useMailStore.getState().openPriority("important");
    await useMailStore.getState().selectAccount("a2");
    expect(useMailStore.getState().selectedPriority).toBeNull();
  });
});

describe("the list behaves like a folder", () => {
  it("searching re-reads the priority page with the query", async () => {
    answers["mail_priority_page"] = page([]);
    await useMailStore.getState().openPriority("urgent");
    invoked.length = 0;

    await useMailStore.getState().setQuery("invoice");
    expect(argsOf("mail_priority_page")).toMatchObject({
      priority: "urgent",
      query: "invoice",
      offset: 0,
    });
  });

  it("sorting re-reads it from page 1", async () => {
    answers["mail_priority_page"] = page([]);
    await useMailStore.getState().openPriority("important");
    useMailStore.setState({ headerOffset: 300 });
    invoked.length = 0;

    await useMailStore.getState().setSort("size", false);
    expect(argsOf("mail_priority_page")).toMatchObject({ sort: "size", desc: false, offset: 0 });
  });

  it("paging pages it", async () => {
    answers["mail_priority_page"] = page([]);
    await useMailStore.getState().openPriority("important");
    invoked.length = 0;

    await useMailStore.getState().loadPage(100);
    expect(argsOf("mail_priority_page")).toMatchObject({ offset: 100 });
    expect(useMailStore.getState().headerOffset).toBe(100);
  });

  it("shows nothing when neither a folder nor a list is selected", async () => {
    useMailStore.setState({ selectedFolderId: null, selectedPriority: null, headers: [header({ id: "x" })] });
    await useMailStore.getState().loadPage(0);
    expect(useMailStore.getState().headers).toEqual([]);
    expect(cmds()).toHaveLength(0);
  });
});

describe("marking a message", () => {
  it("sends the mark and patches the row on screen", async () => {
    answers["mail_priority_set"] = true;
    useMailStore.setState({ headers: [header({ id: "m1" }), header({ id: "m2" })] });

    await useMailStore.getState().setPriority("m1", "urgent");
    expect(argsOf("mail_priority_set")).toMatchObject({ messageId: "m1", priority: "urgent" });
    const rows = useMailStore.getState().headers;
    expect(rows.find((h) => h.id === "m1")?.priority).toBe("urgent");
    expect(rows.find((h) => h.id === "m2")?.priority).toBeUndefined();
  });

  it("opens no socket — the mark is local", async () => {
    // The property the whole design rests on: this is the one mail action that
    // can be taken freely because nothing about it can reach a server.
    answers["mail_priority_set"] = true;
    useMailStore.setState({ headers: [header({ id: "m1" })] });

    await useMailStore.getState().setPriority("m1", "important");
    expect(cmds()).not.toContain("mail_sync");
    expect(cmds()).not.toContain("mail_flag");
    expect(cmds()).not.toContain("mail_move");
  });

  it("clears the mark with null", async () => {
    answers["mail_priority_set"] = true;
    useMailStore.setState({ headers: [header({ id: "m1", priority: "urgent" })] });

    await useMailStore.getState().setPriority("m1", null);
    expect(argsOf("mail_priority_set")).toMatchObject({ priority: null });
    expect(useMailStore.getState().headers[0].priority).toBeUndefined();
  });

  it("refreshes the badge counts", async () => {
    answers["mail_priority_set"] = true;
    answers["mail_priority_counts"] = {
      important: 3,
      urgent: 1,
      important_unread: 2,
      urgent_unread: 0,
    };
    useMailStore.setState({ headers: [header({ id: "m1" })] });

    await useMailStore.getState().setPriority("m1", "important");
    expect(useMailStore.getState().priorityCounts).toMatchObject({ important: 3, urgent: 1 });
  });

  it("re-reads the page when unmarking from inside a priority list", async () => {
    // The row has just left the list it is being viewed in, so leaving the page
    // alone would keep showing mail the list no longer contains.
    answers["mail_priority_page"] = page([]);
    answers["mail_priority_set"] = true;
    await useMailStore.getState().openPriority("important");
    useMailStore.setState({ headers: [header({ id: "m1", priority: "important" })] });
    invoked.length = 0;

    await useMailStore.getState().setPriority("m1", null);
    expect(cmds()).toContain("mail_priority_page");
  });

  it("does not re-read the page when marking from a folder", async () => {
    // Nothing about a folder's contents changed — only a badge did.
    answers["mail_priority_set"] = true;
    useMailStore.setState({ headers: [header({ id: "m1" })] });
    invoked.length = 0;

    await useMailStore.getState().setPriority("m1", "important");
    expect(cmds()).not.toContain("mail_headers");
  });

  it("says so when the message is no longer in the index", async () => {
    // `false` is a real outcome, not a success: the optimistic patch above has
    // already told the user it worked, so something has to take that back.
    answers["mail_priority_set"] = false;
    useMailStore.setState({ headers: [header({ id: "m1" })] });

    await useMailStore.getState().setPriority("m1", "urgent");
    expect(useMailStore.getState().error).toBeTruthy();
  });

  it("lands a rejected invoke in `error` rather than throwing", async () => {
    const core = await import("@tauri-apps/api/core");
    vi.mocked(core.invoke).mockRejectedValueOnce("the mail store is locked");
    useMailStore.setState({ headers: [header({ id: "m1" })] });

    await expect(useMailStore.getState().setPriority("m1", "urgent")).resolves.toBeUndefined();
    expect(useMailStore.getState().error).toBe("the mail store is locked");
  });
});

describe("the header dropdown's entries", () => {
  // `openAccountView` / `openPriorityView`: "open the overlay ON this" as ONE
  // action. Split across the caller they would either render a frame of the
  // previous target or retarget an overlay that is not open yet.
  const folder = (id: string, account_id: string) => ({
    id,
    account_id,
    path: "INBOX",
    name: "Inbox",
    kind: "inbox" as const,
    unread: 0,
    total: 0,
  });

  beforeEach(() => {
    useRootOverlayStore.setState({ open: false, view: "root" });
    useSettingsStore.setState({ settings: { mail_client: true } as never });
    useMailStore.setState({
      accountsLoaded: true,
      accounts: [],
      foldersByAccount: {},
    });
  });

  it("opens the overlay on the priority list in one action", async () => {
    answers["mail_priority_page"] = page([header({ id: "m1" })]);
    await useMailStore.getState().openPriorityView("urgent");
    const s = useMailStore.getState();
    expect(isViewShown("mail")).toBe(true);
    expect(s.selectedPriority).toBe("urgent");
    expect(s.selectedFolderId).toBeNull();
  });

  it("opens the overlay on an account's default folder", async () => {
    answers["mail_folders"] = [folder("a2|INBOX", "a2")];
    answers["mail_headers"] = page([]);

    await useMailStore.getState().openAccountView("a2");
    const s = useMailStore.getState();
    expect(isViewShown("mail")).toBe(true);
    expect(s.selectedAccountId).toBe("a2");
    expect(s.selectedFolderId).toBe("a2|INBOX");
  });

  it("re-enters the account when a priority list is what is on screen", async () => {
    // The case the no-op below must not swallow: the account is still selected
    // behind a cross-account list, but no folder of it is showing.
    answers["mail_priority_page"] = page([]);
    answers["mail_folders"] = [folder("a1|INBOX", "a1")];
    answers["mail_headers"] = page([]);
    await useMailStore.getState().openPriorityView("important");
    invoked.length = 0;

    await useMailStore.getState().openAccountView("a1");
    expect(useMailStore.getState().selectedPriority).toBeNull();
    expect(useMailStore.getState().selectedFolderId).toBe("a1|INBOX");
  });

  it("leaves the folder you navigated to alone when re-picking that account", async () => {
    // `selectAccount` re-opens the inbox, so a second click on the row you are
    // already reading would throw the browsed folder away.
    useMailStore.setState({ selectedAccountId: "a1", selectedFolderId: "a1|Archive" });
    await useMailStore.getState().openAccountView("a1");
    expect(useMailStore.getState().selectedFolderId).toBe("a1|Archive");
    expect(isViewShown("mail")).toBe(true);
    expect(cmds()).not.toContain("mail_headers");
  });

  it("reaches no server — every read behind the menu is local", async () => {
    answers["mail_folders"] = [folder("a2|INBOX", "a2")];
    answers["mail_headers"] = page([]);
    answers["mail_priority_page"] = page([]);

    await useMailStore.getState().openAccountView("a2");
    await useMailStore.getState().openPriorityView("important");
    expect(cmds()).not.toContain("mail_sync");
    // `refresh: false` — opening a mailbox must never dial out.
    expect(invoked.filter((i) => i.cmd === "mail_folders").every((i) => i.args.refresh === false))
      .toBe(true);
  });
});

describe("the badge counts", () => {
  it("are read as one value, so the two numbers cannot disagree", async () => {
    answers["mail_priority_counts"] = {
      important: 5,
      urgent: 2,
      important_unread: 1,
      urgent_unread: 2,
    };
    await useMailStore.getState().refreshPriorityCounts();
    expect(invoked.filter((i) => i.cmd === "mail_priority_counts")).toHaveLength(1);
    expect(useMailStore.getState().priorityCounts).toEqual({
      important: 5,
      urgent: 2,
      important_unread: 1,
      urgent_unread: 2,
    });
  });

  it("keep the last reading — and raise no banner — when the read fails", async () => {
    // A red error strip because two numbers on a badge could not be counted
    // would be a worse outcome than the stale numbers.
    useMailStore.setState({
      priorityCounts: { important: 4, urgent: 0, important_unread: 0, urgent_unread: 0 },
    });
    const core = await import("@tauri-apps/api/core");
    vi.mocked(core.invoke).mockRejectedValueOnce("nope");

    await useMailStore.getState().refreshPriorityCounts();
    expect(useMailStore.getState().priorityCounts.important).toBe(4);
    expect(useMailStore.getState().error).toBeNull();
  });
});

describe("emptying a list", () => {
  it("re-reads the page and the counts when the open list is the one cleared", async () => {
    answers["mail_priority_clear"] = 3;
    answers["mail_priority_counts"] = {
      important: 0,
      urgent: 0,
      important_unread: 0,
      urgent_unread: 0,
    };
    answers["mail_priority_page"] = page([]);
    useMailStore.setState({
      selectedFolderId: null,
      selectedPriority: "urgent",
      headers: [header({ id: "m1" })],
      headerOffset: 100,
    });

    await useMailStore.getState().clearPriority("urgent");
    expect(argsOf("mail_priority_clear")).toEqual({ priority: "urgent" });
    expect(cmds()).toContain("mail_priority_counts");
    // Page 1, not the offset it was on: the list it was paging through is gone.
    expect(argsOf("mail_priority_page")?.offset).toBe(0);
    expect(useMailStore.getState().headers).toEqual([]);
  });

  it("touches no list on screen when the other one was cleared", async () => {
    answers["mail_priority_clear"] = 2;
    answers["mail_priority_counts"] = {
      important: 0,
      urgent: 1,
      important_unread: 0,
      urgent_unread: 1,
    };
    useMailStore.setState({ selectedFolderId: null, selectedPriority: "urgent" });

    await useMailStore.getState().clearPriority("important");
    expect(cmds()).not.toContain("mail_priority_page");
    expect(cmds()).not.toContain("mail_headers");
  });

  it("leaves the page alone and reports the reason when the write fails", async () => {
    // No optimistic patch to roll back — a list blanked before the write landed
    // would be indistinguishable from a write that failed and took the mail.
    const core = await import("@tauri-apps/api/core");
    vi.mocked(core.invoke).mockRejectedValueOnce("locked");
    useMailStore.setState({
      selectedFolderId: null,
      selectedPriority: "urgent",
      headers: [header({ id: "m1", priority: "urgent" })],
    });

    await useMailStore.getState().clearPriority("urgent");
    expect(useMailStore.getState().error).toBe("locked");
    expect(useMailStore.getState().headers).toHaveLength(1);
    expect(cmds()).not.toContain("mail_priority_page");
  });

  it("reaches no server", async () => {
    answers["mail_priority_clear"] = 1;
    answers["mail_priority_counts"] = {
      important: 0,
      urgent: 0,
      important_unread: 0,
      urgent_unread: 0,
    };
    await useMailStore.getState().clearPriority("important");
    expect(cmds()).not.toContain("mail_sync");
    expect(cmds()).not.toContain("mail_move");
  });
});
