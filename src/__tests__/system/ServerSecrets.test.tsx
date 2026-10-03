/**
 * The secrets key panel of a hosted server (plan §6.8): nothing off a
 * server, set-up shows the recovery code once, a locked key unlocks with
 * the code.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ServerSecrets } from "../../components/server/ServerSecrets";

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

  it("sets the key up and shows the recovery code once", async () => {
    let setUp = false;
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/v1/secrets/setup" && init?.method === "POST") {
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
});
