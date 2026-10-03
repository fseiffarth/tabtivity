/**
 * The phone's re-pin prompt (`SecretsRepinSheet`): shown when the server's
 * identity key is not the pinned one; a code that does not confirm the new
 * key changes nothing, the right one re-pins.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../../mobile-web/src/secrets", () => ({ repinWithCode: vi.fn() }));

import { repinWithCode } from "../../../mobile-web/src/secrets";
import { SecretsRepinSheet } from "../../../mobile-web/src/screens/SecretsRepinSheet";

describe("SecretsRepinSheet", () => {
  afterEach(cleanup);

  it("re-pins only with a code that confirms the new key", async () => {
    vi.mocked(repinWithCode).mockImplementation(async (code: string) => (code === "right" ? "repinned" : "mismatch"));
    const onClose = vi.fn();
    render(<SecretsRepinSheet onClose={onClose} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Trust the new key" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/does not confirm this key/);
    fireEvent.change(input, { target: { value: " right " } });
    fireEvent.click(screen.getByRole("button", { name: "Trust the new key" }));
    expect((await screen.findByRole("status")).textContent).toMatch(/The new key is trusted/);
    expect(repinWithCode).toHaveBeenLastCalledWith("right");
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("points an outdated recovery wrap at the one unlock that upgrades it", async () => {
    vi.mocked(repinWithCode).mockRejectedValue(new Error("recovery_outdated"));
    render(<SecretsRepinSheet onClose={() => undefined} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "code" } });
    fireEvent.click(screen.getByRole("button", { name: "Trust the new key" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/older version/);
  });
});
