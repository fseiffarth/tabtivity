/**
 * Mark up with no agent tab to send to (the project screen, a shell tab):
 * Submit opens a new tab of the desktop's default agent, sends the marks
 * through it and hands it the prompt as a held prompt. The view stays open,
 * its pill following the new tab, and Open tab shows it — and a retry after a
 * later step failed reuses that tab instead of opening another.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EMPTY_LAYER, addMark, hasSent, type Layer } from "../../../mobile-web/src/markup/layer";

const store = vi.hoisted(() => ({
  loadLayer: vi.fn(),
  saveLayer: vi.fn(async (..._args: unknown[]) => true),
}));
vi.mock("../../../mobile-web/src/markup/store", async (original) => ({
  ...(await original<typeof import("../../../mobile-web/src/markup/store")>()),
  ...store,
}));
vi.mock("../../../mobile-web/src/markup/rasterize", async (original) => ({
  ...(await original<typeof import("../../../mobile-web/src/markup/rasterize")>()),
  layerPng: vi.fn(async () => new Blob(["layer"], { type: "image/png" })),
  composedPng: vi.fn(async () => new Blob(["composed"], { type: "image/png" })),
}));

import { MarkupView } from "../../../mobile-web/src/components/MarkupView";
import { OutboxViewer } from "../../../mobile-web/src/components/OutboxViewer";
import { markupAgent } from "../../../mobile-web/src/markup/newTab";
import type { AgentRow } from "../../../mobile-web/src/api";

const PICTURE = { name: "20261001-120000-plot.png", original: "plot.png", kind: "image/png", size: 4_000, modified: 1_790_000_000 };
const LAYER = addMark(EMPTY_LAYER, 1, [800, 600], { kind: "ink", color: "red", width: 2, points: [[10, 10, 0.5], [40, 30, 0.5]] });
const AGENTS: AgentRow[] = [
  { id: "agent-codex", label: "Codex", modes: [] },
  { id: "agent-claude", label: "Claude Code", modes: [], default: true },
];
const NEW_TAB = { id: "tab-new", label: "Claude Code", kind: "agent", available: true, viewer_busy: false };

type Call = { url: string; method: string; body?: BodyInit | null };

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** The sidecar: project detail, tab create, inbox, `/markup`, `/held`. */
function desktop({ heldFails = 0, status }: { heldFails?: number; status?: string } = {}) {
  const calls: Call[] = [];
  let holdFailures = heldFails;
  let opened = false;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    if (url === "/api/v1/projects/p1" && method === "GET") {
      return jsonResponse(200, { agents: AGENTS, tabs: opened ? [{ ...NEW_TAB, ...(status ? { agent_status: status } : {}) }] : [] });
    }
    if (url === "/api/v1/projects/p1/tabs" && method === "POST") {
      opened = true;
      return jsonResponse(201, { tab: NEW_TAB });
    }
    if (url.includes("/inbox?name=")) {
      const name = decodeURIComponent(url.split("name=")[1]);
      return jsonResponse(201, { attachment: { name, reference: `inbox/${name}`, size: 6 } });
    }
    if (url.endsWith("/markup")) return jsonResponse(200, { prompt: "Look at the marks", marked: null });
    if (url.endsWith("/held")) {
      if (holdFailures > 0) {
        holdFailures -= 1;
        return jsonResponse(503, { error: "desktop_unavailable" });
      }
      return jsonResponse(201, { id: "held-1" });
    }
    return jsonResponse(200, {});
  }));
  return calls;
}

function showPicture() {
  const image = screen.getByAltText("plot.png") as HTMLImageElement;
  Object.defineProperty(image, "naturalWidth", { value: 800 });
  Object.defineProperty(image, "naturalHeight", { value: 600 });
  fireEvent.load(image);
}

const submitButton = () => screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;

beforeEach(() => {
  localStorage.clear();
  store.loadLayer.mockReset();
  store.loadLayer.mockResolvedValue({ layer: LAYER, fingerprint: { size: PICTURE.size, modified: PICTURE.modified }, saved: 1 });
  store.saveLayer.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("markupAgent", () => {
  it("takes the desktop's default agent, else the first it offers", () => {
    expect(markupAgent(AGENTS)?.id).toBe("agent-claude");
    expect(markupAgent(AGENTS.map(({ id, label, modes }) => ({ id, label, modes })))?.id).toBe("agent-codex");
    expect(markupAgent([])).toBeUndefined();
  });
});

describe("OutboxViewer · Mark up with no agent tab", () => {
  it("offers Mark up on a picture once a new tab can be opened, and not before", () => {
    const { rerender } = render(<OutboxViewer scope={{ project: "p1" }} file={PICTURE} onClose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /^Mark up/ })).toBeNull();
    rerender(<OutboxViewer scope={{ project: "p1" }} file={PICTURE} onClose={vi.fn()} newTab={{ projectId: "p1", show: vi.fn() }} />);
    expect(screen.getByRole("button", { name: /^Mark up/ })).toBeTruthy();
  });
});

describe("MarkupView · Submit with no agent tab", () => {
  it("opens a tab of the default agent, sends the marks through it, holds the prompt there and stays open", async () => {
    const calls = desktop();
    const show = vi.fn();
    const onClose = vi.fn();
    render(<MarkupView projectId="p1" scope={{ project: "p1" }} file={PICTURE} newTab={{ projectId: "p1", show }} onClose={onClose} />);
    showPicture();
    expect(screen.getByText(/Submit opens a new tab of your default agent/)).toBeTruthy();
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    await screen.findByText("Sent to a new Claude Code tab.");
    expect(screen.getByText("Sent — waiting for the agent")).toBeTruthy();
    expect(screen.queryByText(/Submit opens a new tab of your default agent/)).toBeNull();
    expect(show).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    const create = calls.find((call) => call.url === "/api/v1/projects/p1/tabs")!;
    expect(JSON.parse(String(create.body))).toMatchObject({ project_id: "p1", kind: "agent", agent_id: "agent-claude" });
    const tabCalls = calls.filter((call) => call.url.startsWith("/api/v1/tabs/")).map((call) => call.url.split("?")[0]);
    expect(tabCalls.every((url) => url.startsWith("/api/v1/tabs/tab-new/"))).toBe(true);
    expect(tabCalls).toContain("/api/v1/tabs/tab-new/markup");
    const held = calls.find((call) => call.url === "/api/v1/tabs/tab-new/held")!;
    expect(JSON.parse(String(held.body))).toEqual({ message: "Look at the marks" });
    // The round's marks move to the sent side, as after a Submit into a chat.
    await waitFor(() => expect(hasSent(store.saveLayer.mock.calls[store.saveLayer.mock.calls.length - 1][1] as Layer)).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Open tab" }));
    expect(show).toHaveBeenCalledWith(NEW_TAB);
  });

  it("follows the opened tab's turn in the round's pill", async () => {
    desktop({ status: "working" });
    render(<MarkupView projectId="p1" scope={{ project: "p1" }} file={PICTURE} newTab={{ projectId: "p1", show: vi.fn() }} onClose={vi.fn()} />);
    showPicture();
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    await screen.findByText("Agent is working…");
  });

  it("retries a failed hand-over in the tab it already opened", async () => {
    const calls = desktop({ heldFails: 1 });
    const show = vi.fn();
    render(<MarkupView projectId="p1" scope={{ project: "p1" }} file={PICTURE} newTab={{ projectId: "p1", show }} onClose={vi.fn()} />);
    showPicture();
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    await screen.findByText(/The new agent tab is open/);
    expect(show).not.toHaveBeenCalled();

    fireEvent.click(submitButton());
    await screen.findByText("Sent to a new Claude Code tab.");
    await screen.findByText("Sent — waiting for the agent");
    expect(show).not.toHaveBeenCalled();
    expect(calls.filter((call) => call.url === "/api/v1/projects/p1/tabs")).toHaveLength(1);
    expect(calls.filter((call) => call.url === "/api/v1/tabs/tab-new/held")).toHaveLength(2);
  });
});
