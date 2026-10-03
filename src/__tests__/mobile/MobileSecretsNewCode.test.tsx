/**
 * The phone's new-recovery-code sheet (`SecretsNewCodeSheet`): offered
 * after a device was revoked; makes the code with the phone's signature,
 * shows it once; Later closes it without making one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../../mobile-web/src/secrets", () => ({ makeNewRecoveryCode: vi.fn() }));

import { makeNewRecoveryCode } from "../../../mobile-web/src/secrets";
import { SecretsNewCodeSheet } from "../../../mobile-web/src/screens/SecretsNewCodeSheet";

describe("SecretsNewCodeSheet", () => {
  afterEach(cleanup);

  it("makes a new code and shows it once", async () => {
    vi.mocked(makeNewRecoveryCode).mockResolvedValue("1111-2222-3333-4444-5555-6666-7777-8888");
    const onClose = vi.fn();
    render(<SecretsNewCodeSheet onClose={onClose} />);
    expect(screen.getByText(/A device was disconnected after your recovery code was made/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Make a new recovery code" }));
    expect((await screen.findByTestId("mobile-recovery-code")).textContent).toBe("1111-2222-3333-4444-5555-6666-7777-8888");
    expect(screen.queryAllByRole("button", { name: "Later" })).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "I have written it down" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("says why when the code could not be made, and Later makes none", async () => {
    vi.mocked(makeNewRecoveryCode).mockReset();
    vi.mocked(makeNewRecoveryCode).mockRejectedValue(new Error("the secrets key is locked"));
    const onClose = vi.fn();
    render(<SecretsNewCodeSheet onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Make a new recovery code" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/the secrets key is locked/);
    const later = screen.getAllByRole("button", { name: "Later" });
    fireEvent.click(later[later.length - 1]);
    expect(onClose).toHaveBeenCalled();
    expect(makeNewRecoveryCode).toHaveBeenCalledTimes(1);
  });
});
