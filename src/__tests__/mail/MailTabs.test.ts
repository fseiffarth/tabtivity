import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MailDraft, MailHeader } from "../../types/mail";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { MAIL_INBOX_TAB, useMailStore } from "../../stores/mail";
import { isViewShown, useRootOverlayStore } from "../../stores/rootOverlay";
import { useSettingsStore } from "../../stores/settings";

const header = (id: string) => ({ id, account_id: "a1", subject: `S ${id}` }) as MailHeader;

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue([]);
  useMailStore.setState({
    mailTabs: [],
    activeMailTab: MAIL_INBOX_TAB,
    selectedAccountId: "a1",
  });
  useRootOverlayStore.setState({ open: false, view: "root" });
    useSettingsStore.setState({ settings: { mail_client: true } as never });
});

describe("the mail window's tabs", () => {
  it("opens a message once and focuses the tab it already has", () => {
    const s = useMailStore.getState();
    s.openMessageTab(header("m1"));
    s.openComposeTab({ mode: "new", accountId: "a1" });
    s.openMessageTab(header("m1"));
    const { mailTabs, activeMailTab } = useMailStore.getState();
    expect(mailTabs.filter((t) => t.kind === "message")).toHaveLength(1);
    expect(activeMailTab).toBe("msg:m1");
  });

  it("opening a listed message gives it a tab; an unlisted one opens nothing", () => {
    useMailStore.setState({ headers: [header("m1")], selectedMessageId: null });
    const s = useMailStore.getState();
    s.openMessage("m9");
    expect(useMailStore.getState().mailTabs).toHaveLength(0);
    s.openMessage("m1");
    const { mailTabs, activeMailTab, selectedMessageId } = useMailStore.getState();
    expect(mailTabs.map((t) => t.id)).toEqual(["msg:m1"]);
    expect(activeMailTab).toBe("msg:m1");
    expect(selectedMessageId).toBe("m1");
  });

  it("closing the tab on screen lands on its left neighbour, the Inbox last", () => {
    const s = useMailStore.getState();
    s.openMessageTab(header("m1"));
    const compose = s.openComposeTab({ mode: "new", accountId: "a1" });
    s.closeMailTab(compose);
    expect(useMailStore.getState().activeMailTab).toBe("msg:m1");
    s.closeMailTab("msg:m1");
    expect(useMailStore.getState().activeMailTab).toBe(MAIL_INBOX_TAB);
    expect(useMailStore.getState().mailTabs).toHaveLength(0);
  });

  it("closing a background tab leaves the one on screen alone", () => {
    const s = useMailStore.getState();
    s.openMessageTab(header("m1"));
    s.openMessageTab(header("m2"));
    s.closeMailTab("msg:m1");
    expect(useMailStore.getState().activeMailTab).toBe("msg:m2");
  });

  it("marks a composer dirty once, and follows its subject", () => {
    const s = useMailStore.getState();
    const id = s.openComposeTab({ mode: "new", accountId: "a1" });
    const before = useMailStore.getState().mailTabs;
    s.markComposeDirty(id, "");
    s.markComposeDirty(id, "Hello");
    const tab = useMailStore.getState().mailTabs[0];
    expect(tab.kind === "compose" && tab.dirty).toBe(true);
    expect(tab.kind === "compose" && tab.subject).toBe("Hello");
    // Same subject again is no write at all.
    const after = useMailStore.getState().mailTabs;
    s.markComposeDirty(id, "Hello");
    expect(useMailStore.getState().mailTabs).toBe(after);
    expect(before).not.toBe(after);
  });

  it("opens an agent's draft in a composer tab, once", async () => {
    const draft = { id: "d1", account_id: "a1", to: [], cc: [], bcc: [], subject: "Offer", body_text: "", staged: [], origin: "agent" } as MailDraft;
    await useMailStore.getState().openAgentDraft(draft);
    await useMailStore.getState().openAgentDraft(draft);
    const { mailTabs, activeMailTab } = useMailStore.getState();
    expect(isViewShown("mail")).toBe(true);
    expect(mailTabs).toHaveLength(1);
    expect(mailTabs[0].kind === "compose" && mailTabs[0].draft?.id).toBe("d1");
    expect(activeMailTab).toBe(mailTabs[0].id);
  });

  it("opens an agent's draft once even when two opens race the account load", async () => {
    useMailStore.setState({ selectedAccountId: "other" });
    const draft = { id: "d2", account_id: "a1", to: [], cc: [], bcc: [], subject: "", body_text: "", staged: [], origin: "agent" } as MailDraft;
    await Promise.all([
      useMailStore.getState().openAgentDraft(draft),
      useMailStore.getState().openAgentDraft(draft),
    ]);
    expect(useMailStore.getState().mailTabs).toHaveLength(1);
  });

  it("\"show me this in mail\" lands on the Inbox; the plain toggle keeps the last tab", async () => {
    const s = useMailStore.getState();
    s.openMessageTab(header("m1"));
    s.openOverlay();
    expect(useMailStore.getState().activeMailTab).toBe("msg:m1");
    await s.openAccountView("a1");
    expect(useMailStore.getState().activeMailTab).toBe(MAIL_INBOX_TAB);
    s.setActiveMailTab("msg:m1");
    await s.openPriorityView("urgent");
    expect(useMailStore.getState().activeMailTab).toBe(MAIL_INBOX_TAB);
    s.setActiveMailTab("msg:m1");
    s.openInbox();
    expect(useMailStore.getState().activeMailTab).toBe(MAIL_INBOX_TAB);
  });

  it("a saved composer is clean; dropping composers keeps message tabs", () => {
    const s = useMailStore.getState();
    s.openMessageTab(header("m1"));
    const id = s.openComposeTab({ mode: "new", accountId: "a1" });
    s.markComposeDirty(id, "Hi");
    s.markComposeClean(id, "Hi");
    const tab = useMailStore.getState().mailTabs.find((t) => t.id === id);
    expect(tab?.kind === "compose" && tab.dirty).toBe(false);
    s.dropComposeTabs();
    expect(useMailStore.getState().mailTabs.map((t) => t.id)).toEqual(["msg:m1"]);
    expect(useMailStore.getState().activeMailTab).toBe(MAIL_INBOX_TAB);
  });

  it("an unknown id puts the Inbox on screen", () => {
    useMailStore.getState().setActiveMailTab("nope");
    expect(useMailStore.getState().activeMailTab).toBe(MAIL_INBOX_TAB);
  });
});
