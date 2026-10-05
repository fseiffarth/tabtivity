import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { UNKNOWN_HOST_KEY, unknownHostKeyTarget, withHostKeyConfirm } from "../../lib/remote/hostKey";
import { useHostKeyPromptStore } from "../../stores/remote/hostKeyPrompt";

/**
 * The first-contact host-key gate, from the frontend's side.
 *
 * The whole recovery flow hangs off one string: the backend's refusal carries
 * `TABTIVITY_UNKNOWN_HOST_KEY <host:port>`, and the wrapper reads the target out of
 * *the error itself* rather than from the call site. So the parse and the
 * retry-once-on-accept contract are what these cover.
 */

const REFUSAL = `${UNKNOWN_HOST_KEY} build.example:2222 — this host's SSH key has never been accepted on this machine.`;

beforeEach(() => {
  invokeMock.mockReset();
  // Seed "loading", never "ready": a wait for `ready` would otherwise pass
  // instantly against the seed, before the dialog has even opened.
  useHostKeyPromptStore.setState({ pending: null, status: "loading", error: "", keys: [], scan: "" });
});

describe("unknownHostKeyTarget", () => {
  it("reads the resolved target out of the refusal", () => {
    expect(unknownHostKeyTarget(REFUSAL)).toBe("build.example:2222");
    // Tauri rejections arrive as strings, but an Error must work too.
    expect(unknownHostKeyTarget(new Error(REFUSAL))).toBe("build.example:2222");
  });

  it("does not claim an ordinary auth failure", () => {
    // Every other connect error must fall through untouched — misreading one as a
    // host-key problem would put a fingerprint dialog in front of a typo'd password.
    expect(unknownHostKeyTarget("Permission denied (publickey,password).")).toBeNull();
    expect(unknownHostKeyTarget("")).toBeNull();
    expect(unknownHostKeyTarget(undefined)).toBeNull();
  });
});

describe("withHostKeyConfirm", () => {
  it("passes a successful connect straight through without asking", async () => {
    const attempt = vi.fn().mockResolvedValue("ok");
    await expect(withHostKeyConfirm(attempt)).resolves.toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(useHostKeyPromptStore.getState().pending).toBeNull();
  });

  it("re-throws any other failure without opening the dialog", async () => {
    const attempt = vi.fn().mockRejectedValue("Permission denied (publickey,password).");
    await expect(withHostKeyConfirm(attempt)).rejects.toBe(
      "Permission denied (publickey,password).",
    );
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(useHostKeyPromptStore.getState().pending).toBeNull();
  });

  it("retries exactly once after the user accepts the fingerprint", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "ssh_host_key_preview")
        return Promise.resolve({
          target: "build.example:2222",
          known: false,
          keys: [{ keyType: "ED25519", fingerprint: "SHA256:abc", bits: 256 }],
          scan: "[build.example]:2222 ssh-ed25519 AAAA",
        });
      if (cmd === "ssh_trust_host_key") return Promise.resolve();
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });

    const attempt = vi.fn().mockRejectedValueOnce(REFUSAL).mockResolvedValueOnce("connected");
    const done = withHostKeyConfirm(attempt);

    // The dialog opens on the target parsed out of the error, and the preview is
    // fetched for the split host/port — not the joined string.
    // The scan is what Accept needs, so it is what "the dialog is ready" means.
    await vi.waitFor(() => expect(useHostKeyPromptStore.getState().scan).not.toBe(""));
    expect(useHostKeyPromptStore.getState().status).toBe("ready");
    expect(useHostKeyPromptStore.getState().pending?.target).toBe("build.example:2222");
    expect(invokeMock).toHaveBeenCalledWith("ssh_host_key_preview", {
      host: "build.example",
      port: 2222,
    });

    await useHostKeyPromptStore.getState().accept();
    await expect(done).resolves.toBe("connected");
    expect(attempt).toHaveBeenCalledTimes(2);
    // What is stored is what was shown — the scan is handed back verbatim, never
    // re-fetched at accept time.
    expect(invokeMock).toHaveBeenCalledWith("ssh_trust_host_key", {
      scan: "[build.example]:2222 ssh-ed25519 AAAA",
    });
  });

  it("does not retry when the user declines, and keeps the original error", async () => {
    invokeMock.mockResolvedValue({
      target: "build.example:2222",
      known: false,
      keys: [{ keyType: "ED25519", fingerprint: "SHA256:abc", bits: 256 }],
      scan: "line",
    });
    const attempt = vi.fn().mockRejectedValue(REFUSAL);
    const done = withHostKeyConfirm(attempt);
    await vi.waitFor(() => expect(useHostKeyPromptStore.getState().pending).not.toBeNull());

    useHostKeyPromptStore.getState().cancel();
    // Declining is a decision, not a new error: the caller sees the connect failure
    // it would have seen anyway, so its lamp/message stay truthful.
    await expect(done).rejects.toBe(REFUSAL);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("retries without asking when the key turned out to be known already", async () => {
    // Another connect accepted this host while we were about to ask. There is
    // nothing left to confirm, so the caller must not be shown a dialog it would
    // only have to dismiss.
    invokeMock.mockResolvedValue({ target: "build.example:22", known: true, keys: [], scan: "" });
    const attempt = vi.fn().mockRejectedValueOnce(REFUSAL).mockResolvedValueOnce("connected");
    await expect(withHostKeyConfirm(attempt)).resolves.toBe("connected");
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(invokeMock).not.toHaveBeenCalledWith("ssh_trust_host_key", expect.anything());
    expect(useHostKeyPromptStore.getState().pending).toBeNull();
  });

  it("offers nothing to accept when the host key cannot be read", async () => {
    // No fingerprint ⇒ no question can be asked. The modal must not present an
    // Accept that would trust an empty scan.
    invokeMock.mockRejectedValue("no route to host");
    const attempt = vi.fn().mockRejectedValue(REFUSAL);
    const done = withHostKeyConfirm(attempt);
    await vi.waitFor(() => expect(useHostKeyPromptStore.getState().status).toBe("error"));
    expect(useHostKeyPromptStore.getState().scan).toBe("");

    await useHostKeyPromptStore.getState().accept(); // a no-op with no scan
    expect(invokeMock).not.toHaveBeenCalledWith("ssh_trust_host_key", expect.anything());
    useHostKeyPromptStore.getState().cancel();
    await expect(done).rejects.toBe(REFUSAL);
  });
});
