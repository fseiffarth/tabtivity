/**
 * Markups as cards among the project screen's tabs (`filesPlace.ts`): a file
 * marked up anywhere keeps a phone-only card that says how many marks are not
 * sent yet and which agent tab its rounds went to; reopened from the card, a
 * Submit goes to that same tab rather than opening another.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EMPTY_LAYER, addMark } from "../../../mobile-web/src/markup/layer";

const store = vi.hoisted(() => ({
  loadLayer: vi.fn(),
  saveLayer: vi.fn(async (..._args: unknown[]) => true),
  layerKeys: vi.fn(async (..._args: unknown[]) => [] as string[]),
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
import { Project } from "../../../mobile-web/src/screens/Project";
import { MARKED_TABS_CAP, findFileTab, keepMarkupTab, openFileTab, readFileTabs, type FileTab } from "../../../mobile-web/src/filesPlace";
import { keyedFile, recoverMarkupTabs } from "../../../mobile-web/src/markup/recoverCards";
import { storageKey } from "../../../src/lib/brand";
import type { TabRow } from "../../../mobile-web/src/api";

/** The round, the ticks and the agent's card wait behind the head's Agent
 * badge while marking: open its sheet (it stays open while marking). */
const openAgent = () => {
  const badge = screen.queryByRole("button", { name: /^Agent/ });
  if (badge && badge.getAttribute("aria-pressed") !== "true") fireEvent.click(badge);
};


const PICTURE = { name: "20261001-120000-plot.png", original: "plot.png", kind: "image/png", size: 4_000, modified: 1_790_000_000 };
const LAYER = addMark(addMark(EMPTY_LAYER, 1, [800, 600], { kind: "ink", color: "red", width: 2, points: [[10, 10, 0.5], [40, 30, 0.5]] }),
  1, [800, 600], { kind: "ink", color: "red", width: 2, points: [[50, 50, 0.5], [80, 70, 0.5]] });
const AGENTS = [{ id: "agent-claude", label: "Claude Code", modes: [], default: true }];
const NEW_TAB = { id: "tab-new", label: "Claude Code", kind: "agent", available: true, viewer_busy: false };
const LINKED: TabRow = { id: "tab-old", label: "Paper review", kind: "agent", available: true, viewer_busy: false, agent_status: "working" };
const OUTBOX_CARD: FileTab = { token: PICTURE.name, name: PICTURE.name, kind: PICTURE.kind, size: PICTURE.size, modified: PICTURE.modified, place: "", from: "outbox", label: "plot.png" };

type Call = { url: string; method: string; body?: BodyInit | null };

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** The sidecar: project detail (with `tabs`), outbox, tab create, inbox,
 * `/markup`, `/held`. */
function desktop(tabs: TabRow[] = []) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    if (url === "/api/v1/projects/p1/outbox") return jsonResponse(200, { files: [PICTURE] });
    if (url === "/api/v1/projects/p1" && method === "GET") {
      return jsonResponse(200, { project: { id: "p1", label: "Alpha", status: "active" }, desktop_available: true, agents: AGENTS, tabs, files: false });
    }
    if (url === "/api/v1/projects/p1/tabs" && method === "POST") return jsonResponse(201, { tab: NEW_TAB });
    if (url.includes("/inbox?name=")) {
      const name = decodeURIComponent(url.split("name=")[1]);
      return jsonResponse(201, { attachment: { name, reference: `inbox/${name}`, size: 6 } });
    }
    if (url.endsWith("/markup")) return jsonResponse(200, { prompt: "Look at the marks", marked: null });
    if (url.endsWith("/held")) return jsonResponse(201, { id: "held-1" });
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
  store.layerKeys.mockReset();
  store.layerKeys.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("filesPlace · markup cards", () => {
  it("adds a marked file's card first, then keeps it where it stands, writing only on a change", () => {
    openFileTab("p1", { token: "tok-a", name: "a.pdf", kind: "application/pdf", size: 1, modified: 1, place: "" });
    keepMarkupTab("p1", OUTBOX_CARD);
    expect(readFileTabs("p1").map((tab) => tab.name)).toEqual([PICTURE.name, "a.pdf"]);

    keepMarkupTab("p1", { token: "tok-a2", name: "a.pdf", kind: "application/pdf", size: 2, modified: 2, place: "", tab: "tab-1" });
    expect(readFileTabs("p1").map((tab) => tab.name)).toEqual([PICTURE.name, "a.pdf"]);
    expect(findFileTab("p1", { place: "", name: "a.pdf" })).toMatchObject({ token: "tok-a2", size: 2, tab: "tab-1" });
    // A later save without a tab keeps the one the card has.
    keepMarkupTab("p1", { token: "tok-a2", name: "a.pdf", kind: "application/pdf", size: 2, modified: 2, place: "" });
    expect(findFileTab("p1", { place: "", name: "a.pdf" })?.tab).toBe("tab-1");

    const setItem = vi.spyOn(Storage.prototype, "setItem");
    keepMarkupTab("p1", { token: "tok-a2", name: "a.pdf", kind: "application/pdf", size: 2, modified: 2, place: "" });
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it("tells an outbox file from a project file of the same name, and reopening from the drawer keeps the tab", () => {
    keepMarkupTab("p1", { ...OUTBOX_CARD, name: "a.pdf", token: "a.pdf", label: undefined, tab: "tab-outbox" });
    keepMarkupTab("p1", { token: "tok-a", name: "a.pdf", kind: "application/pdf", size: 1, modified: 1, place: "", tab: "tab-files" });
    expect(readFileTabs("p1")).toHaveLength(2);
    openFileTab("p1", { token: "tok-a3", name: "a.pdf", kind: "application/pdf", size: 1, modified: 1, place: "" });
    expect(findFileTab("p1", { place: "", name: "a.pdf" })).toMatchObject({ token: "tok-a3", tab: "tab-files" });
    expect(findFileTab("p1", { from: "outbox", place: "", name: "a.pdf" })?.tab).toBe("tab-outbox");
  });

  const readPdf = (n: number): FileTab => ({ token: `tok-${n}`, name: `read-${n}.pdf`, kind: "application/pdf", size: n, modified: n, place: "" });

  it("never lets PDFs only read push a markup's card out", () => {
    keepMarkupTab("p1", { token: "tok-m", name: "marked.pdf", kind: "application/pdf", size: 1, modified: 1, place: "papers" });
    for (let n = 0; n < 30; n++) openFileTab("p1", readPdf(n));
    const names = readFileTabs("p1").map((tab) => tab.name);
    expect(names).toContain("marked.pdf");
    // The PDFs only read keep their own cap of twelve, newest first.
    expect(names.filter((name) => name.startsWith("read-"))).toEqual(Array.from({ length: 12 }, (_, i) => `read-${29 - i}.pdf`));
    // Reopening the marked file from the library keeps it a markup's card.
    openFileTab("p1", { token: "tok-m2", name: "marked.pdf", kind: "application/pdf", size: 1, modified: 1, place: "papers" });
    for (let n = 30; n < 50; n++) openFileTab("p1", readPdf(n));
    expect(findFileTab("p1", { place: "papers", name: "marked.pdf" })).toMatchObject({ token: "tok-m2", marked: true });
  });

  it("counts a card stored before `marked` whose rounds went to a tab as a markup's", () => {
    const legacy = { token: "tok-l", name: "legacy.pdf", kind: "application/pdf", size: 1, modified: 1, place: "", tab: "tab-1" };
    const reads = Array.from({ length: 12 }, (_, n) => readPdf(n));
    localStorage.setItem(storageKey("mobile.fileTabs"), JSON.stringify({ p1: [...reads, legacy] }));
    openFileTab("p1", readPdf(100));
    expect(findFileTab("p1", { place: "", name: "legacy.pdf" })?.tab).toBe("tab-1");
  });

  it("caps markups' cards apart, at their own cap", () => {
    for (let n = 0; n < MARKED_TABS_CAP + 5; n++) keepMarkupTab("p1", { ...readPdf(n), name: `m-${n}.pdf` });
    expect(readFileTabs("p1")).toHaveLength(MARKED_TABS_CAP);
  });
});

describe("recoverCards · markups that lost their card", () => {
  it("reads a layer key's file, and skips Annotate's layer", () => {
    expect(keyedFile("p1", "p1:files:/a.pdf")).toEqual({ from: "files", folders: [], name: "a.pdf" });
    expect(keyedFile("p1", "p1:files:docs/sub/a.pdf")).toEqual({ from: "files", folders: ["docs", "sub"], name: "a.pdf" });
    expect(keyedFile("p1", "p1:outbox:x.pdf")).toEqual({ from: "outbox", name: "x.pdf" });
    expect(keyedFile("p1", "p1:files:/a.pdf#remarks")).toBeNull();
    expect(keyedFile("p1", "p2:files:/a.pdf")).toBeNull();
  });

  it("gives every stored markup without a card its card back, after the cards there are", async () => {
    store.layerKeys.mockResolvedValue([`p1:outbox:${PICTURE.name}`, "p1:files:docs/b.pdf", "p1:files:/c.pdf#remarks", "p1:files:/gone.pdf", "p1:files:/kept.pdf"]);
    openFileTab("p1", { token: "tok-k", name: "kept.pdf", kind: "application/pdf", size: 3, modified: 3, place: "" });
    const asked: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      asked.push(url);
      if (url === "/api/v1/projects/p1/outbox") return jsonResponse(200, { files: [PICTURE] });
      if (url === "/api/v1/projects/p1/files/entry?name=docs") return jsonResponse(200, { entry: { token: "tok-docs", name: "docs", kind: "dir", size: 0, modified: 0 } });
      if (url === "/api/v1/projects/p1/files/entry?name=b.pdf&dir=tok-docs") return jsonResponse(200, { entry: { token: "tok-b", name: "b.pdf", kind: "application/pdf", size: 7, modified: 8 } });
      return jsonResponse(404, { error: "file_not_found" });
    }));
    await recoverMarkupTabs("p1", true, new AbortController().signal);
    expect(readFileTabs("p1").map((tab) => tab.name)).toEqual(["kept.pdf", PICTURE.name, "b.pdf"]);
    expect(findFileTab("p1", { from: "outbox", place: "", name: PICTURE.name })).toMatchObject({ label: "plot.png", marked: true });
    expect(findFileTab("p1", { place: "docs", name: "b.pdf" })).toMatchObject({ token: "tok-b", folder: "tok-docs", size: 7, marked: true });
    // A card opened to read whose file has marks becomes a markup's card.
    expect(findFileTab("p1", { place: "", name: "kept.pdf" })?.marked).toBe(true);
    // A file that is gone is not asked about again this page's life.
    asked.length = 0;
    await recoverMarkupTabs("p1", true, new AbortController().signal);
    expect(asked).toEqual([]);
  });

  it("leaves project files alone while the desktop's files switch is off", async () => {
    store.layerKeys.mockResolvedValue(["p1:files:/solo.pdf"]);
    const fetch = vi.fn(async () => jsonResponse(500, {}));
    vi.stubGlobal("fetch", fetch);
    await recoverMarkupTabs("p1", false, new AbortController().signal);
    expect(fetch).not.toHaveBeenCalled();
    expect(readFileTabs("p1")).toEqual([]);
  });
});

describe("MarkupView · the file's card", () => {
  it("keeps a card for a marked file, naming the tab a Submit opened", async () => {
    desktop();
    render(<MarkupView projectId="p1" scope={{ project: "p1" }} file={PICTURE} newTab={{ projectId: "p1", show: vi.fn() }} onClose={vi.fn()} />);
    openAgent();
    showPicture();
    await waitFor(() => expect(findFileTab("p1", { from: "outbox", place: "", name: PICTURE.name })).toMatchObject({ label: "plot.png" }));
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    await screen.findByText("Sent to a new Claude Code tab.");
    expect(findFileTab("p1", { from: "outbox", place: "", name: PICTURE.name })?.tab).toBe("tab-new");
  });

  it("sends a card's next round to the tab it names, opening none", async () => {
    const calls = desktop([LINKED]);
    keepMarkupTab("p1", { ...OUTBOX_CARD, tab: LINKED.id });
    const show = vi.fn();
    render(<MarkupView projectId="p1" scope={{ project: "p1" }} file={PICTURE} onClose={vi.fn()}
      newTab={{ projectId: "p1", show, linked: (file) => findFileTab("p1", file)?.tab === LINKED.id ? LINKED : undefined }} />);
    showPicture();
    expect(screen.getByText("Marks go to the Paper review tab.")).toBeTruthy();
    expect(screen.queryByText(/Submit opens a new tab of your default agent/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open tab" }));
    expect(show).toHaveBeenCalledWith(LINKED, expect.objectContaining({ file: PICTURE }));
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    await waitFor(() => expect(calls.some((call) => call.url === "/api/v1/tabs/tab-old/held")).toBe(true));
    expect(calls.filter((call) => call.url === "/api/v1/projects/p1/tabs")).toHaveLength(0);
    expect(calls.some((call) => call.url === "/api/v1/tabs/tab-old/markup")).toBe(true);
  });
});

describe("Project screen · markup cards", () => {
  it("lists a marked outbox file among the tabs with its unsent marks and agent tab, the files switch off", async () => {
    desktop([LINKED]);
    keepMarkupTab("p1", { ...OUTBOX_CARD, tab: LINKED.id });
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const open = await screen.findByRole("button", { name: "Open plot.png" });
    const card = open.closest(".file-tab-card") as HTMLElement;
    expect(card.textContent).toContain("Files from the agent");
    await waitFor(() => expect(card.textContent).toContain("2 marks not sent"));
    await waitFor(() => expect(card.textContent).toContain("Marks go to Paper review"));
    expect(within(card).getByRole("img", { name: /working/i })).toBeTruthy();

    // A picture's card opens it straight in Mark up.
    fireEvent.click(open);
    expect(await screen.findByRole("button", { name: "Submit" })).toBeTruthy();
  });

  it("forgets a card on ✕ and leaves its marks alone", async () => {
    desktop();
    keepMarkupTab("p1", OUTBOX_CARD);
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const open = await screen.findByRole("button", { name: "Open plot.png" });
    const card = open.closest(".file-tab-card") as HTMLElement;
    await waitFor(() => expect(card.textContent).toContain("2 marks not sent"));
    fireEvent.click(within(card).getByRole("button", { name: "Forget plot.png on this phone" }));
    expect(screen.queryByRole("button", { name: "Open plot.png" })).toBeNull();
    expect(readFileTabs("p1")).toEqual([]);
    expect(store.saveLayer).not.toHaveBeenCalled();
    // The list's recount settles before the screen goes.
    await act(async () => {});
  });
});
