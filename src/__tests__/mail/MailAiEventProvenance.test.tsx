/**
 * An event the mail pane's AI extract makes carries `from_mail` (decision E3):
 * the root agent's tools then serve it as someone else's text, URLs removed
 * (`services::root_mcp::event_view`). Both creation points stamp it — the
 * auto-create path and the review dialog's Save.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { MailAiMessageActions } from "../../components/mail/MailAiMessageActions";
import { setCalendarWriteHandler } from "../../lib/calendar/calendarWriteHook";
import { useCalendarStore } from "../../stores/calendar/calendar";
import { useMailStore } from "../../stores/mail";
import { useSettingsStore } from "../../stores/settings";
import type { CalendarEvent, Settings } from "../../types";
import type { MailAccount, MailHeader } from "../../types/mail";

const header = {
  id: "INBOX-7", account_id: "a1", folder_id: "INBOX", uid: 7, subject: "Kick-off",
  from: { name: "Ann", address: "ann@partner.example" }, to: [], cc: [], date: "2026-10-01T09:00:00Z",
  seen: true, flagged: false, answered: false, has_attachments: false, size: 1, preview: "",
} as unknown as MailHeader;

function account(autoCreate: boolean): MailAccount {
  return { id: "a1", label: "Me", address: "me@home.example", ai: { calendar: true, auto_create: autoCreate } } as unknown as MailAccount;
}

const created: CalendarEvent[] = [];

beforeEach(() => {
  created.length = 0;
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: { event?: CalendarEvent }) => {
    if (cmd === "mail_extract_event") {
      return { title: "Kick-off", start: "2026-10-05T10:00", end: "2026-10-05T11:00", all_day: false, location: null, confidence: 0.9 };
    }
    if (cmd === "create_event" && args.event) {
      const event = { ...args.event, id: `e${created.length + 1}` };
      created.push(event);
      return event;
    }
    return null;
  });
  setCalendarWriteHandler(async () => {});
  useSettingsStore.setState({
    settings: { mail_client: true, mail_ai_allow: true, ollama_model: "llama3:latest" } as unknown as Settings,
  });
  useCalendarStore.setState({
    events: [], tasks: [], taskColumns: [], loaded: true,
    calendars: [{ id: "cal-a", name: "Work", color: "#36c", visible: true, readonly: false }],
  });
});

afterEach(() => {
  setCalendarWriteHandler(null);
  cleanup();
});

describe("an event made from a mail", () => {
  it("is stamped with the message when it is created without review", async () => {
    useMailStore.setState({ accounts: [account(true)] });
    render(<MailAiMessageActions header={header} />);
    fireEvent.click(screen.getByText("Add to calendar (local)"));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0].from_mail).toEqual({ message_id: "INBOX-7", account_id: "a1" });
  });

  it("is stamped with the message when the review dialog saves it", async () => {
    useMailStore.setState({ accounts: [account(false)] });
    render(<MailAiMessageActions header={header} />);
    fireEvent.click(screen.getByText("Add to calendar (local)"));
    fireEvent.click(await screen.findByText("Save"));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0].title).toBe("Kick-off");
    expect(created[0].from_mail).toEqual({ message_id: "INBOX-7", account_id: "a1" });
  });
});
