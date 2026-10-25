/**
 * The phone's project screen for a remote, container or VM project: it reads
 * the host's `host`, `folder` and `create` fields instead of knowing project
 * types. ＋ offers what `create` allows (agents alone, or nothing), a project
 * with no folder loses its files, Git and send-a-file entries and says why in
 * one line, a remote project says what the phone reaches, and a refused create
 * shows the host's `not_attachable` message. An older desktop sends none of
 * the fields and the screen is as it was.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Project } from "../../../mobile-web/src/screens/Project";

function detail(extra: Record<string, unknown>, project: Record<string, unknown> = {}) {
  return {
    project: { id: "p1", label: "Alpha", status: "active", live_sessions: 0, ...project },
    desktop_available: true,
    tabs: [{ id: "t-agent", label: "Claude", kind: "agent", available: true, viewer_busy: false }],
    agents: [{ id: "agent-claude", label: "Claude Code", modes: [], default: true }],
    shells: true,
    ...extra,
  };
}

function host(body: Record<string, unknown>, create?: () => Response) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST" && url.endsWith("/tabs") && create) return create();
    if (url.endsWith("/outbox")) return new Response(JSON.stringify({ files: [] }), { status: 200 });
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Mobile project screen — project types", () => {
  it("a remote project with a mirror: ＋ starts agents only, the phone's reach is named, files stay", async () => {
    vi.stubGlobal("fetch", host(detail({ folder: true, create: "agents", files: true }, { host: "remote" })));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    await screen.findByText("Claude");
    expect(screen.getByText(/Remote project: the phone reaches its agents that run on this computer/)).toBeTruthy();
    expect(screen.queryByText(/no local copy/i)).toBeNull();
    fireEvent.contextMenu(screen.getByRole("button", { name: "New tab" }));
    const sheet = await screen.findByRole("dialog", { name: "New tab" });
    expect(within(sheet).getByRole("button", { name: "Claude Code" })).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: "New shell" })).toBeNull();
    expect(within(sheet).getByText(/Only agents can be started from the phone here/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Project menu" })).toBeTruthy();
  });

  it("a folder-less remote project: no ＋, no menu, one line on the missing local copy", async () => {
    vi.stubGlobal("fetch", host(detail({ folder: false, create: "none", files: false, tabs: [] }, { host: "remote" })));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    await screen.findByText("No tabs yet");
    expect(screen.getByText(/There is no local copy of its files yet/)).toBeTruthy();
    expect(screen.getByText(/The phone cannot start tabs in this project yet\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New tab" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send a file from this phone" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Project menu" })).toBeNull();
  });

  it("a folder-less VM project says its files stay in the VM and hides Git", async () => {
    vi.stubGlobal("fetch", host(detail({ folder: false, create: "none", files: false }, { host: "vm" })));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    await screen.findByText("Claude");
    expect(screen.getByText(/VM project: tabs running in the VM are not on the phone yet/)).toBeTruthy();
    expect(screen.getByText(/Its files stay in the VM/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New tab" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Project menu" })).toBeNull();
  });

  it("a container project with a folder: no tabs to start, but a file can still be sent", async () => {
    vi.stubGlobal("fetch", host(detail({ folder: true, create: "none", files: true }, { host: "container" })));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    await screen.findByText("Claude");
    expect(screen.getByText(/Container project: tabs running inside the container are not on the phone yet/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New tab" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send a file from this phone" }));
    const sheet = await screen.findByRole("dialog", { name: "Send a file from this phone" });
    expect(within(sheet).queryByRole("button", { name: "New shell" })).toBeNull();
    expect(within(sheet).queryByRole("button", { name: "Claude Code" })).toBeNull();
    expect(screen.getByRole("button", { name: "Project menu" })).toBeTruthy();
  });

  it("shows the host's message when a create is refused as not attachable", async () => {
    const refusal = () => new Response(JSON.stringify({ error: "not_attachable" }), { status: 409 });
    vi.stubGlobal("fetch", host(detail({ folder: true, create: "agents" }, { host: "remote" }), refusal));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    await screen.findByText("Claude");
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    await waitFor(() => expect(screen.getByText(/The phone cannot start that here/)).toBeTruthy());
  });

  it("is unchanged for a local project and for an older desktop that sends none of the fields", async () => {
    for (const body of [detail({ files: true }), detail({ folder: true, create: "all", files: true }, { host: "local" })]) {
      vi.stubGlobal("fetch", host(body));
      render(<Project id="p1" back={() => {}} terminal={() => {}} />);
      await screen.findByText("Claude");
      expect(screen.queryByText(/Remote project|Container project|VM project|no local copy/)).toBeNull();
      expect(screen.getByRole("button", { name: "Project menu" })).toBeTruthy();
      fireEvent.contextMenu(screen.getByRole("button", { name: "New tab" }));
      const sheet = await screen.findByRole("dialog", { name: "New tab" });
      expect(within(sheet).getByRole("button", { name: "New shell" })).toBeTruthy();
      expect(within(sheet).queryByText(/Only agents can be started/)).toBeNull();
      cleanup();
      vi.unstubAllGlobals();
    }
  });
});
