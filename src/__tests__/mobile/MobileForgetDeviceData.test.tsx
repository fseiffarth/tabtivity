/**
 * What a phone the host no longer knows forgets (`forgetDeviceData`): covers,
 * markup layers, drafts, held prompts and the last place — on a definite
 * `unpaired` only, never on an offline phone — and a project's covers when the
 * host says the project is gone.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasPairedDevice, resumeAuth } from "../../../mobile-web/src/auth";
import { hasLocalUnlock } from "../../../mobile-web/src/localLock";
import { api, setProjectGoneHandler } from "../../../mobile-web/src/api";
import { forgetDrafts, readDraft, writeDraft } from "../../../mobile-web/src/drafts";
import { storageKey } from "../../lib/brand";
import { addMark, EMPTY_LAYER } from "../../../mobile-web/src/markup/layer";
import { clearLayer, forgetLayers, layerKey, loadLayer, saveLayer, type LayerBackend } from "../../../mobile-web/src/markup/store";
import { forgetHeld, readHeld, writeHeld } from "../../../mobile-web/src/terminal/heldPrompts";
import { pendingPrompt } from "../../../mobile-web/src/terminal/pendingPrompts";
import { ThumbCache, thumbKey, type ThumbBackend } from "../../../mobile-web/src/thumbs";

vi.mock("../../../mobile-web/src/auth", () => ({
  hasPairedDevice: vi.fn(async () => true),
  resumeAuth: vi.fn(),
  logoutAuth: vi.fn(async () => undefined),
  pair: vi.fn(),
  finishOidcReturn: vi.fn(async () => null),
}));
vi.mock("../../../mobile-web/src/localLock", () => ({ hasLocalUnlock: vi.fn(async () => true) }));
vi.mock("../../../mobile-web/src/screens/LocalUnlock", () => ({
  LocalUnlock: ({ onUnlocked }: { onUnlocked: () => void }) => <button onClick={onUnlocked}>Unlock now</button>,
}));
vi.mock("../../../mobile-web/src/screens/Terminal", () => ({ Terminal: () => <div>terminal</div> }));
vi.mock("../../../mobile-web/src/screens/Pair", () => ({
  noteOidcOutcome: () => undefined,
  Pair: () => <div>Pair this phone</div>,
}));

const forgotten = vi.hoisted(() => ({ device: vi.fn(async () => undefined), project: vi.fn(async () => true) }));
vi.mock("../../../mobile-web/src/forgetDeviceData", () => ({ forgetDeviceData: forgotten.device }));
vi.mock("../../../mobile-web/src/thumbs", async (original) => ({
  ...(await original<typeof import("../../../mobile-web/src/thumbs")>()),
  forgetProjectCovers: forgotten.project,
}));

import { App } from "../../../mobile-web/src/App";

const SIZE: [number, number] = [100, 100];
const layer = addMark(EMPTY_LAYER, 1, SIZE, { kind: "ink", color: "red", width: 2, points: [[1, 2, 0.5]] });

function memoryLayers(): LayerBackend & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    get: async (k) => map.get(k),
    put: async (k, v) => { map.set(k, v); },
    delete: async (k) => { map.delete(k); },
    clear: async () => { map.clear(); },
  };
}

function memoryThumbs(): ThumbBackend & { records: Map<string, unknown> } {
  const records = new Map<string, unknown>();
  const used = new Map<string, number>();
  return {
    records,
    get: async (key) => records.get(key),
    put: async (key, record, at) => { records.set(key, record); used.set(key, at); },
    touch: async (key, at) => { used.set(key, at); },
    delete: async (keys) => { for (const key of keys) { records.delete(key); used.delete(key); } },
    usage: async () => [...used],
  };
}

const png = { name: "a.png", kind: "image/png", size: 10, modified: 1 };
const jpeg = () => new Blob([new Uint8Array(10)], { type: "image/jpeg" });

describe("each store forgets on its own", () => {
  beforeEach(() => localStorage.clear());

  it("drafts", () => {
    writeDraft("t1", "half a thought");
    writeDraft("t2", "another");
    forgetDrafts();
    expect(readDraft("t1")).toBe("");
    expect(readDraft("t2")).toBe("");
  });

  it("held prompts", () => {
    writeHeld("t1", [{ ...pendingPrompt(1, "later", []), held: "h1", sentAt: new Date().toISOString() }]);
    expect(readHeld("t1")).toHaveLength(1);
    forgetHeld();
    expect(readHeld("t1")).toEqual([]);
  });

  it("markup layers", async () => {
    const backend = memoryLayers();
    await saveLayer(layerKey("p1", { files: "a.pdf" }), layer, { size: 1, modified: 1 }, backend);
    await saveLayer(layerKey("p2", { outbox: "b.pdf" }), layer, { size: 1, modified: 1 }, backend);
    expect(backend.map.size).toBe(2);
    expect(await forgetLayers(backend)).toBe(true);
    expect(backend.map.size).toBe(0);
    expect(await loadLayer(layerKey("p1", { files: "a.pdf" }), backend)).toBeNull();
    await clearLayer("x", backend);
  });

  it("markup layers: a store that cannot be emptied says so instead of throwing", async () => {
    const stuck: LayerBackend = { get: async () => null, put: async () => undefined, delete: async () => undefined, clear: () => Promise.reject(new Error("SecurityError")) };
    expect(await forgetLayers(stuck)).toBe(false);
    expect(await forgetLayers({ get: async () => null, put: async () => undefined, delete: async () => undefined })).toBe(false);
  });

  it("covers: all of them, or one project's", async () => {
    const backend = memoryThumbs();
    const cache = new ThumbCache(backend);
    await cache.store(thumbKey("p1", "", png), jpeg());
    await cache.store(thumbKey("p1", "docs", png), null);
    await cache.store(thumbKey("p2", "", png), jpeg());
    expect(await cache.forget("p1")).toBe(true);
    expect([...backend.records.keys()]).toEqual([thumbKey("p2", "", png)]);
    // The cache's own index forgot them too: a later store keeps counting right.
    expect(await cache.read(thumbKey("p1", "", png))).toBeNull();
    expect(await cache.forget()).toBe(true);
    expect(backend.records.size).toBe(0);
  });

  it("covers: an unreachable cache is reported, not thrown", async () => {
    const broken: ThumbBackend = {
      get: () => Promise.reject(new Error("x")),
      put: () => Promise.reject(new Error("x")),
      touch: () => Promise.reject(new Error("x")),
      delete: () => Promise.reject(new Error("x")),
      usage: () => Promise.reject(new Error("x")),
    };
    expect(await new ThumbCache(broken).forget()).toBe(false);
  });

  it("covers: uses the store's own clear when it has one", async () => {
    const backend = { ...memoryThumbs(), clear: vi.fn(async () => undefined) };
    const cache = new ThumbCache(backend);
    await cache.store(thumbKey("p1", "", png), jpeg());
    await cache.forget();
    expect(backend.clear).toHaveBeenCalledOnce();
  });
});

describe("forgetDeviceData", () => {
  it("forgets the last place, drafts and held prompts, and survives a store that fails", async () => {
    const actual = await vi.importActual<typeof import("../../../mobile-web/src/forgetDeviceData")>("../../../mobile-web/src/forgetDeviceData");
    localStorage.clear();
    localStorage.setItem(storageKey("mobile.lastTab"), JSON.stringify({ section: "projects" }));
    writeDraft("t1", "unsent");
    writeHeld("t1", [{ ...pendingPrompt(1, "later", []), held: "h1", sentAt: new Date().toISOString() }]);
    // jsdom has no IndexedDB: the covers and layers cannot be reached, which must not matter.
    await expect(actual.forgetDeviceData()).resolves.toBeUndefined();
    expect(readDraft("t1")).toBe("");
    expect(readHeld("t1")).toEqual([]);
    expect(localStorage.getItem(storageKey("mobile.lastTab"))).toBeNull();
  });
});

describe("the project the host no longer knows", () => {
  afterEach(() => {
    setProjectGoneHandler(undefined);
    vi.unstubAllGlobals();
  });

  const refuse = (status: number, error: string) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error }), { status })));

  it("drops its covers on project_not_found", async () => {
    const gone = vi.fn();
    setProjectGoneHandler(gone);
    refuse(404, "project_not_found");
    await expect(api("/api/v1/projects/p%201/files?x=1")).rejects.toMatchObject({ status: 404 });
    expect(gone).toHaveBeenCalledExactlyOnceWith("p 1");
  });

  it("does not for another refusal, another 404, or a route outside a project", async () => {
    const gone = vi.fn();
    setProjectGoneHandler(gone);
    refuse(404, "tab_not_found");
    await expect(api("/api/v1/projects/p1/tabs/t")).rejects.toBeTruthy();
    refuse(503, "catalog_unavailable");
    await expect(api("/api/v1/projects/p1")).rejects.toBeTruthy();
    refuse(404, "project_not_found");
    await expect(api("/api/v1/todo/projects")).rejects.toBeTruthy();
    expect(gone).not.toHaveBeenCalled();
  });
});

describe("the app forgets on a definite unpaired only", () => {
  const fetchMock = vi.fn();
  const lapsed = () => new Response(JSON.stringify({ error: "authentication_required" }), { status: 401 });
  const ok = () => new Response(JSON.stringify({ projects: [{ id: "p1", label: "Alpha", status: "active", live_sessions: 1 }] }), { status: 200 });

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    forgotten.device.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(resumeAuth).mockReset();
    vi.mocked(hasPairedDevice).mockResolvedValue(true);
    vi.mocked(hasLocalUnlock).mockResolvedValue(true);
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("/api/v1/projects")) return ok();
      if (url.startsWith("/api/v1/alerts")) return new Response(JSON.stringify({ alerts: { enabled: false, items: [] } }), { status: 200 });
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    });
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("forgets when the sign-in says the device is unknown", async () => {
    vi.mocked(resumeAuth).mockResolvedValue({ kind: "unpaired" });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Unlock now" }));
    await screen.findByText("Pair this phone");
    expect(forgotten.device).toHaveBeenCalledOnce();
  });

  it("forgets when no device key is left", async () => {
    vi.mocked(hasPairedDevice).mockResolvedValue(false);
    render(<App />);
    await screen.findByText("Pair this phone");
    expect(forgotten.device).toHaveBeenCalledOnce();
  });

  it("does not forget when the host is unreachable or the sign-in timed out", async () => {
    vi.mocked(resumeAuth).mockResolvedValue({ kind: "unavailable", reason: "timeout" });
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Unlock now" }));
    await waitFor(() => expect(resumeAuth).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(forgotten.device).not.toHaveBeenCalled();
  });

  it("forgets when a renewal behind a 401 is refused as an unknown device, not when it fails offline", async () => {
    fetchMock.mockImplementation(async () => lapsed());
    vi.mocked(resumeAuth)
      .mockResolvedValueOnce({ kind: "paired" })
      .mockResolvedValueOnce({ kind: "unavailable", reason: "desktop_down" });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Unlock now" }));
    await waitFor(() => expect(resumeAuth).toHaveBeenCalledTimes(2));
    await screen.findByRole("button", { name: "Retry" });
    expect(forgotten.device).not.toHaveBeenCalled();

    vi.mocked(resumeAuth).mockReset();
    vi.mocked(resumeAuth)
      .mockResolvedValueOnce({ kind: "paired" })
      .mockResolvedValueOnce({ kind: "unpaired" });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Pair this phone");
    expect(forgotten.device).toHaveBeenCalledOnce();
  });

  it("wires the project-gone signal to the covers", async () => {
    vi.mocked(resumeAuth).mockResolvedValue({ kind: "paired" });
    forgotten.project.mockClear();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Unlock now" }));
    await screen.findByText("Alpha");
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: "project_not_found" }), { status: 404 }));
    await api("/api/v1/projects/p9/files").catch(() => undefined);
    expect(forgotten.project).toHaveBeenCalledWith("p9");
  });
});
