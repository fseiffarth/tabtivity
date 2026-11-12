/**
 * `hostKeyConfirmOnce` (`lib/remote/hostKeyOnce`): the fingerprint question for a
 * RETRY LOOP. The extend-to-remote flow dials a fresh host up to six times, so
 * the decision is taken once per loop and held — accepted means later attempts
 * simply run, declined means they fail with the original error and never
 * re-ask. "No" is an answer; asking again is how a gate gets worn down.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { UNKNOWN_HOST_KEY } from "../../lib/remote/hostKey";
import { hostKeyConfirmOnce } from "../../lib/remote/hostKeyOnce";
import { useHostKeyPromptStore } from "../../stores/remote/hostKeyPrompt";

const REFUSAL = `${UNKNOWN_HOST_KEY} new.example:22 — never accepted on this machine.`;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "ssh_host_key_preview")
      return Promise.resolve({
        target: "new.example:22",
        known: false,
        keys: [{ keyType: "ED25519", fingerprint: "SHA256:abc", bits: 256 }],
      });
    if (cmd === "ssh_trust_host_key") return Promise.resolve();
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });
  useHostKeyPromptStore.setState({ pending: null, status: "loading", error: "", keys: [] });
});

const pendingOpens = () =>
  vi.waitFor(() => expect(useHostKeyPromptStore.getState().pending).not.toBeNull());

describe("hostKeyConfirmOnce", () => {
  it("passes successes and unrelated failures through without asking", async () => {
    const run = hostKeyConfirmOnce();
    await expect(run(() => Promise.resolve("ok"))).resolves.toBe("ok");
    await expect(run(() => Promise.reject("Connection refused"))).rejects.toBe("Connection refused");
    expect(useHostKeyPromptStore.getState().pending).toBeNull();
  });

  it("asks once, then lets every later attempt run without re-asking", async () => {
    const run = hostKeyConfirmOnce();
    const attempt = vi.fn().mockRejectedValueOnce(REFUSAL).mockResolvedValueOnce("connected");
    const first = run(attempt);
    await pendingOpens();
    await vi.waitFor(() => expect(useHostKeyPromptStore.getState().keys).not.toHaveLength(0));
    await useHostKeyPromptStore.getState().accept();
    await expect(first).resolves.toBe("connected");
    expect(attempt).toHaveBeenCalledTimes(2);

    // A later attempt in the same loop that somehow refuses again (a race with
    // known_hosts) retries straight away — the decision is held.
    const again = vi.fn().mockRejectedValueOnce(REFUSAL).mockResolvedValueOnce("connected");
    await expect(run(again)).resolves.toBe("connected");
    expect(again).toHaveBeenCalledTimes(2);
    expect(useHostKeyPromptStore.getState().pending).toBeNull();
  });

  it("holds a decline for the rest of the loop: the original error, no second dialog", async () => {
    const run = hostKeyConfirmOnce();
    const attempt = vi.fn().mockRejectedValue(REFUSAL);
    const first = run(attempt);
    await pendingOpens();
    useHostKeyPromptStore.getState().cancel();
    await expect(first).rejects.toBe(REFUSAL);
    expect(attempt).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 5; i++) {
      const retry = vi.fn().mockRejectedValue(REFUSAL);
      await expect(run(retry)).rejects.toBe(REFUSAL);
      expect(retry).toHaveBeenCalledTimes(1);
    }
    expect(useHostKeyPromptStore.getState().pending).toBeNull();
  });

  it("starts a new loop with a fresh question", async () => {
    const first = hostKeyConfirmOnce();
    const p = first(() => Promise.reject(REFUSAL));
    await pendingOpens();
    useHostKeyPromptStore.getState().cancel();
    await expect(p).rejects.toBe(REFUSAL);

    const second = hostKeyConfirmOnce();
    const q = second(() => Promise.reject(REFUSAL));
    await pendingOpens();
    useHostKeyPromptStore.getState().cancel();
    await expect(q).rejects.toBe(REFUSAL);
  });
});
