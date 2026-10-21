import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Deleting mail, and picking several rows to do it to.
 *
 * Two things here can destroy somebody's mail, and both are pinned down:
 *
 *  - **Where a delete goes** (`planMailDelete`). A delete is a *move to Trash*
 *    wherever there is one, and only otherwise the irreversible `UID EXPUNGE` —
 *    so a plan that reports "permanent" for mail with a perfectly good Trash
 *    folder is a plan that would destroy it. It is pure and shared by the
 *    confirmation and the commands, which is what keeps the sentence the user
 *    reads and the delete that runs from disagreeing.
 *  - **Which rows are in the selection.** `checkedIds` belongs to the *page*:
 *    a folder change, a re-sort, a search keystroke or a pager step all leave
 *    ids naming mail that is no longer on screen, and a bulk delete aimed at
 *    rows nobody can see is the one mistake this feature can make.
 */

const invoked: Array<{ cmd: string; args: Record<string, unknown> }> = [];
let answers: Record<string, unknown> = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args: Record<string, unknown>) => {
    invoked.push({ cmd, args });
    if (cmd in answers) return Promise.resolve(answers[cmd]);
    return Promise.resolve(undefined);
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { planMailDelete } from "../../lib/mail";
import { useMailStore } from "../../stores/mail";
import type { MailFolder, MailHeader } from "../../types/mail";

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

function folder(over: Partial<MailFolder> & { id: string }): MailFolder {
  return {
    account_id: "a1",
    path: "INBOX",
    name: "Inbox",
    kind: "inbox",
    unread: 0,
    total: 0,
    ...over,
  };
}

const INBOX = folder({ id: "a1|INBOX" });
const TRASH = folder({ id: "a1|Trash", path: "Trash", name: "Trash", kind: "trash" });
const JUNK = folder({ id: "a1|Junk", path: "Junk", name: "Junk", kind: "junk" });

const page = (items: MailHeader[]) => ({ items, total: items.length });
const cmds = () => invoked.map((i) => i.cmd);

beforeEach(() => {
  invoked.length = 0;
  answers = {};
  useMailStore.setState({
    selectedAccountId: "a1",
    selectedFolderId: "a1|INBOX",
    selectedPriority: null,
    selectedMessageId: null,
    mailTabs: [],
    checkedIds: [],
    anchorId: null,
    foldersByAccount: { a1: [INBOX, TRASH, JUNK] },
    headers: [],
    headerTotal: 0,
    headerOffset: 0,
    query: "",
    sort: "date",
    sortDesc: true,
    error: null,
  });
});

describe("planMailDelete", () => {
  it("sends an inbox message to that account's Trash", () => {
    const plan = planMailDelete([header({ id: "m1" })], { a1: [INBOX, TRASH] });
    expect(plan).toEqual([
      {
        accountId: "a1",
        folderId: "a1|INBOX",
        messageIds: ["m1"],
        trashFolderId: "a1|Trash",
      },
    ]);
  });

  it("deletes a message already in the Trash for good", () => {
    const plan = planMailDelete([header({ id: "m1", folder_id: "a1|Trash" })], {
      a1: [INBOX, TRASH],
    });
    expect(plan[0]?.trashFolderId).toBeNull();
  });

  it("deletes for good when the account has no Trash folder", () => {
    const plan = planMailDelete([header({ id: "m1" })], { a1: [INBOX] });
    expect(plan[0]?.trashFolderId).toBeNull();
  });

  it("still moves mail out of Junk — spam is a classification, not a delete", () => {
    const plan = planMailDelete([header({ id: "m1", folder_id: "a1|Junk" })], {
      a1: [INBOX, TRASH, JUNK],
    });
    expect(plan[0]?.trashFolderId).toBe("a1|Trash");
  });

  it("groups by folder, because one command selects one mailbox", () => {
    const plan = planMailDelete(
      [
        header({ id: "m1" }),
        header({ id: "m2", folder_id: "a1|Junk" }),
        header({ id: "m3" }),
      ],
      { a1: [INBOX, TRASH, JUNK] },
    );
    expect(plan).toHaveLength(2);
    expect(plan.find((g) => g.folderId === "a1|INBOX")?.messageIds).toEqual(["m1", "m3"]);
    expect(plan.find((g) => g.folderId === "a1|Junk")?.messageIds).toEqual(["m2"]);
  });

  it("resolves each account's Trash separately in a cross-account list", () => {
    const b1 = folder({ id: "b1|INBOX", account_id: "b1" });
    const plan = planMailDelete(
      [header({ id: "m1" }), header({ id: "m2", account_id: "b1", folder_id: "b1|INBOX" })],
      { a1: [INBOX, TRASH], b1: [b1] },
    );
    expect(plan.find((g) => g.accountId === "a1")?.trashFolderId).toBe("a1|Trash");
    // b1 has no Trash folder of its own — and a1's is not an answer for it.
    expect(plan.find((g) => g.accountId === "b1")?.trashFolderId).toBeNull();
  });

  it("keeps a message in an unknown folder on the recoverable path", () => {
    const plan = planMailDelete([header({ id: "m1", folder_id: "a1|Gone" })], {
      a1: [INBOX, TRASH],
    });
    expect(plan[0]?.trashFolderId).toBe("a1|Trash");
  });
});

describe("the tick marks", () => {
  beforeEach(() => {
    useMailStore.setState({
      headers: ["m1", "m2", "m3", "m4"].map((id) => header({ id })),
    });
  });

  it("a plain pick replaces the set and anchors on it", () => {
    useMailStore.getState().toggleChecked("m1");
    useMailStore.getState().checkOnly("m3");
    expect(useMailStore.getState().checkedIds).toEqual(["m3"]);
    expect(useMailStore.getState().anchorId).toBe("m3");
  });

  it("a toggle adds and removes one row, leaving the rest alone", () => {
    useMailStore.getState().checkOnly("m1");
    useMailStore.getState().toggleChecked("m3");
    expect(useMailStore.getState().checkedIds).toEqual(["m1", "m3"]);
    useMailStore.getState().toggleChecked("m1");
    expect(useMailStore.getState().checkedIds).toEqual(["m3"]);
  });

  it("a range covers everything between the anchor and the row, either way round", () => {
    const order = ["m1", "m2", "m3", "m4"];
    useMailStore.getState().checkOnly("m3");
    useMailStore.getState().checkRange("m1", order);
    expect(useMailStore.getState().checkedIds).toEqual(["m1", "m2", "m3"]);
    // The anchor does not move, so a second Shift-click stretches the same range.
    useMailStore.getState().checkRange("m4", order);
    expect(useMailStore.getState().checkedIds).toEqual(["m3", "m4"]);
  });

  it("a range with no anchor on the page is an ordinary pick", () => {
    useMailStore.setState({ checkedIds: [], anchorId: "gone" });
    useMailStore.getState().checkRange("m2", ["m1", "m2", "m3"]);
    expect(useMailStore.getState().checkedIds).toEqual(["m2"]);
  });

  it("a page read clears them — the ids would name mail off screen", async () => {
    answers["mail_headers"] = page([header({ id: "z1" })]);
    useMailStore.getState().checkOnly("m2");
    await useMailStore.getState().loadPage(0);
    expect(useMailStore.getState().checkedIds).toEqual([]);
    expect(useMailStore.getState().anchorId).toBeNull();
  });
});

describe("deleteMessages", () => {
  beforeEach(() => {
    useMailStore.setState({
      headers: [
        header({ id: "m1" }),
        header({ id: "m2" }),
        header({ id: "m3", folder_id: "a1|Trash" }),
      ],
    });
    answers["mail_headers"] = page([]);
    answers["mail_folders"] = [INBOX, TRASH, JUNK];
  });

  it("moves to Trash in one command per folder", async () => {
    await useMailStore.getState().deleteMessages(["m1", "m2"]);
    const move = invoked.filter((i) => i.cmd === "mail_move");
    expect(move).toHaveLength(1);
    expect(move[0]?.args).toMatchObject({
      messageIds: ["m1", "m2"],
      destFolderId: "a1|Trash",
    });
    expect(cmds()).not.toContain("mail_purge");
  });

  it("purges only what has nowhere left to go", async () => {
    await useMailStore.getState().deleteMessages(["m1", "m3"]);
    expect(invoked.find((i) => i.cmd === "mail_move")?.args).toMatchObject({
      messageIds: ["m1"],
    });
    expect(invoked.find((i) => i.cmd === "mail_purge")?.args).toMatchObject({
      messageIds: ["m3"],
    });
  });

  it("closes the open message and its tab when it was one of them", async () => {
    const h = useMailStore.getState().headers.find((x) => x.id === "m1")!;
    useMailStore.getState().openMessageTab(h);
    useMailStore.setState({ selectedMessageId: "m1" });
    await useMailStore.getState().deleteMessages(["m1"]);
    expect(useMailStore.getState().selectedMessageId).toBeNull();
    expect(useMailStore.getState().mailTabs).toHaveLength(0);
  });

  it("leaves another open message alone", async () => {
    useMailStore.setState({ selectedMessageId: "m2" });
    await useMailStore.getState().deleteMessages(["m1"]);
    expect(useMailStore.getState().selectedMessageId).toBe("m2");
  });

  it("re-reads the page and the folder counts afterwards", async () => {
    await useMailStore.getState().deleteMessages(["m1"]);
    expect(cmds()).toContain("mail_headers");
    expect(cmds()).toContain("mail_folders");
  });

  it("reports a refused delete instead of throwing", async () => {
    answers["mail_move"] = Promise.reject("the server said no");
    await useMailStore.getState().deleteMessages(["m1"]);
    expect(useMailStore.getState().error).toBe("the server said no");
  });

  it("does nothing at all for rows that are not on the page", async () => {
    await useMailStore.getState().deleteMessages(["nope"]);
    expect(cmds()).toEqual([]);
  });
});

describe("paging the unread filter", () => {
  // The filtered set shrinks as it is read: rows opened on this page have left
  // it by the time "Older" is pressed, so a whole-page step would skip that
  // many unread mails.
  it("steps forward by the rows still unread, not by a whole page", async () => {
    answers.mail_headers = page([]);
    useMailStore.setState({
      unreadOnly: true,
      headerOffset: 0,
      headers: [
        header({ id: "m1", seen: true }),
        header({ id: "m2", seen: true }),
        header({ id: "m3" }),
      ],
    });
    await useMailStore.getState().stepPage(100);
    expect(invoked.find((i) => i.cmd === "mail_headers")?.args.offset).toBe(98);
  });

  it("steps a whole page backwards, and whenever the filter is off", async () => {
    answers.mail_headers = page([]);
    const headers = [header({ id: "m1", seen: true }), header({ id: "m2" })];
    useMailStore.setState({ unreadOnly: true, headerOffset: 200, headers });
    await useMailStore.getState().stepPage(100);
    useMailStore.setState({ unreadOnly: false, headerOffset: 0, headers });
    await useMailStore.getState().stepPage(100);
    const offsets = invoked.filter((i) => i.cmd === "mail_headers").map((i) => i.args.offset);
    expect(offsets).toEqual([100, 100]);
  });
});

describe("moving messages to a folder", () => {
  beforeEach(() => {
    useMailStore.setState({ headers: [
      header({ id: "m1" }), header({ id: "m2" }),
      header({ id: "m3", folder_id: JUNK.id }),
      header({ id: "m4", folder_id: TRASH.id }),
    ] });
    answers.mail_headers = page([]);
    answers.mail_folders = [INBOX, TRASH, JUNK];
  });

  it("moves a whole selection in one command per source folder, skipping mail already there", async () => {
    await useMailStore.getState().moveMessages(["m1", "m2", "m3", "m4"], TRASH.id);
    expect(invoked.filter((i) => i.cmd === "mail_move").map((i) => i.args)).toEqual([
      { messageIds: ["m1", "m2"], destFolderId: TRASH.id },
      { messageIds: ["m3"], destFolderId: TRASH.id },
    ]);
    expect(cmds()).not.toContain("mail_purge");
    expect(cmds()).not.toContain("mail_flag");
    expect(cmds()).toContain("mail_folders");
    expect(cmds()).toContain("mail_headers");
  });

  it("rejects a cross-account selection as a whole", async () => {
    useMailStore.setState({ headers: [header({ id: "m1" }), header({ id: "m2", account_id: "b1" })] });
    await useMailStore.getState().moveMessages(["m1", "m2"], TRASH.id);
    expect(cmds()).toEqual([]);
  });

  it("ignores stale ids, unknown destinations and same-folder drops", async () => {
    await useMailStore.getState().moveMessages(["m1", "gone"], TRASH.id);
    await useMailStore.getState().moveMessages(["m1"], "unknown");
    await useMailStore.getState().moveMessages(["m1"], INBOX.id);
    expect(cmds()).toEqual([]);
  });

  it("keeps open tabs and updates their folder after a successful move", async () => {
    useMailStore.getState().openMessageTab(header({ id: "m1" }));
    await useMailStore.getState().moveMessages(["m1"], TRASH.id);
    const tab = useMailStore.getState().mailTabs[0];
    expect(tab?.kind === "message" && tab.header.folder_id).toBe(TRASH.id);
  });

  it("reports a failed move without changing the open tab's folder", async () => {
    useMailStore.getState().openMessageTab(header({ id: "m1" }));
    answers.mail_move = Promise.reject("move refused");
    await useMailStore.getState().moveMessages(["m1"], TRASH.id);
    expect(useMailStore.getState().error).toBe("move refused");
    const tab = useMailStore.getState().mailTabs[0];
    expect(tab?.kind === "message" && tab.header.folder_id).toBe(INBOX.id);
  });

  it("backs up if the moved messages emptied the last page", async () => {
    useMailStore.setState({ headerOffset: 100 });
    await useMailStore.getState().moveMessages(["m1"], TRASH.id);
    expect(invoked.filter((i) => i.cmd === "mail_headers").map((i) => i.args.offset)).toEqual([100, 0]);
  });
});
