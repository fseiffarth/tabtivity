import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MailAccount, MailDraft } from "../../types/mail";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { MailComposeDialog } from "../../components/mail/MailComposeDialog";
import { RootReviewStrip } from "../../components/layout/RootReviewStrip";
import { MailAgentDraftList } from "../../components/mail/MailAgentDraftList";
import { useRootReviewStore, type RootProposal } from "../../stores/rootReview";
import { useMailStore } from "../../stores/mail";

const account = { id: "a1", label: "Me", address: "me@home.example" } as MailAccount;
function draft(overrides: Partial<MailDraft> = {}): MailDraft {
  return {
    id: "d1", account_id: "a1", to: [], cc: [], bcc: [], subject: "Offer", body_text: "Dear…",
    staged: [], origin: "agent", ...overrides,
  };
}

function proposal(id: string, tool: string): RootProposal {
  return { id, tab: "root:1", tool, args: {}, created: "0", rows: [], calendars: [], tainted: false,
    status: "pending", undo: false, digest: id, closed: false };
}

beforeEach(() => {
  vi.clearAllMocks();
  invoke.mockResolvedValue([]);
  useRootReviewStore.setState({ proposals: [], count: 0, busy: false, error: null });
  useMailStore.setState({ agentDrafts: [], pendingAgentDrafts: [], mailTabs: [], activeMailTab: "inbox" });
});
afterEach(cleanup);

describe("drafts an agent wrote", () => {
  it("opens with the banner, the draft's text, and the type-it-yourself note", () => {
    render(<MailComposeDialog accounts={[account]} accountId="a1" mode="new" draft={draft()} onClose={() => {}} />);
    expect(screen.getByText("Drafted by an agent.")).toBeTruthy();
    expect(screen.getByText("The agent cannot choose who receives this. Type the recipient yourself.")).toBeTruthy();
    expect(screen.getByDisplayValue("Offer")).toBeTruthy();
    expect(screen.getByDisplayValue("Dear…")).toBeTruthy();
  });

  it("says so when the agent reads mail from outside, and keeps the thread's recipient", () => {
    render(
      <MailComposeDialog
        accounts={[account]}
        accountId="a1"
        mode="new"
        draft={draft({ origin: "reader", to: ["bob@friends.example"], in_reply_to: "<m1@mail.example>", references: ["<m1@mail.example>"] })}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Drafted by an agent that reads mail from outside.")).toBeTruthy();
    expect(screen.queryByText("The agent cannot choose who receives this. Type the recipient yourself.")).toBeNull();
    expect(screen.getByDisplayValue("bob@friends.example")).toBeTruthy();
  });

  it("saves the stored draft in place, threading intact, and never as the agent's", async () => {
    const d = draft({ origin: "reader", to: ["bob@friends.example"], in_reply_to: "<m1@mail.example>", references: ["<m1@mail.example>"] });
    invoke.mockImplementation((cmd: string, args: { draft: MailDraft }) =>
      Promise.resolve(cmd === "mail_draft_save" ? args.draft : []));
    render(<MailComposeDialog accounts={[account]} accountId="a1" mode="new" draft={d} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("mail_draft_save", expect.anything()));
    const sent = invoke.mock.calls.find((c) => c[0] === "mail_draft_save")![1].draft as MailDraft;
    expect(sent.id).toBe("d1");
    expect(sent.in_reply_to).toBe("<m1@mail.example>");
    expect(sent.references).toEqual(["<m1@mail.example>"]);
    // The composer never sends an origin; the backend clears the stored one.
    expect(sent.origin).toBeUndefined();
  });

  it("discards through the backend and closes", async () => {
    const onClose = vi.fn();
    invoke.mockResolvedValue(undefined);
    render(<MailComposeDialog accounts={[account]} accountId="a1" mode="new" draft={draft()} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith("mail_draft_discard", { draftId: "d1" });
  });

  it("an ordinary compose shows no banner and no discard", () => {
    render(<MailComposeDialog accounts={[account]} accountId="a1" mode="new" onClose={() => {}} />);
    expect(screen.queryByText("Drafted by an agent.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Discard draft" })).toBeNull();
  });

  it("is a row in the review strip that opens the composer and whose ✓ only files it", async () => {
    const openAgentDraft = vi.fn().mockResolvedValue(undefined);
    const d = draft({ origin: "reader", subject: "Re: Lunch‮" });
    useMailStore.setState({ pendingAgentDrafts: [d], openAgentDraft });
    render(<RootReviewStrip />);
    expect(screen.getByText(/Re: Lunch$/)).toBeTruthy();
    expect(screen.getByText("Drafted by an agent that reads mail from outside.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open in composer" }));
    expect(openAgentDraft).toHaveBeenCalledWith(d);
    fireEvent.click(screen.getByRole("button", { name: /^Approve: file it under Drafted by agents/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("mail_agent_drafts_file", { drafts: [d] }));
    expect(invoke).not.toHaveBeenCalledWith("mail_send", expect.anything());
  });

  it("✗ discards a waiting draft, and the mail group's Approve all files every waiting draft", async () => {
    const a = draft();
    const b = draft({ id: "d2", subject: "Second" });
    useMailStore.setState({ pendingAgentDrafts: [a, b] });
    useRootReviewStore.setState({ proposals: [proposal("p1", "todo_add")], count: 1 });
    render(<RootReviewStrip />);
    fireEvent.click(screen.getAllByRole("button", { name: "Discard" })[1]);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("mail_draft_discard", { draftId: "d2" }));
    await waitFor(() => expect(useRootReviewStore.getState().busy).toBe(false));
    // Two groups, two Approve alls: mail's files the drafts and leaves the
    // board's proposal pending.
    // (The discard's reload emptied the mocked list; put both back.)
    act(() => useMailStore.setState({ pendingAgentDrafts: [a, b] }));
    const [mailAll, boardAll] = screen.getAllByRole("button", { name: /^✓ Approve all/ });
    expect(boardAll.textContent).toBe("✓ Approve all (1)");
    fireEvent.click(mailAll);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("mail_agent_drafts_file", { drafts: [a, b] }));
    expect(invoke).not.toHaveBeenCalledWith("root_mcp_review_apply_all", expect.anything());
  });

  it("the store splits what the backend returns into filed and waiting, and treats a locked store as empty", async () => {
    invoke.mockResolvedValueOnce([draft(), draft({ id: "d2", filed: true })]);
    await useMailStore.getState().loadAgentDrafts();
    expect(useMailStore.getState().agentDrafts.map((d) => d.id)).toEqual(["d2"]);
    expect(useMailStore.getState().pendingAgentDrafts.map((d) => d.id)).toEqual(["d1"]);
    invoke.mockRejectedValueOnce("mail is locked");
    await useMailStore.getState().loadAgentDrafts();
    expect(useMailStore.getState().agentDrafts).toEqual([]);
    expect(useMailStore.getState().pendingAgentDrafts).toEqual([]);
  });

  it("the rail entry lists every account's drafts, each naming its account; a click opens the composer", () => {
    const onOpen = vi.fn();
    const d = draft({ to: ["bob@friends.example"], subject: "Offer‮" });
    const other = draft({ id: "d2", account_id: "a2", to: ["eve@work.example"], subject: "Report" });
    const labels: Record<string, string> = { a1: "Me", a2: "Work" };
    render(
      <MailAgentDraftList drafts={[d, other]} accountLabel={(x) => labels[x.account_id]} onOpen={onOpen} />,
    );
    expect(screen.getByText("bob@friends.example")).toBeTruthy();
    expect(screen.getByText("eve@work.example")).toBeTruthy();
    expect(screen.getByText("Me")).toBeTruthy();
    expect(screen.getByText("Work")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Send/ })).toBeNull();
    fireEvent.click(screen.getByText("Offer").closest(".mail-row")!);
    expect(onOpen).toHaveBeenCalledWith(d);
  });

  it("an empty list says so; a draft without recipients says that, not blank", () => {
    render(<MailAgentDraftList drafts={[]} accountLabel={() => undefined} onOpen={vi.fn()} />);
    expect(screen.getByText("No agent drafts.")).toBeTruthy();
    cleanup();
    render(<MailAgentDraftList drafts={[draft({ body_text: "<b>Dear</b>" })]} accountLabel={() => undefined} onOpen={vi.fn()} />);
    expect(screen.getByText("(no recipient)")).toBeTruthy();
    expect(screen.getByText("<b>Dear</b>")).toBeTruthy();
  });
});
