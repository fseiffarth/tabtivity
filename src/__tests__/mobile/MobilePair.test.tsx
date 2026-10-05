import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../mobile-web/src/auth", () => ({ pair: vi.fn() }));
vi.mock("../../../mobile-web/src/localLock", () => ({
  MIN_NEW_PIN: 6,
  validPin: (pin: string) => /^\d{4,12}$/.test(pin),
  configureLocalUnlock: vi.fn(),
  platformBiometricAvailable: vi.fn(async () => true),
}));

import { pair } from "../../../mobile-web/src/auth";
import { configureLocalUnlock } from "../../../mobile-web/src/localLock";
import { Pair } from "../../../mobile-web/src/screens/Pair";

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
