/**
 * The browser client's Server settings (hosted plan §6.7): nothing without a
 * gateway, the user's own switches within the admin's, and the admin's
 * policy editor writing the gateway's file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const store = vi.hoisted(() => ({
  settings: { disabled_features: ["calendar"] } as { disabled_features?: string[] },
  updateSettings: vi.fn(async () => {}),
}));

vi.mock("../../stores/settings", () => ({
  useSettingsStore: (selector?: (s: typeof store) => unknown) => (selector ? selector(store) : store),
}));

import { markServerClient } from "../../lib/transport/linkState";
import { ServerSettings } from "../../components/server/ServerSettings";

const policy = (mail: boolean) => ({
  schema: 1,
  features: { mail, calendar: true, todo: true, calendar_sharing: true },
});

function answer(body: unknown, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 403, json: () => Promise.resolve(body) } as Response);
}

describe("ServerSettings", () => {
  beforeEach(() => {
    store.updateSettings.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders nothing outside the browser client", async () => {
    const fetch = vi.fn(() => answer({ policy: policy(true), role: "user" }));
    vi.stubGlobal("fetch", fetch);
    const { container } = render(<ServerSettings />);
    await Promise.resolve();
    expect(container.textContent).toBe("");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows a user's own switches within the admin's and saves only theirs", async () => {
    markServerClient();
    vi.stubGlobal("fetch", vi.fn(() => answer({ policy: policy(false), role: "user" })));
    render(<ServerSettings />);
    const boxes = await screen.findAllByRole("checkbox");
    expect(boxes).toHaveLength(3);
    const [mail, calendar, todo] = boxes as HTMLInputElement[];
    expect(mail.checked).toBe(false);
    expect(mail.disabled).toBe(true);
    expect(calendar.checked).toBe(false);
    expect(todo.checked).toBe(true);
    fireEvent.click(todo);
    expect(store.updateSettings).toHaveBeenCalledWith({ disabled_features: ["calendar", "todo"] });
    expect(screen.queryByText(/administrator\)/)).toBeNull();
  });

  it("lets the admin save the policy with the model list", async () => {
    markServerClient();
    const fetch = vi.fn((url: string, init?: RequestInit) =>
      url.startsWith("/api/v1/secrets")
        ? answer({ available: false })
        : init?.method === "PUT" ? answer({ policy: JSON.parse(String(init.body)) }) : answer({ policy: policy(true), role: "admin" }),
    );
    vi.stubGlobal("fetch", fetch);
    render(<ServerSettings />);
    const models = await screen.findByRole("textbox");
    fireEvent.change(models, { target: { value: "llama3\n\n qwen2.5:7b \n" } });
    fireEvent.click(screen.getByRole("button"));
    const puts = () => fetch.mock.calls.filter(([, init]) => init?.method === "PUT");
    await waitFor(() => expect(puts()).toHaveLength(1));
    const [, init] = puts()[0];
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body)).ollama_allowed_models).toEqual(["llama3", "qwen2.5:7b"]);
  });
});
