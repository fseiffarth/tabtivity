/**
 * The phone model sheet's folded launch defaults (`LaunchDefaultsFold`): the
 * tab's CLI's saved model and effort (`GET …/launch-defaults`), saved and
 * reset there (`PUT`), a refusal named; nothing for a CLI with no startup
 * choice or a tab the host refuses.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LaunchDefaults } from "../../../mobile-web/src/api";
import { LaunchDefaultsFold } from "../../../mobile-web/src/components/LaunchDefaultsFold";

const CLAUDE: LaunchDefaults = {
  saved: { model: "opus", effort: "high" },
  capabilities: { model: true, efforts: ["low", "high", "max"], effort_requires_model: false },
};

function hostAnswering(read: LaunchDefaults | "refused", put?: { status: number; error?: string }) {
  const puts: unknown[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe("/api/v1/tabs/t1/launch-defaults");
    if (init?.method === "PUT") {
      puts.push(JSON.parse(String(init.body)));
      return put?.error
        ? new Response(JSON.stringify({ error: put.error }), { status: put.status })
        : new Response(JSON.stringify({ saved: true }), { status: 200 });
    }
    if (read === "refused") return new Response(JSON.stringify({ error: "no_launch_defaults" }), { status: 409 });
    return new Response(JSON.stringify(read), { status: 200 });
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, puts };
}

describe("Mobile model sheet — launch defaults", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("names the saved default, saves an edit and resets to the CLI's own", async () => {
    const { puts } = hostAnswering(CLAUDE);
    render(<LaunchDefaultsFold tabId="t1" />);
    fireEvent.click(await screen.findByText("Default for new tabs: opus · high"));
    fireEvent.change(screen.getByRole("textbox", { name: "Default model" }), { target: { value: " sonnet " } });
    fireEvent.change(screen.getByRole("combobox", { name: "Default effort" }), { target: { value: "max" } });
    fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
    await screen.findByText("Default for new tabs: sonnet · max");
    fireEvent.click(screen.getByRole("button", { name: "Use CLI defaults" }));
    await screen.findByText("Default for new tabs: CLI default");
    expect(puts).toEqual([{ model: "sonnet", effort: "max" }, { model: "", effort: "" }]);
  });

  it("names a refusal and keeps the draft", async () => {
    hostAnswering({ ...CLAUDE, saved: { model: "", effort: "" } }, { status: 400, error: "invalid_model" });
    render(<LaunchDefaultsFold tabId="t1" />);
    fireEvent.click(await screen.findByText("Default for new tabs: CLI default"));
    fireEvent.change(screen.getByRole("textbox", { name: "Default model" }), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
    expect((await screen.findByRole("alert")).textContent).toContain("model ID");
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Default model" }).value).toBe("x");
  });

  it("shows nothing for a CLI with no startup choice or a tab the host refuses", async () => {
    const { fetch } = hostAnswering({ saved: { model: "", effort: "" }, capabilities: { model: false, efforts: [], effort_requires_model: false } });
    const none = render(<LaunchDefaultsFold tabId="t1" />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(none.container.textContent).toBe("");
    cleanup();
    const refused = hostAnswering("refused");
    const view = render(<LaunchDefaultsFold tabId="t1" />);
    await waitFor(() => expect(refused.fetch).toHaveBeenCalled());
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(view.container.textContent).toBe("");
  });
});
