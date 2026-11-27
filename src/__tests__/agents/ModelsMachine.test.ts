import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { readModelsMachine } from "../../lib/agents/modelsMachine";
import { markServerClient, resetLinkStateForTests } from "../../lib/transport/linkState";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("readModelsMachine", () => {
  afterEach(() => {
    vi.mocked(invoke).mockReset();
    resetLinkStateForTests();
  });

  it("reads this machine in the window", async () => {
    const mocked = vi.mocked(invoke);
    mocked.mockImplementation((cmd: string) => Promise.resolve(cmd === "gpu_memory_snapshot" ? [] : { mem_total_bytes: 8 }));
    const reading = readModelsMachine();
    expect(await reading.gpus).toEqual([]);
    expect((await reading.machine).mem_total_bytes).toBe(8);
    expect(mocked.mock.calls.map(([cmd]) => cmd).sort()).toEqual(["gpu_memory_snapshot", "machine_load_snapshot"]);
  });

  it("asks the server about its own machine in the browser client, never the client readings", async () => {
    const mocked = vi.mocked(invoke);
    markServerClient();
    mocked.mockResolvedValueOnce({ machine: { mem_total_bytes: 64 }, gpus: [{ vram_total: 24 }] });
    const reading = readModelsMachine();
    expect((await reading.machine).mem_total_bytes).toBe(64);
    expect(await reading.gpus).toEqual([{ vram_total: 24 }]);
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(mocked).toHaveBeenCalledWith("models_host_load");
  });
});
