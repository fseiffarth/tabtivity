/**
 * The per-account Autocomplete toggle (docs/mail_autocomplete_plan.md D5): the
 * one Mail AI switch that reads **on** when the account never set it, writes
 * `autocomplete: false` / `true` through the account's prefs, and is still
 * disabled while Mail AI is not resolvable. Settings row and quick tag agree.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { MailAiQuickTags, MailAiSettings } from "../../components/mail/MailAiSettings";
import { useMailStore } from "../../stores/mail";
import { useSettingsStore } from "../../stores/settings";
import type { MailAccount } from "../../types/mail";
import type { Settings } from "../../types";

const READY = { mail_client: true, mail_ai_allow: true, ollama_model: "qwen3:4b" } as unknown as Settings;
const account = (ai?: MailAccount["ai"]) => ({ id: "a1", label: "Me", address: "me@home.example", ...(ai ? { ai } : {}) }) as MailAccount;
const toggleOf = () => screen.getByText("Autocomplete while writing").closest("label")!.querySelector("input") as HTMLInputElement;

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (command: string, args: { ai?: unknown }) => (command === "mail_account_set_ai" ? { ...account(), ai: args.ai } : []));
  useSettingsStore.setState({ settings: READY });
  useMailStore.setState({ accounts: [account()] });
});
afterEach(cleanup);

describe("the Autocomplete toggle", () => {
  it("reads on for an account that never set it and turns it off with an explicit false", async () => {
    render(<MailAiSettings account={account()} />);
    expect(toggleOf().checked).toBe(true);
    fireEvent.click(toggleOf());
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("mail_account_set_ai", { accountId: "a1", ai: { autocomplete: false } }));
  });

  it("reads off for false and turns back on with true, keeping the other toggles", async () => {
    render(<MailAiSettings account={account({ autocomplete: false, summarize: true })} />);
    expect(toggleOf().checked).toBe(false);
    fireEvent.click(toggleOf());
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("mail_account_set_ai", { accountId: "a1", ai: { autocomplete: true, summarize: true } }));
  });

  it("is disabled while Mail AI cannot run, and the other toggles stay off by default", () => {
    useSettingsStore.setState({ settings: { mail_client: true } as unknown as Settings });
    render(<MailAiSettings account={account()} />);
    expect(toggleOf().disabled).toBe(true);
    const summarize = screen.getByText("Summarize a message").closest("label")?.querySelector("input");
    expect(summarize?.checked).toBe(false);
  });

  it("is a quick tag that agrees with the row", async () => {
    render(<MailAiQuickTags account={account()} />);
    const tag = screen.getByRole("button", { name: "Autocomplete" });
    expect(tag.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(tag);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("mail_account_set_ai", { accountId: "a1", ai: { autocomplete: false } }));
    cleanup();
    render(<MailAiQuickTags account={account({ autocomplete: false })} />);
    expect(screen.getByRole("button", { name: "Autocomplete" }).getAttribute("aria-pressed")).toBe("false");
  });
});
