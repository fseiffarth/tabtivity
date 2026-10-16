/**
 * Renaming an agent tab from the phone. The card's ⋯ → Rename opens a sheet that PUTs the
 * new label against the tab's opaque id — the desktop owns the tab layout, so
 * nothing here is written by the sidecar — and the screen reloads afterwards so
 * the row shows the label the desktop actually stored.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Project } from "../../../mobile-web/src/screens/Project";

const tabs = [
  { id: "t-agent", label: "Claude", kind: "agent", available: true, viewer_busy: false },
  { id: "t-shell", label: "Shell", kind: "shell", available: true, viewer_busy: false },
];
let label = "Claude";

/** Rename lives in the card's ⋯ sheet. */
async function openRename(name: string) {
  fireEvent.click(await screen.findByRole("button", { name: `More for ${name}` }));
  fireEvent.click(within(screen.getByRole("dialog", { name })).getByRole("button", { name: "Rename" }));
}

describe("Mobile project — rename an agent tab", () => {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/v1/tabs/t-agent" && init?.method === "PUT") {
      label = JSON.parse(String(init.body)).label;
      return new Response(JSON.stringify({ tab: { ...tabs[0], label } }), { status: 200 });
    }
    if (url.endsWith("/prompts") || url.endsWith("/schedules")) {
      return new Response(JSON.stringify({ prompts: [], schedules: [], time_zone: "", next_runs: {} }), { status: 200 });
    }
    return new Response(JSON.stringify({
      project: { id: "p1", label: "Alpha", status: "active" },
      desktop_available: true,
      agents: [],
      tabs: [{ ...tabs[0], label }, tabs[1]],
    }), { status: 200 });
  });

  beforeEach(() => {
    label = "Claude";
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    fetchMock.mockClear();
  });

  it("renames through the opaque tab id and shows the stored label", async () => {
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    await openRename("Claude");

    const field = await screen.findByLabelText("Tab name") as HTMLInputElement;
    expect(field.value).toBe("Claude");
    fireEvent.change(field, { target: { value: "  Release review  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // The label is trimmed on the way out; the raw project id and tmux name
    // never appear in the request at all.
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) =>
      String(input) === "/api/v1/tabs/t-agent"
      && init?.method === "PUT"
      && JSON.parse(String(init?.body)).label === "Release review")).toBe(true));
    expect(await screen.findByText("Release review")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renames from the ⋯ sheet, opens from the rest of the card, and shows no agent line under it", async () => {
    tabs[0] = { ...tabs[0], agent_label: "Codex" } as typeof tabs[0];
    const terminal = vi.fn();
    try {
      render(<Project id="p1" back={() => {}} terminal={terminal} />);
      await screen.findByRole("button", { name: "More for Claude" });
      expect(screen.queryByText(/✎/u)).toBeNull();
      // The CLI's name and the tab's state used to sit under the name; the card
      // now carries the name and its model, and nothing else on that row.
      expect(screen.queryByText(/Codex/u)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Open Claude" }));
      expect(terminal).toHaveBeenCalledWith(expect.objectContaining({ id: "t-agent" }));
      await openRename("Claude");
      await screen.findByLabelText("Tab name");
      expect(terminal).toHaveBeenCalledTimes(1);
    } finally {
      delete (tabs[0] as { agent_label?: string }).agent_label;
    }
  });

  it("offers no rename on a shell tab and refuses an empty name", async () => {
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "More for Shell" }));
    const shellSheet = screen.getByRole("dialog", { name: "Shell" });
    expect(within(shellSheet).queryByRole("button", { name: "Rename" })).toBeNull();
    fireEvent.click(within(shellSheet).getByRole("button", { name: "Close" }));

    await openRename("Claude");
    const field = await screen.findByLabelText("Tab name");
    fireEvent.change(field, { target: { value: "   " } });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  });
});
