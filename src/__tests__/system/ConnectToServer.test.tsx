/**
 * Connect to a server (hosted plan §7.2, P5), the desktop's settings half:
 * pair with an invite code, then open or forget the server window.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

import { ConnectToServer } from "../../components/server/ConnectToServer";

afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
});

describe("Connect to a server (desktop settings)", () => {
  it("pairs with the address, code and name, then opens and forgets the server window", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "connect_pair") return Promise.resolve({ origin: "https://desk.example", device_id: "d1234567", device_name: "Laptop" });
      return Promise.resolve(null);
    });
    render(<ConnectToServer />);
    const pair = await screen.findByRole("button", { name: "Pair" });
    expect((pair as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Server address (https://…)"), { target: { value: "https://desk.example" } });
    fireEvent.change(screen.getByLabelText("Invite code (name:12345678)"), { target: { value: "alice:12345678" } });
    fireEvent.change(screen.getByLabelText("Name of this computer"), { target: { value: " Laptop " } });
    fireEvent.click(pair);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("connect_pair", { origin: "https://desk.example", code: "alice:12345678", deviceName: "Laptop" }));
    expect(await screen.findByText(/Paired with https:\/\/desk.example as “Laptop”/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open the server window" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("connect_open"));
    fireEvent.click(screen.getByRole("button", { name: "Forget this server" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("connect_forget"));
    expect(await screen.findByRole("button", { name: "Pair" })).toBeTruthy();
  });

  it("shows the server's refusal", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) => (cmd === "connect_pair" ? Promise.reject("the server refused: invalid_pairing_code") : Promise.resolve(null)));
    render(<ConnectToServer />);
    fireEvent.change(screen.getByLabelText("Server address (https://…)"), { target: { value: "https://desk.example" } });
    fireEvent.change(screen.getByLabelText("Invite code (name:12345678)"), { target: { value: "alice:1" } });
    fireEvent.change(screen.getByLabelText("Name of this computer"), { target: { value: "Laptop" } });
    fireEvent.click(screen.getByRole("button", { name: "Pair" }));
    expect(await screen.findByText(/invalid_pairing_code/)).toBeTruthy();
  });
});
