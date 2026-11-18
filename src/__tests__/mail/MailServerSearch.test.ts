import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Folder search goes to the server (`stores/mail`'s `loadPage` fork).
 *
 * A sync keeps only a folder's newest headers locally, so a local query can
 * never match an old mail: with a query active, a folder page is read through
 * `mail_search` (server first, backfilled into the index) rather than
 * `mail_headers`, and the page records whether the server was reached
 * (`searchRemote`) so a local-only answer renders as one. Priority lists stay
 * local — they span every account and folder, and a per-folder server search
 * has no single mailbox to ask.
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
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useSettingsStore } from "../../stores/settings";

function header(over: Partial<MailHeader> & { id: string }): MailHeader {
  return {
    account_id: "a1",
    folder_id: "a1|INBOX",
    uid: 1,
    subject: "old invoice",
    from: { address: "sender@example.com" },
    to: [],
    cc: [],
    date: "2024-01-01T09:00:00Z",
    seen: false,
    flagged: false,
    answered: false,
    has_attachments: false,
    size: 10,
    preview: "",
    ...over,
  };
}

const localPage = (items: MailHeader[]) => ({ items, total: items.length });
const searchPage = (items: MailHeader[], remote: boolean, partial = false) => ({
  items,
  total: items.length,
  remote,
  partial,
});

beforeEach(() => {
  invoked.length = 0;
  answers = {};
  useRootOverlayStore.setState({ open: false, view: "root" });
  useSettingsStore.setState({ settings: { mail_client: true } as never });
  useMailStore.setState({
    selectedAccountId: "a1",
    selectedFolderId: "a1|INBOX",
    selectedPriority: null,
    selectedMessageId: null,
    headers: [],
    headerTotal: 0,
    headerOffset: 0,
    query: "",
    searchRemote: false,
    searchPartial: false,
    sort: "date",
    sortDesc: true,
    unreadOnly: false,
    agentOnly: false,
    error: null,
  });
});

afterEach(() => vi.useRealTimers());

const cmds = () => invoked.map((i) => i.cmd);
const argsOf = (cmd: string) => invoked.find((i) => i.cmd === cmd)?.args;

describe("folder search", () => {
  it("waits for typing to pause before asking the server", async () => {
    vi.useFakeTimers();
    answers["mail_search"] = searchPage([header({ id: "m9" })], true);
    useRootOverlayStore.setState({ open: true, view: "mail" });
    useMailStore.getState().queueQuery("i");
    useMailStore.getState().queueQuery("in");
    useMailStore.getState().queueQuery("invoice");
    expect(useMailStore.getState().query).toBe("invoice");
    expect(cmds()).not.toContain("mail_search");
    await vi.advanceTimersByTimeAsync(299);
    expect(cmds()).not.toContain("mail_search");
    await vi.advanceTimersByTimeAsync(1);
    expect(cmds().filter((cmd) => cmd === "mail_search")).toHaveLength(1);
    expect(argsOf("mail_search")?.query).toBe("invoice");
  });

  it("clears typed search immediately without an IMAP request", async () => {
    vi.useFakeTimers();
    answers["mail_headers"] = localPage([header({ id: "m1" })]);
    useRootOverlayStore.setState({ open: true, view: "mail" });
    useMailStore.setState({ query: "invoice" });
    useMailStore.getState().queueQuery("");
    expect(useMailStore.getState().query).toBe("");
    expect(cmds()).toContain("mail_headers");
    await vi.advanceTimersByTimeAsync(300);
    expect(cmds()).not.toContain("mail_search");
  });

  it("holds a queued search while mail is hidden and resumes on show", async () => {
    vi.useFakeTimers();
    answers["mail_search"] = searchPage([], true);
    useRootOverlayStore.setState({ open: true, view: "mail" });
    useMailStore.getState().queueQuery("invoice");
    useMailStore.getState().closeOverlay();
    await vi.advanceTimersByTimeAsync(300);
    expect(cmds()).not.toContain("mail_search");
    useMailStore.getState().openOverlay();
    expect(cmds()).toContain("mail_search");
  });

  it("resumes a queued search when closing a composer back to the Inbox", async () => {
    vi.useFakeTimers();
    answers["mail_search"] = searchPage([], true);
    useRootOverlayStore.setState({ open: true, view: "mail" });
    useMailStore.getState().queueQuery("invoice");
    const tabId = useMailStore.getState().openComposeTab({ mode: "new", accountId: "a1" });
    await vi.advanceTimersByTimeAsync(300);
    expect(cmds()).not.toContain("mail_search");
    useMailStore.getState().closeMailTab(tabId);
    expect(cmds()).toContain("mail_search");
  });

  it("asks the server and records that it got there", async () => {
    answers["mail_search"] = searchPage([header({ id: "m9" })], true);
    useMailStore.setState({ query: "invoice" });
    await useMailStore.getState().loadPage(0);
    expect(cmds()).toContain("mail_search");
    expect(cmds()).not.toContain("mail_headers");
    expect(argsOf("mail_search")).toMatchObject({
      folderId: "a1|INBOX",
      query: "invoice",
      offset: 0,
    });
    expect(useMailStore.getState().headers.map((h) => h.id)).toEqual(["m9"]);
    expect(useMailStore.getState().searchRemote).toBe(true);
    expect(useMailStore.getState().searchPartial).toBe(false);
  });

  it("records when the server had more matches than could be loaded", async () => {
    answers["mail_search"] = searchPage([header({ id: "m9" })], true, true);
    await useMailStore.getState().setQuery("invoice");
    expect(useMailStore.getState().searchRemote).toBe(true);
    expect(useMailStore.getState().searchPartial).toBe(true);

    answers["mail_headers"] = localPage([header({ id: "m1" })]);
    await useMailStore.getState().clearFilters();
    expect(useMailStore.getState().searchPartial).toBe(false);
  });

  it("records a local-only answer as one", async () => {
    // Offline, no saved password, refused: the backend answers from the index
    // with `remote: false`, and the list must render that scope honestly.
    answers["mail_search"] = searchPage([header({ id: "m1" })], false);
    useMailStore.setState({ query: "invoice" });
    await useMailStore.getState().loadPage(0);
    expect(useMailStore.getState().searchRemote).toBe(false);
  });

  it("pages a search through the server, not the local page", async () => {
    answers["mail_search"] = searchPage([header({ id: "m9" })], true);
    useMailStore.setState({ query: "invoice" });
    await useMailStore.getState().loadPage(100);
    expect(argsOf("mail_search")).toMatchObject({ offset: 100, query: "invoice" });
    expect(useMailStore.getState().headerOffset).toBe(100);
  });

  it("reads a folder without a query locally", async () => {
    answers["mail_headers"] = localPage([header({ id: "m1" })]);
    await useMailStore.getState().loadPage(0);
    expect(cmds()).toContain("mail_headers");
    expect(cmds()).not.toContain("mail_search");
    expect(useMailStore.getState().searchRemote).toBe(false);
  });

  it("keeps a priority-list search local", async () => {
    answers["mail_priority_page"] = localPage([header({ id: "m1" })]);
    useMailStore.setState({ selectedPriority: "important", selectedFolderId: null });
    await useMailStore.getState().setQuery("invoice");
    expect(cmds()).toContain("mail_priority_page");
    expect(cmds()).not.toContain("mail_search");
    expect(useMailStore.getState().searchRemote).toBe(false);
  });

  it("clearing the search returns to the local page", async () => {
    answers["mail_search"] = searchPage([header({ id: "m9" })], true);
    answers["mail_headers"] = localPage([header({ id: "m1" })]);
    await useMailStore.getState().setQuery("invoice");
    expect(useMailStore.getState().searchRemote).toBe(true);
    await useMailStore.getState().clearFilters();
    expect(cmds()).toContain("mail_headers");
    expect(useMailStore.getState().searchRemote).toBe(false);
  });
});
