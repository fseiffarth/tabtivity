import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import {
  localModelMenuGroup,
  probeLocalModelPlacement,
  type LocalModelPlacementState,
} from "../../components/tabs/localModelGroup";
import type { LocalDriverInfo } from "../../lib/agents/localDrivers";

const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}:${JSON.stringify(vars)}` : key;

const claude: LocalDriverInfo = {
  id: "claude",
  label: "Claude Code",
  available: true,
  needs_tools_unsupported: false,
  heavy_harness: true,
};

const opencode: LocalDriverInfo = { ...claude, id: "opencode", label: "OpenCode", heavy_harness: false };

function group(gpu: Partial<LocalModelPlacementState>, drivers = [claude], vibe = true) {
  return localModelMenuGroup({
    localModel: "qwen3:8b",
    localModelOffInRoot: undefined,
    localDrivers: drivers,
    vibeForLocalModel: vibe,
    gpu: { placement: "ready", loading: false, failed: false, load: vi.fn(), ...gpu },
    onVibe: vi.fn(),
    onLaunch: vi.fn(),
    t: t as never,
  });
}

describe("local-model group GPU gate", () => {
  it("offers the agents only once the model is on the GPU", () => {
    expect(group({ placement: "ready" }).entries.map((e) => e.key)).toEqual(["vibe", "claude"]);
  });

  it("leads with the light-harness drivers, ahead of Mistral, and cautions only the heavy ones", () => {
    const entries = group({ placement: "ready" }, [claude, opencode]).entries;
    expect(entries.map((e) => e.key)).toEqual(["opencode", "vibe", "claude"]);
    expect(entries.map((e) => !!e.caution)).toEqual([false, false, true]);
  });

  it("puts Pi with OpenCode and Cline with the cautioned agents, both tagged untested", () => {
    const pi: LocalDriverInfo = { ...opencode, id: "pi", label: "Pi" };
    const cline: LocalDriverInfo = { ...claude, id: "cline", label: "Cline" };
    const entries = group({ placement: "ready" }, [opencode, pi, claude, cline]).entries;
    expect(entries.map((e) => e.key)).toEqual(["opencode", "pi", "vibe", "claude", "cline"]);
    expect(entries.map((e) => !!e.caution)).toEqual([false, false, false, true, true]);
    expect(entries.map((e) => e.untested)).toEqual([
      undefined, "localDriver.pi", undefined, undefined, "localDriver.cline",
    ]);
  });

  it("offers a load row instead while the model is cold or on the CPU", () => {
    const load = vi.fn();
    const cold = group({ placement: "unloaded", load }).entries;
    expect(cold.map((e) => e.key)).toEqual(["__load_local_model__"]);
    expect(cold[0].label).toBe("newTabMenu.loadLocalModelGpu");
    cold[0].onPick();
    expect(load).toHaveBeenCalledOnce();
    expect(group({ placement: "cpu" }).entries[0].label).toBe("newTabMenu.reloadLocalModelGpu");
  });

  it("disables the load row while a load is in flight", () => {
    const [row] = group({ placement: "unloaded", loading: true }).entries;
    expect(row.disabled).toBe(true);
    expect(row.label).toBe("newTabMenu.loadingLocalModelGpu");
  });

  it("shows nothing but a checking hint before the probe answers", () => {
    const g = group({ placement: "probing" });
    expect(g.entries).toEqual([]);
    expect(g.hint).toContain("newTabMenu.checkingLocalModelGpu");
  });

  it("offers no load when no agent could drive the model anyway", () => {
    const g = group({ placement: "unloaded" }, [{ ...claude, available: false, needs_tools_unsupported: true }], false);
    expect(g.entries).toEqual([]);
    expect(g.hint).toContain("newTabMenu.localModelNoToolsHint");
  });
});

describe("probeLocalModelPlacement", () => {
  beforeEach(() => invokeMock.mockReset());

  const models = (running: boolean, size_vram: number) => [
    { name: "qwen3:8b", running, size_vram },
    { name: "llama3:latest", running: true, size_vram: 5 },
  ];

  it("reads GPU residency from the model list", async () => {
    invokeMock.mockResolvedValueOnce(models(true, 1024));
    expect(await probeLocalModelPlacement("qwen3:8b")).toBe("ready");
    invokeMock.mockResolvedValueOnce(models(false, 0));
    expect(await probeLocalModelPlacement("qwen3:8b")).toBe("unloaded");
  });

  it("matches a setting that omits :latest", async () => {
    invokeMock.mockResolvedValueOnce(models(false, 0));
    expect(await probeLocalModelPlacement("llama3")).toBe("ready");
  });

  it("treats CPU residency as ready only on a machine without a GPU", async () => {
    invokeMock.mockResolvedValueOnce(models(true, 0)).mockResolvedValueOnce({ gpu_present: true });
    expect(await probeLocalModelPlacement("qwen3:8b")).toBe("cpu");
    invokeMock.mockResolvedValueOnce(models(true, 0)).mockResolvedValueOnce({ gpu_present: false });
    expect(await probeLocalModelPlacement("qwen3:8b")).toBe("ready");
  });

  it("reads an unreachable Ollama as unloaded", async () => {
    invokeMock.mockRejectedValueOnce("not_running");
    expect(await probeLocalModelPlacement("qwen3:8b")).toBe("unloaded");
  });
});
