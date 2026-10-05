import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { ExecTrustDeclinedError, parseTrustRequest, withExecTrust } from "../../lib/execTrust";
import { useExecTrustStore } from "../../stores/execTrust";
import { BRAND } from "../../lib/brand";

const request = {
  kind: "latexmkrc",
  dir: "/p",
  fingerprint: "abc",
  changed: false,
  items: [{ label: "/p/.latexmkrc", preview: "system('x')", truncated: false }],
};
const gateError = `${BRAND.slug}-trust-required:${JSON.stringify(request)}`;

/** Answer the next question the store raises. */
function answerNext(approved: boolean) {
  const unsub = useExecTrustStore.subscribe((s) => {
    if (s.pending) {
      unsub();
      queueMicrotask(() => useExecTrustStore.getState().answer(approved));
    }
  });
}

describe("exec trust", () => {
  beforeEach(() => {
    invoke.mockReset();
    useExecTrustStore.setState({ pending: null });
  });

  it("parses only the gate's own error", () => {
    expect(parseTrustRequest(gateError)?.fingerprint).toBe("abc");
    expect(parseTrustRequest("fatal: not a git repository")).toBeNull();
    expect(parseTrustRequest(`${BRAND.slug}-trust-required:{broken`)).toBeNull();
  });

  it("approves what was shown, then runs the action again", async () => {
    invoke.mockResolvedValue(undefined);
    const action = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(gateError)
      .mockResolvedValueOnce("built");
    answerNext(true);
    await expect(withExecTrust(action)).resolves.toBe("built");
    expect(invoke).toHaveBeenCalledWith("exec_trust_approve", {
      kind: "latexmkrc",
      dir: "/p",
      fingerprint: "abc",
    });
    expect(action).toHaveBeenCalledTimes(2);
  });

  it("a decline runs nothing and records nothing", async () => {
    const action = vi.fn<() => Promise<string>>().mockRejectedValue(gateError);
    answerNext(false);
    const err = await withExecTrust(action).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecTrustDeclinedError);
    expect(String(err)).not.toContain("ExecTrustDeclinedError");
    expect(invoke).not.toHaveBeenCalled();
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("passes other errors straight through", async () => {
    const action = vi.fn<() => Promise<string>>().mockRejectedValue("push rejected");
    await expect(withExecTrust(action)).rejects.toBe("push rejected");
    expect(useExecTrustStore.getState().pending).toBeNull();
  });
});
