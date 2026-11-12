import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { OverlayApprovals } from "../../components/layout/OverlayApprovals";
import { useRootReviewStore, type RootProposal } from "../../stores/rootReview";
import { useMailStore } from "../../stores/mail";

const applyAll = vi.fn();
function proposal(id: string, tool: string): RootProposal {
  return {
    id, tab: "root:a", tool, args: {}, created: "0",
    rows: [{ kind: "task", op: "upsert", pre: null, post: { id, title: `row ${id}` }, local: false }],
    calendars: [], tainted: false, status: "pending", undo: false, digest: `d-${id}`, closed: false,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  useRootReviewStore.setState({
    proposals: [proposal("t", "todo_add"), proposal("c", "calendar_add_event")],
    imports: [{ id: "ics", tab: "root:a", name: "Trip", created: "0", text: "BEGIN:VCALENDAR" }],
    count: 2, busy: false, error: null, applyAll, refresh: vi.fn(async () => {}),
  });
  useMailStore.setState({ agentDrafts: [], loadAgentDrafts: vi.fn(async () => {}) });
});
afterEach(cleanup);
describe("overlay ✓ Approvals", () => {
  it("counts and shows only its own overlay's proposals", () => {
    render(<OverlayApprovals domain="todo" />);
    const button = screen.getByRole("button", { name: /Approvals 1/ });
    fireEvent.click(button);
    expect(screen.getByText("todo_add")).toBeTruthy();
    expect(screen.queryByText("calendar_add_event")).toBeNull();
    expect(screen.queryByText("Trip")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "✓ Approve all (1)" }));
    expect(applyAll).toHaveBeenCalledWith([expect.objectContaining({ id: "t" })]);
  });
  it("puts staged .ics files under the calendar", () => {
    render(<OverlayApprovals domain="calendar" />);
    fireEvent.click(screen.getByRole("button", { name: /Approvals 2/ }));
    expect(screen.getByText("calendar_add_event")).toBeTruthy();
    expect(screen.getAllByText("Trip").length).toBeGreaterThan(0);
    expect(screen.queryByText("todo_add")).toBeNull();
  });
  it("with no domain it is the root console's pill: the whole queue, and the advisory when asked", () => {
    render(<OverlayApprovals advisory />);
    // Two proposals and one staged file, as the console's own count always was.
    fireEvent.click(screen.getByRole("button", { name: /Approvals 3/ }));
    expect(screen.getByText("todo_add")).toBeTruthy();
    expect(screen.getByText("calendar_add_event")).toBeTruthy();
    expect(screen.getByRole("note")).toBeTruthy();
  });
  it("shows no advisory note unless asked", () => {
    render(<OverlayApprovals />);
    fireEvent.click(screen.getByRole("button", { name: /Approvals 3/ }));
    expect(screen.queryByRole("note")).toBeNull();
  });
});
