/**
 * The phone's reply completion through the window (docs/mail_autocomplete_plan.md
 * D4): the sidecar asks `mail_complete` with the opaque folder and message ids
 * and a page offset; the window resolves them as the reply does, gates on the
 * phone's own two switches (mail read, reply), and hands the backend the
 * original's store key under the fixed `phone` slot. The answer carries text,
 * outcome and model, nothing else. A warm-up is answered at once.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));

import { MobileBridgeHost, mutationDomain } from "../../components/mobile/MobileBridgeHost";
import { useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";
import { MOBILE_HOST_KEY, NAMES } from "../../lib/brand";

const folder = { id: "f1", account_id: "a1", name: "Inbox", kind: "inbox", unread: 0, total: 1 };
const header = {
  id: "f1-7", account_id: "a1", folder_id: "f1", uid: 7, subject: "Slides",
  from: { name: "Ann", address: "ann@partner.example" }, to: [], cc: [], date: "2026-10-01T09:00:00Z",
  seen: true, flagged: false, answered: false, has_attachments: false, size: 1, preview: "",
};
const FOLDER_ID = "opaque:folder:f1";
const MESSAGE_ID = "opaque:message:f1-7";
const answer = { status: "ok", text: " slides for me", model: "qwen3:4b" };

function settings(host: Record<string, unknown>): Settings {
  return { [MOBILE_HOST_KEY]: host } as unknown as Settings;
}

async function ask(request: Record<string, unknown>) {
  const listener = vi.mocked(listen).mock.calls.find(([name]) => name === NAMES.mobileDesktopEvent);
  const deliver = listener![1] as (event: { payload: unknown }) => void;
  const invokeMock = vi.mocked(invoke);
  invokeMock.mockClear();
  deliver({ payload: request });
  await vi.waitFor(() => expect(invokeMock.mock.calls.some(([command]) => command === "mobile_desktop_respond")).toBe(true));
  const call = invokeMock.mock.calls.find(([command]) => command === "mobile_desktop_respond");
  return (call?.[1] as { response: Record<string, unknown> }).response;
}

const asked = (command: string) => vi.mocked(invoke).mock.calls.filter(([name]) => name === command);
const request = (extra: Record<string, unknown> = {}) => ({ type: "mail_complete", request_id: "m1", folder_id: FOLDER_ID, message_id: MESSAGE_ID, offset: 0, ...extra });

/** The window's backend: the mail index plus the two completion commands. */
function backend(overrides: Record<string, () => Promise<unknown>> = {}) {
  vi.mocked(invoke).mockImplementation((command: string, args?: unknown) => {
    if (overrides[command]) return overrides[command]();
    switch (command) {
      case "mobile_opaque_id": return Promise.resolve(`opaque:${(args as { value?: string } | undefined)?.value}`);
      case "mail_accounts_list": return Promise.resolve([{ id: "a1", label: "Me", address: "me@home.example" }]);
      case "mail_folders": return Promise.resolve([folder]);
      case "mail_headers": return Promise.resolve({ items: [header], total: 1 });
      case "mail_ai_complete": return Promise.resolve(answer);
      case "mail_ai_complete_warm": return Promise.resolve({ status: "warmed", text: null });
      case "list_agents": case "agent_schedules_list": return Promise.resolve([]);
      default: return Promise.resolve(undefined);
    }
  });
}

describe("Mobile bridge — mail_complete", () => {
  beforeEach(() => {
    backend();
    vi.mocked(listen).mockResolvedValue(() => {});
    useSettingsStore.setState({ settings: settings({ mail_reply: true }), loaded: true });
    render(<MobileBridgeHost />);
  });
  afterEach(() => cleanup());

  it("completes the draft against the original's store key in the phone slot", async () => {
    const response = await ask(request({ draft: "Thanks for the" }));
    expect(response).toEqual({ status: "mail_complete", text: " slides for me", outcome: "ok", model: "qwen3:4b" });
    expect(asked("mail_ai_complete")).toHaveLength(1);
    expect(asked("mail_ai_complete")[0][1]).toEqual({
      slot: "phone", accountId: "a1", messageId: "f1-7", subject: "", to: [], draft: "Thanks for the",
    });
  });

  it("answers a warm-up at once and runs it in the background, never completing", async () => {
    backend({ mail_ai_complete_warm: () => new Promise(() => {}) }); // never answers
    const response = await ask(request({ warm: true }));
    expect(response).toEqual({ status: "mail_complete", text: null, outcome: "warmed" });
    expect(asked("mail_ai_complete_warm")[0][1]).toEqual({ slot: "phone", accountId: "a1", messageId: "f1-7", subject: "", to: [] });
    expect(asked("mail_ai_complete")).toHaveLength(0);
  });

  it("is off, asking nothing, when replies from the phone or mail reading are off", async () => {
    useSettingsStore.setState({ settings: settings({ mail_reply: false }), loaded: true });
    expect(await ask(request({ draft: "Thanks for the" }))).toEqual({ status: "mail_complete", text: null, outcome: "off" });
    expect(await ask(request({ warm: true }))).toEqual({ status: "mail_complete", text: null, outcome: "off" });
    useSettingsStore.setState({ settings: settings({ mail_reply: true, mail_read: false }), loaded: true });
    expect(await ask(request({ draft: "Thanks for the" }))).toEqual({ status: "mail_complete", text: null, outcome: "off" });
    expect(asked("mail_headers")).toHaveLength(0);
  });

  it("skips an empty draft without resolving anything", async () => {
    expect(await ask(request({ draft: "  \n" }))).toEqual({ status: "mail_complete", text: null, outcome: "skipped" });
    expect(await ask(request())).toEqual({ status: "mail_complete", text: null, outcome: "skipped" });
    expect(asked("mail_headers")).toHaveLength(0);
  });

  it("returns the resolve error as is for an unknown folder or message", async () => {
    expect(await ask(request({ folder_id: "opaque:folder:nope", draft: "Thanks for the" }))).toMatchObject({ status: "error", code: "folder_not_found" });
    expect(await ask(request({ message_id: "opaque:message:nope", draft: "Thanks for the" }))).toMatchObject({ status: "error", code: "message_not_found" });
    expect(asked("mail_ai_complete")).toHaveLength(0);
  });

  it("passes the backend's statuses on and reads a rejected command as unavailable", async () => {
    backend({ mail_ai_complete: () => Promise.resolve({ status: "locked", text: null }) });
    expect(await ask(request({ draft: "Thanks for the" }))).toEqual({ status: "mail_complete", text: null, outcome: "locked" });
    backend({ mail_ai_complete: () => Promise.reject(new Error("join")) });
    expect(await ask(request({ draft: "Thanks for the" }))).toEqual({ status: "mail_complete", text: null, outcome: "unavailable" });
  });

  it("is not a mutation: a completion never queues behind a reply", () => {
    expect(mutationDomain("mail_complete")).toBeNull();
    expect(mutationDomain("mail_reply")).toBe("mail");
  });
});
