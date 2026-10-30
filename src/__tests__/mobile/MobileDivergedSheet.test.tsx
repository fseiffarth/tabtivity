/**
 * The phone's Diverged list (`DivergedSheet`, ± in the project drawer): rows by
 * kind, a compare on tap, and the rule that matters: nothing moves without the
 * second tap on a question that says what is lost. A preview that fails asks
 * all the same; a list the desktop has not opened up stays read-only.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DivergedList, DivergedRow, SyncOutcome, SyncPreview } from "../../../mobile-web/src/api";
import { DivergedSheet } from "../../../mobile-web/src/screens/DivergedSheet";

const row = (id: string, path: string, over: Partial<DivergedRow> = {}): DivergedRow => ({
  id, path, state: "amber", host_mtime: 200, local_mtime: 100, host_diverged: true, local_diverged: false, host_checked: true, ...over,
});

const list = (rows: DivergedRow[], over: Partial<DivergedList> = {}): DivergedList => ({
  rows, total: rows.length, hidden: 0, connected: true, writes: true, ...over,
});

const PREVIEW: SyncPreview = { files: 1, bytes: 2048, overwrites: 1, destructive: ["src/a.py"], destructive_total: 3, conflicts: 0, tracked: 0, exact: true };

type Posted = { url: string; body: Record<string, unknown> };

function desktop({ listing, preview = PREVIEW, outcome = { done: 1, failed: 0, skipped: 0 }, diff = "", status = 200 }: { listing: DivergedList | (() => DivergedList); preview?: SyncPreview | null; outcome?: SyncOutcome | "gone"; diff?: string; status?: number }) {
  const posted: Posted[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      posted.push({ url, body: JSON.parse(String(init.body)) });
      if (url.endsWith("/preview")) {
        return preview ? new Response(JSON.stringify({ preview }), { status: 200 }) : new Response(JSON.stringify({ error: "sync_failed" }), { status: 409 });
      }
      if (outcome === "gone") return new Response(JSON.stringify({ error: "desktop_unavailable" }), { status: 503 });
      return new Response(JSON.stringify(outcome), { status: 200 });
    }
    if (url.includes("/diff?")) return new Response(JSON.stringify({ diff, cut: false }), { status: 200 });
    if (status !== 200) return new Response(JSON.stringify({ error: "desktop_unavailable" }), { status });
    return new Response(JSON.stringify(typeof listing === "function" ? listing() : listing), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return posted;
}

const open = async (onChanged = () => {}) => {
  render(<DivergedSheet projectId="p1" label="Aurora" onClose={() => {}} onChanged={onChanged} />);
  return screen.findByRole("dialog", { name: "Diverged · Aurora" });
};

const resolves = (posted: Posted[]) => posted.filter((post) => post.url.endsWith("/resolve"));

describe("Mobile project — Diverged list", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lists diverged and new files apart, with which side moved", async () => {
    desktop({ listing: list([row("t1", "src/a.py"), row("t2", "new.txt", { state: "localnew", host_mtime: undefined, local_diverged: true, host_diverged: false })]) });
    const sheet = await open();
    await within(sheet).findByText("src/a.py");
    expect(within(sheet).getByText("1 diverged")).toBeTruthy();
    expect(within(sheet).getByText("new.txt")).toBeTruthy();
    expect(within(sheet).getByText("1 new local (not on the host)")).toBeTruthy();
    expect(within(sheet).getByText("Remote newer")).toBeTruthy();
  });

  it("says when there is nothing, and what stays on the desktop", async () => {
    desktop({ listing: list([], { hidden: 2 }) });
    const sheet = await open();
    await within(sheet).findByText(/2 hidden file/);
    cleanup();
    desktop({ listing: list([]) });
    const empty = await open();
    await within(empty).findByText("No diverged files");
  });

  it("offers no action without the switch, but still compares", async () => {
    desktop({ listing: list([row("t1", "src/a.py")], { writes: false }), diff: "--- a/local/a\n+++ b/host/a\n@@ -1 +1 @@\n-old\n+new\n" });
    const sheet = await open();
    await within(sheet).findByText(/Phone may resolve diverged files/);
    expect(within(sheet).queryByRole("button", { name: "Take the remote copy" })).toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: "Compare src/a.py" }));
    await within(sheet).findByText("+new");
  });

  it("disables the actions while the desktop is off the host, and says why", async () => {
    desktop({ listing: list([row("t1", "src/a.py")], { connected: false }) });
    const sheet = await open();
    await within(sheet).findByText(/not connected to this host/);
    expect((within(sheet).getByRole("button", { name: "Take the remote copy" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("moves nothing until the second tap, and names what is lost", async () => {
    const onChanged = vi.fn();
    const posted = desktop({ listing: list([row("t1", "src/a.py")]) });
    const sheet = await open(onChanged);
    fireEvent.click(await within(sheet).findByRole("button", { name: "Take the remote copy" }));
    const ask = await screen.findByRole("dialog", { name: "Sync to local?" });
    expect(within(ask).getByText(/1 file\(s\), 2.0 KB|1 file\(s\), 2 KB/)).toBeTruthy();
    expect(within(ask).getByText(/hold changes that are nowhere else/)).toBeTruthy();
    expect(within(ask).getByText("src/a.py")).toBeTruthy();
    expect(within(ask).getByText("…and 2 more.")).toBeTruthy();
    expect(resolves(posted)).toEqual([]);

    fireEvent.click(within(ask).getByRole("button", { name: "Overwrite local" }));
    await waitFor(() => expect(resolves(posted)).toHaveLength(1));
    expect(resolves(posted)[0].body).toEqual({ op: "pull", files: ["t1"] });
    await screen.findByText("1 file(s) done.");
    expect(onChanged).toHaveBeenCalled();
  });

  it("backing out of the question moves nothing", async () => {
    const posted = desktop({ listing: list([row("t1", "src/a.py")]) });
    const sheet = await open();
    fireEvent.click(await within(sheet).findByRole("button", { name: "Keep the local copy" }));
    const ask = await screen.findByRole("dialog", { name: "Push to host?" });
    fireEvent.click(within(ask).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Push to host?" })).toBeNull());
    expect(resolves(posted)).toEqual([]);
  });

  it("still asks when the preview fails, and says it could not check", async () => {
    const posted = desktop({ listing: list([row("t1", "src/a.py")]), preview: null });
    const sheet = await open();
    fireEvent.click(await within(sheet).findByRole("button", { name: "Keep the local copy" }));
    const ask = await screen.findByRole("dialog", { name: "Push to host?" });
    expect(within(ask).getByText(/Couldn't check what this would transfer/)).toBeTruthy();
    expect(resolves(posted)).toEqual([]);
  });

  it("uploads a new file without the force warning", async () => {
    const posted = desktop({ listing: list([row("t2", "new.txt", { state: "localnew", host_mtime: undefined })]) });
    const sheet = await open();
    fireEvent.click(await within(sheet).findByRole("button", { name: "Upload new file" }));
    const ask = await screen.findByRole("dialog", { name: "Push to host?" });
    expect(within(ask).queryByText(/overwrites the other side/)).toBeNull();
    fireEvent.click(within(ask).getByRole("button", { name: "Copy to host" }));
    await waitFor(() => expect(resolves(posted)[0]?.body).toEqual({ op: "push", files: ["t2"] }));
  });

  it("leaves a true conflict out of a bulk action unless asked", async () => {
    const posted = desktop({ listing: list([row("t1", "one.txt"), row("t2", "both.txt", { local_diverged: true })]) });
    const sheet = await open();
    fireEvent.click((await within(sheet).findAllByRole("button", { name: /remote copy/ }))[0]);
    const ask = await screen.findByRole("dialog", { name: "Sync to local?" });
    fireEvent.click(within(ask).getByRole("button", { name: "Overwrite local" }));
    await waitFor(() => expect(resolves(posted)).toHaveLength(1));
    expect(resolves(posted)[0].body).toEqual({ op: "pull", files: ["t1"] });
  });

  it("takes the newer copies with one question over both directions", async () => {
    const posted = desktop({ listing: list([
      row("t1", "host.txt"),
      row("t2", "local.txt", { host_diverged: false, local_diverged: true }),
    ]) });
    const sheet = await open();
    fireEvent.click(await within(sheet).findByRole("button", { name: "Take the newer copy for all" }));
    const ask = await screen.findByRole("dialog", { name: "Take the newer copies?" });
    fireEvent.click(within(ask).getByRole("button", { name: "Take newer" }));
    await waitFor(() => expect(resolves(posted)).toHaveLength(2));
    expect(resolves(posted).map((post) => post.body)).toEqual([{ op: "pull", files: ["t1"] }, { op: "push", files: ["t2"] }]);
  });

  it("completes a one-sided deletion after naming the file, and offers it on no other", async () => {
    const posted = desktop({ listing: list([row("t1", "gone-here.txt", { local_mtime: undefined }), row("t2", "both.txt")]) });
    const sheet = await open();
    fireEvent.click(await within(sheet).findByRole("button", { name: "Delete the remote copy too" }));
    const ask = await screen.findByRole("dialog", { name: "Delete on the host too?" });
    expect(within(ask).getByText(/"gone-here.txt" was deleted from the local mirror/)).toBeTruthy();
    fireEvent.click(within(ask).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(resolves(posted)[0]?.body).toEqual({ op: "delete_host", files: ["t1"] }));
    expect(within(sheet).getAllByRole("button", { name: /Delete the/ })).toHaveLength(1);
  });

  it("forgets a file gone from both sides without a transfer to confirm", async () => {
    const posted = desktop({ listing: list([row("t1", "gone.txt", { host_mtime: undefined, local_mtime: undefined })]) });
    const sheet = await open();
    fireEvent.click(await within(sheet).findByRole("button", { name: "Forget" }));
    await waitFor(() => expect(resolves(posted)[0]?.body).toEqual({ op: "forget", files: ["t1"] }));
  });

  it("reports what could not be done, and what had changed since", async () => {
    desktop({ listing: list([row("t1", "a.txt")]), outcome: { done: 0, failed: 1, skipped: 2 } });
    const sheet = await open();
    fireEvent.click(await within(sheet).findByRole("button", { name: "Take the remote copy" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Sync to local?" })).getByRole("button", { name: "Overwrite local" }));
    await screen.findByText(/1 file\(s\) could not be moved.*2 file\(s\) changed in the meantime/);
  });

  it("does not call a transfer failed when the desktop only ran out of time", async () => {
    desktop({ listing: list([row("t1", "a.txt")]), outcome: "gone" });
    const sheet = await open();
    fireEvent.click(await within(sheet).findByRole("button", { name: "Take the remote copy" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Sync to local?" })).getByRole("button", { name: "Overwrite local" }));
    await screen.findByText(/may still finish there/);
  });

  it("re-reads the list after acting", async () => {
    let reads = 0;
    desktop({ listing: () => { reads += 1; return reads === 1 ? list([row("t1", "a.txt")]) : list([]); } });
    const sheet = await open();
    fireEvent.click(await within(sheet).findByRole("button", { name: "Take the remote copy" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Sync to local?" })).getByRole("button", { name: "Overwrite local" }));
    await within(sheet).findByText("No diverged files");
  });
});
