import { afterEach, describe, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { runWithProgress } from "../../lib/runWithProgress";

const listenMock = vi.mocked(listen);

afterEach(() => listenMock.mockReset());

describe("runWithProgress", () => {
  it("rejects without running the job when the subscription fails", async () => {
    listenMock.mockRejectedValue(new Error("no bus"));
    const run = vi.fn(async () => 1);
    await expect(runWithProgress("e", () => {}, run)).rejects.toThrow("no bus");
    expect(run).not.toHaveBeenCalled();
  });

  it("forwards payloads and unlistens after success and after failure", async () => {
    const unlisten = vi.fn();
    let emit: (e: { payload: string }) => void = () => {};
    listenMock.mockImplementation(async (_event, handler) => {
      emit = handler as typeof emit;
      return unlisten;
    });
    const seen: string[] = [];
    const out = await runWithProgress<string, number>("e", (p) => seen.push(p), async () => {
      emit({ payload: "line" });
      return 7;
    });
    expect(out).toBe(7);
    expect(seen).toEqual(["line"]);
    expect(unlisten).toHaveBeenCalledTimes(1);

    await expect(
      runWithProgress("e", () => {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(unlisten).toHaveBeenCalledTimes(2);
  });
});
