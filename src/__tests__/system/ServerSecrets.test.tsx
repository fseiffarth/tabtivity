/**
 * The secrets key panel of a hosted server (plan §6.8): nothing off a
 * server, set-up shows the recovery code once, a locked key unlocks with
 * the code.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ServerSecrets } from "../../components/server/ServerSecrets";
import { loadSecrets, repinIdentity, signedAction, unlockWith } from "../../../mobile-web/src/secretsCore";

vi.mock("../../../mobile-web/src/secretsCore", () => ({
  loadSecrets: vi.fn(async () => null),
  repinIdentity: vi.fn(),
  signedAction: vi.fn(async (action: string) => ({ nonce: `nonce-${action}`, signature: "sig" })),
  unlockWith: vi.fn(async () => "released"),
}));

function answer(body: unknown, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 400, json: () => Promise.resolve(body) } as Response);
}

describe("ServerSecrets", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders nothing where no server answers", async () => {
    const fetch = vi.fn(() => answer({ available: false }));
    vi.stubGlobal("fetch", fetch);
    const { container } = render(<ServerSecrets />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("sets the key up, signed by the pairing key, and shows the recovery code once", async () => {
    let setUp = false;
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/v1/secrets/setup" && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ nonce: "nonce-secrets-setup", signature: "sig" });
        setUp = true;
        return answer({ code: "0123-4567-89ab-cdef-0123-4567-89ab-cdef" });
      }
      return answer({ available: true, setUp, unlocked: setUp });
    });
    vi.stubGlobal("fetch", fetch);
    render(<ServerSecrets />);
    fireEvent.click(await screen.findByRole("button"));
    expect((await screen.findByTestId("server-recovery-code")).textContent).toBe("0123-4567-89ab-cdef-0123-4567-89ab-cdef");
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(screen.queryByTestId("server-recovery-code")).toBeNull());
  });

  it("unlocks a locked key with the recovery code", async () => {
    let unlocked = false;
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/v1/secrets/recover") {
        const ok = JSON.parse(String(init?.body)).code === "0123-4567-89ab-cdef-0123-4567-89ab-cdef";
        unlocked = ok;
        return answer(ok ? { state: "unlocked" } : { error: "invalid_recovery_code" }, ok);
      }
      return answer({ available: true, setUp: true, unlocked });
    });
    vi.stubGlobal("fetch", fetch);
    render(<ServerSecrets />);
    const input = await screen.findByRole("textbox");
    fireEvent.change(input, { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button"));
    expect(await screen.findByText(/invalid_recovery_code/)).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: " 0123-4567-89ab-cdef-0123-4567-89ab-cdef " } });
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  });

  it("says when this browser has no pairing key to sign with", async () => {
    vi.mocked(signedAction).mockRejectedValueOnce(new Error("unpaired"));
    vi.stubGlobal("fetch", vi.fn(() => answer({ available: true, setUp: false, unlocked: false })));
    render(<ServerSecrets />);
    fireEvent.click(await screen.findByRole("button"));
    expect(await screen.findByText(/holds no paired device key/)).toBeTruthy();
  });

  it("asks for a new recovery code when none opens the current key", async () => {
    vi.stubGlobal("fetch", vi.fn(() => answer({ available: true, setUp: true, unlocked: true, recoveryCode: false })));
    render(<ServerSecrets />);
    expect(await screen.findByText(/no recovery code opens the current key/)).toBeTruthy();
  });

  it("recommends a new recovery code after a revoke until one is made", async () => {
    let recommended = true;
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/v1/secrets/recovery-code" && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ nonce: "nonce-secrets-recovery-code", signature: "sig" });
        recommended = false;
        return answer({ code: "fresh-code" });
      }
      return answer({ available: true, setUp: true, unlocked: true, recoveryCode: true, newCodeRecommended: recommended });
    });
    vi.stubGlobal("fetch", fetch);
    render(<ServerSecrets />);
    expect(await screen.findByText(/A device was disconnected after your recovery code was made/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Make a new recovery code" }));
    expect((await screen.findByTestId("server-recovery-code")).textContent).toBe("fresh-code");
    fireEvent.click(screen.getByRole("button", { name: "I have written it down" }));
    await waitFor(() => expect(screen.queryByText(/A device was disconnected/)).toBeNull());
  });

  it("says to unlock first when a new code is recommended while locked", async () => {
    vi.stubGlobal("fetch", vi.fn(() => answer({ available: true, setUp: true, unlocked: false, recoveryCode: true, newCodeRecommended: true })));
    render(<ServerSecrets />);
    expect(await screen.findByText(/Once the key is unlocked/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Make a new recovery code" })).toBeNull();
  });

  it("shows the mailbox re-key after a revoke while it runs", async () => {
    let rekey: unknown = { state: "running", done: 25, total: 100 };
    let unlocked = true;
    vi.stubGlobal("fetch", vi.fn(() => answer({ available: true, setUp: true, unlocked, recoveryCode: true, mailRekey: rekey })));
    const { unmount } = render(<ServerSecrets />);
    expect((await screen.findByTestId("server-mail-rekey")).textContent).toMatch(/25 %/);
    unmount();
    // Waiting while unlocked: the mail store has not been opened since.
    rekey = { state: "waiting", done: 0, total: 0 };
    render(<ServerSecrets />);
    expect((await screen.findByTestId("server-mail-rekey")).textContent).toMatch(/starts the next time mail is opened/);
    cleanup();
    unlocked = false;
    render(<ServerSecrets />);
    expect((await screen.findByTestId("server-mail-rekey")).textContent).toMatch(/waiting until a paired device unlocks/);
    cleanup();
    unlocked = true;
    rekey = null;
    render(<ServerSecrets />);
    await screen.findByText(/Unlocked: mail and saved passwords are open/);
    expect(screen.queryByTestId("server-mail-rekey")).toBeNull();
  });

  it("re-pins a changed identity key only when the recovery code confirms it", async () => {
    vi.mocked(loadSecrets).mockResolvedValue({ deviceId: "dev_1", ecdhPrivateKey: {} as CryptoKey, identity: "OLD" });
    vi.mocked(repinIdentity).mockImplementation(async (code: string) => (code === "right" ? "repinned" : "mismatch"));
    vi.mocked(unlockWith).mockClear();
    vi.stubGlobal("fetch", vi.fn(() => answer({ available: true, setUp: true, unlocked: false, recoveryCode: true, identity: "NEW" })));
    render(<ServerSecrets />);
    const input = await screen.findByLabelText("Recovery code", { selector: "#server-repin-input" });
    fireEvent.change(input, { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Trust the new key" }));
    expect(await screen.findByText(/does not confirm this key/)).toBeTruthy();
    expect(unlockWith).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "right" } });
    // What the re-pin saved: the panel's next read finds the new pin.
    vi.mocked(loadSecrets).mockResolvedValue({ deviceId: "dev_1", ecdhPrivateKey: {} as CryptoKey, identity: "NEW" });
    fireEvent.click(screen.getByRole("button", { name: "Trust the new key" }));
    expect(await screen.findByText(/The new key is trusted/)).toBeTruthy();
    expect(unlockWith).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Trust the new key" })).toBeNull());
  });
});
