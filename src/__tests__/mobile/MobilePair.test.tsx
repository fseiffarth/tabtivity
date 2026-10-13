import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../mobile-web/src/auth", () => ({ pair: vi.fn(), oidcProvider: vi.fn(async () => null), startOidc: vi.fn(async () => undefined) }));
vi.mock("../../../mobile-web/src/localLock", () => ({
  MIN_NEW_PIN: 6,
  validPin: (pin: string) => /^\d{4,12}$/.test(pin),
  configureLocalUnlock: vi.fn(),
  platformBiometricAvailable: vi.fn(async () => true),
}));

import { oidcProvider, pair, startOidc } from "../../../mobile-web/src/auth";
import { configureLocalUnlock } from "../../../mobile-web/src/localLock";
import { Pair, cleanPairingCode, noteOidcOutcome, pairingCodeComplete, takeLinkedPairingCode } from "../../../mobile-web/src/screens/Pair";

const paired = vi.mocked(pair);
const configured = vi.mocked(configureLocalUnlock);

beforeEach(() => {
  paired.mockResolvedValue(undefined);
  configured.mockResolvedValue({ biometricEnrolled: true });
});

afterEach(() => {
  cleanup();
  paired.mockReset();
  configured.mockReset();
});

function fillForm() {
  fireEvent.change(screen.getByLabelText("Pairing code"), { target: { value: "12345678" } });
  fireEvent.change(screen.getByLabelText("App PIN (6–12 digits)"), { target: { value: "123456" } });
  fireEvent.change(screen.getByLabelText("Confirm app PIN"), { target: { value: "123456" } });
}

describe("phone connection", () => {
  it("pairs and sets the lock with one submit, then opens the workspace", async () => {
    const onDone = vi.fn();
    render(<Pair setupLock onDone={onDone} />);
    const button = screen.getByRole("button", { name: "Connect and secure" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fillForm();
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(paired).toHaveBeenCalledWith("12345678", "Mobile device");
    expect(configured).toHaveBeenCalledWith("123456");
    expect(paired.mock.invocationCallOrder[0]).toBeLessThan(configured.mock.invocationCallOrder[0]!);
  });

  it("retries lock setup without consuming the pairing code twice", async () => {
    configured.mockRejectedValueOnce(new Error("Device verification was cancelled."));
    const onDone = vi.fn();
    render(<Pair setupLock onDone={onDone} />);
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Connect and secure" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Device verification was cancelled.");
    expect(screen.queryByLabelText("Pairing code")).toBeNull();
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(paired).toHaveBeenCalledTimes(1);
    expect(configured).toHaveBeenCalledTimes(2);
  });
});

describe("pairing codes", () => {
  it("keeps a server's name:code as typed and the desktop's digits as before", () => {
    expect(cleanPairingCode("Flo:1234 5678")).toBe("flo:12345678");
    expect(cleanPairingCode("1234-5678")).toBe("12345678");
    expect(cleanPairingCode("flo:12a:34")).toBe("flo:1234");
    expect(pairingCodeComplete("12345678")).toBe(true);
    expect(pairingCodeComplete("bob_2:12345678")).toBe(true);
    expect(pairingCodeComplete("1234567")).toBe(false);
    expect(pairingCodeComplete("flo:")).toBe(false);
    expect(pairingCodeComplete(":12345678")).toBe(false);
  });

  it("pairs with a server's routed code", async () => {
    render(<Pair setupLock={false} onDone={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Pairing code"), { target: { value: "flo:12345678" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect phone" }));
    await waitFor(() => expect(pair).toHaveBeenCalledWith("flo:12345678", "Mobile device"));
  });
});

describe("phone connection through a server's identity provider (hosted P5)", () => {
  it("offers the provider's sign-in beside the code and starts it with the device name", async () => {
    vi.mocked(oidcProvider).mockResolvedValueOnce("Lab SSO");
    render(<Pair setupLock={false} onDone={vi.fn()} />);
    const button = await screen.findByRole("button", { name: /Sign in with Lab SSO/ });
    expect(screen.getByLabelText("Pairing code")).toBeTruthy();
    fireEvent.click(button);
    await waitFor(() => expect(startOidc).toHaveBeenCalledWith("Mobile device"));
  });

  it("says why a returning sign-in paired nothing, once", async () => {
    noteOidcOutcome("unknown");
    render(<Pair setupLock={false} onDone={vi.fn()} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/not linked to an account/);
    cleanup();
    render(<Pair setupLock={false} onDone={vi.fn()} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: /Sign in with/ })).toBeNull();
  });
});

describe("pairing link", () => {
  afterEach(() => history.replaceState(null, "", "/"));

  it("takes the code from an Add device QR's fragment and wipes it from the address", () => {
    history.replaceState(null, "", "/?x=1#pair=1234%205678");
    expect(takeLinkedPairingCode()).toBe("12345678");
    expect(location.hash).toBe("");
    expect(location.search).toBe("?x=1");
  });

  it("keeps a server's account prefix and ignores other fragments", () => {
    history.replaceState(null, "", "/#pair=alice%3A12345678");
    expect(takeLinkedPairingCode()).toBe("alice:12345678");
    history.replaceState(null, "", "/#inbox");
    expect(takeLinkedPairingCode()).toBe("");
    expect(location.hash).toBe("#inbox");
  });
});
