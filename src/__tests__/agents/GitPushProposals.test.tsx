import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { GitPushProposal } from "../../types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => undefined) }));

const { GitPushProposalCard, GitPushProposals } = await import("../../components/agents/GitPushMcp");

const row: GitPushProposal = {
  id: "push-a", session: "s", tab: "p:t", project: "p", kind: "push", tag: null, repo: null, branch: "develop", remote: "origin",
  url: "https://github.com/o/r.git", head: "abcdef0123456789", remote_sha: "0123456789abcdef",
  commits: ["abc1234 Fix the thing", "def5678 chore: bump version to v0.1.2"], diffstat: "2 files changed",
  note: "the fix for #12", needs_url_confirm: true, created_at: "2026-09-25T12:00:00+02:00", status: "pending",
  category: null, message: "", output: "", preflight_output: "pre-push: bumped version to v0.1.2", cleared: false,
  state: { branch: "develop", head: "abcdef0123456789", remote: "origin", upstream: "origin/develop", url: null, remote_sha: null, ahead: 2, behind: 0 },
};
beforeEach(() => { invoke.mockReset(); });

it("shows the final commit list, the note and a first-URL confirmation, and pushes through the decide command", async () => {
  invoke.mockResolvedValueOnce({ ...row, status: "pushed", needs_url_confirm: false, message: "Pushed develop to origin (0123456 → abcdef0)." });
  const onDecided = vi.fn();
  render(<GitPushProposalCard proposal={row} onDecided={onDecided} />);
  expect(screen.getByText("Agent push · waiting for you")).toBeTruthy();
  expect(screen.getByText("abc1234 Fix the thing")).toBeTruthy();
  expect(screen.getByText("def5678 chore: bump version to v0.1.2")).toBeTruthy();
  expect(screen.getByText("Agent's note: the fix for #12")).toBeTruthy();
  expect(screen.getByText("0123456 → abcdef0")).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirm URL and push" })); });
  expect(invoke).toHaveBeenCalledWith("git_push_mcp_decide", { id: "push-a", approve: true });
  expect(onDecided).toHaveBeenCalledWith(expect.objectContaining({ status: "pushed" }));
});

it("dismisses with the same command and surfaces a backend refusal", async () => {
  invoke.mockRejectedValueOnce(new Error("this proposal is no longer pending"));
  render(<GitPushProposalCard proposal={{ ...row, needs_url_confirm: false }} />);
  expect(screen.getByRole("button", { name: "Push" })).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Dismiss" })); });
  expect(invoke).toHaveBeenCalledWith("git_push_mcp_decide", { id: "push-a", approve: false });
  expect(screen.getByRole("alert").textContent).toContain("no longer pending");
});

it("lists a project's proposals from the backend and hides dismissed ones", async () => {
  invoke.mockResolvedValueOnce([row, { ...row, id: "push-b", status: "dismissed" }, { ...row, id: "push-c", status: "failed", category: "preflight_failed", message: "The pre-push hook exited with status 1; nothing was pushed.", output: "privacy-check: match in foo.txt" }]);
  await act(async () => { render(<GitPushProposals projectId="p" />); });
  expect(invoke).toHaveBeenCalledWith("git_push_mcp_proposals", { projectId: "p" });
  expect(screen.getAllByText(/^Agent push ·/)).toHaveLength(2);
  expect(screen.getByText("The pre-push hook exited with status 1; nothing was pushed.")).toBeTruthy();
  // Both cards offer their output: the pending one its preflight, the failed one the hook's.
  const buttons = screen.getAllByRole("button", { name: "Show output" });
  expect(buttons).toHaveLength(2);
  fireEvent.click(buttons[1]);
  expect(screen.getByText("privacy-check: match in foo.txt")).toBeTruthy();
});

it("closes a finished card through the clear command and hides cleared rows", async () => {
  const failed: GitPushProposal = { ...row, status: "failed", category: "diverged", message: "The remote moved in the meantime." };
  invoke.mockResolvedValueOnce([failed, { ...row, id: "push-d", status: "pushed", cleared: true }]);
  await act(async () => { render(<GitPushProposals projectId="p" />); });
  expect(screen.getAllByText(/^Agent push ·/)).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Push" })).toBeNull();
  invoke.mockResolvedValueOnce({ ...failed, cleared: true });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Dismiss" })); });
  expect(invoke).toHaveBeenCalledWith("git_push_mcp_clear", { id: "push-a" });
  expect(screen.queryByText(/^Agent push ·/)).toBeNull();
});

it("renders a release request with its tag and releases through the same decide command", async () => {
  const release: GitPushProposal = { ...row, id: "push-r", kind: "release", tag: "v0.1.86", remote_sha: row.head, commits: ["abcdef0 chore: bump version to v0.1.86"], needs_url_confirm: false, note: "" };
  invoke.mockResolvedValueOnce({ ...release, status: "pushed", message: "Tagged v0.1.86 at abcdef0 and pushed it to origin." });
  render(<GitPushProposalCard proposal={release} />);
  expect(screen.getByText("Agent release · waiting for you")).toBeTruthy();
  expect(screen.getByText("v0.1.86")).toBeTruthy();
  expect(screen.getByText("on develop")).toBeTruthy();
  expect(screen.getByText("abcdef0 chore: bump version to v0.1.86")).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Release" })); });
  expect(invoke).toHaveBeenCalledWith("git_push_mcp_decide", { id: "push-r", approve: true });
});

it("renders an Allow CI card and allows through the same decide command", async () => {
  const ci: GitPushProposal = { ...row, id: "ci-a", kind: "ci_repo", repo: "octo-org/some-repo", url: "https://github.com/Octo-Org/Some-Repo.git", branch: null, remote: null, head: null, remote_sha: null, commits: [], diffstat: "", note: "", needs_url_confirm: false, preflight_output: "" };
  invoke.mockResolvedValueOnce({ ...ci, status: "allowed", message: "The user allowed CI reads for octo-org/some-repo; ask again." });
  const onDecided = vi.fn();
  render(<GitPushProposalCard proposal={ci} onDecided={onDecided} />);
  expect(screen.getByText("Agent CI read · waiting for you")).toBeTruthy();
  expect(screen.getByText("Allow CI for octo-org/some-repo")).toBeTruthy();
  expect(screen.getByText("https://github.com/Octo-Org/Some-Repo.git")).toBeTruthy();
  expect(screen.getByText(/not the repository confirmed for this project's pushes/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Push" })).toBeNull();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Allow" })); });
  expect(invoke).toHaveBeenCalledWith("git_push_mcp_decide", { id: "ci-a", approve: true });
  expect(onDecided).toHaveBeenCalledWith(expect.objectContaining({ status: "allowed" }));
});

it("shows an allowed CI card's outcome and dismisses a waiting one", async () => {
  const ci: GitPushProposal = { ...row, id: "ci-b", kind: "ci_repo", repo: "o/r", branch: null, remote: null, head: null, remote_sha: null, commits: [], diffstat: "", note: "", needs_url_confirm: false, preflight_output: "" };
  const { unmount } = render(<GitPushProposalCard proposal={{ ...ci, status: "allowed", message: "The user allowed CI reads for o/r; ask again." }} />);
  expect(screen.getByText("Agent CI read · allowed")).toBeTruthy();
  expect(screen.getByText("The user allowed CI reads for o/r; ask again.")).toBeTruthy();
  unmount();
  invoke.mockResolvedValueOnce({ ...ci, status: "dismissed" });
  render(<GitPushProposalCard proposal={ci} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Dismiss" })); });
  expect(invoke).toHaveBeenCalledWith("git_push_mcp_decide", { id: "ci-b", approve: false });
});
