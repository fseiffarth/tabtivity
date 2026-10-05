import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RootReviewStrip, stripInvisible, tabLabelForPty } from "../../components/layout/RootReviewStrip";
import { useRootReviewStore, type RootProposal } from "../../stores/rootReview";
import { useTabsStore, type TabEntry } from "../../stores/tabs";

const decide = vi.fn();
const applyAll = vi.fn();
function proposal(overrides: Partial<RootProposal> = {}): RootProposal {
  return {
    id: "p", tab: "root:a", tool: "todo_update", args: { id: "task" }, created: "0",
    rows: [{ kind: "task", op: "upsert", pre: { id: "task", title: "Before" }, post: { id: "task", title: "After" }, local: false }],
    calendars: [], tainted: false, status: "pending", undo: false, digest: "digest", closed: false, ...overrides,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  useRootReviewStore.setState({ proposals: [proposal()], count: 1, busy: false, error: null, decide, applyAll });
});
afterEach(cleanup);
describe("root-agent write review", () => {
  it("renders actual field changes and binds approval to the displayed digest", () => {
    render(<RootReviewStrip />);
    expect(screen.getAllByText("Before").length).toBe(2);
    expect(screen.getAllByText("After").length).toBe(3);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ id: "p", digest: "digest" }), "apply");
    fireEvent.click(screen.getByRole("button", { name: "✓ Approve all (1)" }));
    expect(applyAll).toHaveBeenCalledWith([expect.objectContaining({ id: "p", digest: "digest" })]);
  });
  it("disables approval for conflicts and offers discard", () => {
    useRootReviewStore.setState({ proposals: [proposal({ status: "conflicted", closed: true })], count: 0 });
    render(<RootReviewStrip />);
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("From a closed tab")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(decide).toHaveBeenCalledWith(expect.anything(), "reject");
  });
  it("folds only sibling reindex rows, keeping substantive edits visible", () => {
    const p = proposal({ tool: "todo_move" });
    p.rows.push({ kind: "task", op: "upsert", pre: { id: "sibling", title: "Hidden sibling", rank: 1 }, post: { id: "sibling", title: "Hidden sibling", rank: 2 }, local: true });
    p.rows.push({ kind: "task", op: "upsert", pre: { id: "changed", title: "Old", rank: 1 }, post: { id: "changed", title: "Visible change", rank: 2 }, local: true });
    useRootReviewStore.setState({ proposals: [p] });
    render(<RootReviewStrip />);
    expect(screen.getByText("And 1 cards reordered")).toBeTruthy();
    expect(screen.queryByText("Hidden sibling")).toBeNull();
    expect(screen.getAllByText("Visible change").length).toBeGreaterThan(0);
  });
  it("gives each MCP group its own Approve all, approving only that group's pending proposals", () => {
    const cal = proposal({ id: "c", tool: "calendar_add_event", digest: "dc" });
    const todo = proposal({ id: "t", tool: "todo_add", digest: "dt" });
    const todo2 = proposal({ id: "t2", tool: "todo_complete", digest: "dt2" });
    useRootReviewStore.setState({ proposals: [cal, todo, todo2], count: 3 });
    render(<RootReviewStrip />);
    expect(screen.getByText("Calendar (1)")).toBeTruthy();
    expect(screen.getByText("To-do board (2)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "✓ Approve all (2)" }));
    expect(applyAll).toHaveBeenCalledWith([todo, todo2]);
    fireEvent.click(screen.getByRole("button", { name: "✓ Approve all (1)" }));
    expect(applyAll).toHaveBeenLastCalledWith([cal]);
  });
  it("folds already-decided proposals shut until asked for", () => {
    useRootReviewStore.setState({ proposals: [proposal(), proposal({ id: "done", tool: "calendar_event_create", status: "applied" })], count: 1 });
    render(<RootReviewStrip />);
    const toggle = screen.getByRole("button", { name: /Already decided \(1\)/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("calendar_event_create")).toBeNull();
    expect(screen.getByText("todo_update")).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("calendar_event_create")).toBeTruthy();
  });
  it("says so when it opens on nothing, since it is now a panel and not a strip", () => {
    useRootReviewStore.setState({ proposals: [], count: 0 });
    render(<RootReviewStrip />);
    expect(screen.getByText("No agent proposals waiting.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });
  it("decides with a ✓ / ✗ that still name themselves", () => {
    render(<RootReviewStrip />);
    const approve = screen.getByRole("button", { name: "Approve" });
    expect(approve.textContent).toBe("✓");
    expect(approve.getAttribute("title")).toBe("Approve");
    const reject = screen.getByRole("button", { name: "Reject" });
    expect(reject.textContent).toBe("✗");
    fireEvent.click(reject);
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ id: "p" }), "reject");
  });
  it("offers Undo only on an applied automatic write, and says when a proposal came from a mail reader", () => {
    useRootReviewStore.setState({ proposals: [
      proposal({ id: "auto", tool: "todo_add", status: "applied", undo: true }),
      proposal({ id: "manual", tool: "todo_add", status: "applied", undo: false }),
      proposal({ id: "tainted", tainted: true }),
      proposal({ id: "failed", status: "failed", undo: true }),
    ], count: 1 });
    render(<RootReviewStrip />);
    expect(screen.getByText("Proposed by an agent that reads mail from outside")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Already decided \(3\)/ }));
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText(/could not be stored \(not a conflict\)/)).toBeTruthy();
    expect(screen.queryByText(/changed since the agent looked/)).toBeNull();
    const undo = screen.getAllByRole("button", { name: "Undo" });
    expect(undo.length).toBe(1);
    fireEvent.click(undo[0]);
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ id: "auto" }), "undo");
    expect(decide).not.toHaveBeenCalledWith(expect.objectContaining({ id: "manual" }), expect.anything());
  });
  it("labels a card with its tab's title when the window still has the tab", () => {
    useTabsStore.setState({ tabsByScope: { root: [{ key: "a", label: "Claude\u202e root", cmd: "claude", cwd: "/", kind: "agent" } as TabEntry] } });
    render(<RootReviewStrip />);
    const meta = screen.getByText(/Claude root/);
    expect(meta.getAttribute("title")).toBe("root:a");
    expect(tabLabelForPty(useTabsStore.getState(), "root:zzz")).toBeUndefined();
    expect(tabLabelForPty(useTabsStore.getState(), "bare")).toBeUndefined();
    useTabsStore.setState({ tabsByScope: {} });
  });
  it("shows outbound effects and strips invisible text without interpreting HTML", () => {
    const p = proposal({ calendars: [{ id: "work", name: "Work\u202e", caldav_account_id: "account" }] });
    p.rows[0].post.title = "<b>\u200bTitle\u202e\u{E0061}</b>";
    useRootReviewStore.setState({ proposals: [p] });
    render(<RootReviewStrip />);
    expect(screen.getAllByText("<b>Title</b>").length).toBeGreaterThan(0);
    expect(screen.getByText("Will be pushed to Work. The server may notify attendees.")).toBeTruthy();
    expect(stripInvisible("a\u034f\u2066\ufeff\u{E0001}b\n")).toBe("ab\n");
  });
});
