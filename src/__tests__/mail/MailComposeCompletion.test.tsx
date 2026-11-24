/**
 * The composer's ghost text (docs/mail_autocomplete_plan.md): the local model's
 * continuation of the sentence being typed, drawn after the caret, taken by Tab
 * (all of it) or the right arrow (one word). It lives only in the user's own
 * text above the quoted original, with the caret at the end of its line; the
 * quote never goes as draft and the original travels as its store key only.
 * The backend is mocked.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailAccount, MailBody, MailCompleteAnswer, MailHeader } from "../../types/mail";
import type { Settings } from "../../types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { MailComposeDialog } from "../../components/mail/MailComposeDialog";
import { useSettingsStore } from "../../stores/settings";

const header = {
  id: "INBOX-7", account_id: "a1", folder_id: "INBOX", uid: 7, subject: "Slides",
  from: { name: "Ann", address: "ann@partner.example" }, to: [], cc: [], date: "2026-10-01T09:00:00Z",
  seen: true, flagged: false, answered: false, has_attachments: false, size: 1, preview: "",
} as unknown as MailHeader;
const body = { text: "Here are the slides.\nSee you Friday.", html: null, attachments: [] } as unknown as MailBody;
const READY = { mail_client: true, mail_ai_allow: true, ollama_model: "qwen3:4b" } as unknown as Settings;
const account = (ai?: MailAccount["ai"]) => ({ id: "a1", label: "Me", address: "me@home.example", ...(ai ? { ai } : {}) }) as MailAccount;

const calls = (command: string) => invoke.mock.calls.filter(([name]) => name === command);
const aiCalls = () => invoke.mock.calls.filter(([name]) => String(name).startsWith("mail_ai_complete"));
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

function backend(answer: MailCompleteAnswer = { status: "ok", text: " slides for me", model: "qwen3:4b" }) {
  invoke.mockImplementation(async (command: string) => {
    if (command === "mail_ai_complete") return answer;
    if (command === "mail_ai_complete_warm") return { status: "warmed", text: null };
    return null;
  });
}

function open(props: { ai?: MailAccount["ai"]; mode?: "reply" | "new" | "forward" } = {}) {
  const mode = props.mode ?? "reply";
  render(
    <MailComposeDialog
      embedded
      accounts={[account(props.ai)]}
      accountId="a1"
      mode={mode}
      source={mode === "new" ? undefined : { header, body }}
      onClose={() => {}}
    />,
  );
  return screen.getAllByRole("textbox").find((el) => el.classList.contains("mail-compose-body")) as HTMLTextAreaElement;
}

/** Type `typed` above whatever the box already holds below it, caret after it. */
async function typeAbove(box: HTMLTextAreaElement, typed: string, below = box.value) {
  fireEvent.change(box, { target: { value: typed + below } });
  box.setSelectionRange(typed.length, typed.length);
  fireEvent.select(box);
  await advance(500);
}

const ghost = () => screen.queryByTestId("prompt-ghost-rest")?.textContent ?? null;

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockReset();
  backend();
  useSettingsStore.setState({ settings: READY });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the composer's ghost text", () => {
  it("draws the model's continuation after the caret and asks with the typed text only", async () => {
    const box = open();
    const quote = box.value;
    expect(quote).toContain("> Here are the slides.");
    await typeAbove(box, "Thanks for the", quote);
    const [, args] = calls("mail_ai_complete")[0];
    expect(args).toMatchObject({ accountId: "a1", messageId: "INBOX-7", draft: "Thanks for the" });
    expect(JSON.stringify(args)).not.toContain("Here are the slides");
    expect(ghost()).toBe(" slides for me");
    expect(box.getAttribute("aria-description")).toContain("slides for me");
    // The quote is untouched and the ghost is display-only.
    expect(box.value).toBe(`Thanks for the${quote}`);
  });

  it("warms a reply when it opens, once", async () => {
    open();
    await advance(10);
    expect(calls("mail_ai_complete_warm")).toHaveLength(1);
    expect(calls("mail_ai_complete_warm")[0][1]).toMatchObject({ accountId: "a1", messageId: "INBOX-7", subject: "Re: Slides" });
  });

  it("takes all of it with Tab and puts the caret after it, above the quote", async () => {
    const box = open();
    const quote = box.value;
    await typeAbove(box, "Thanks for the", quote);
    fireEvent.keyDown(box, { key: "Tab" });
    expect(box.value).toBe(`Thanks for the slides for me${quote}`);
    expect(box.selectionStart).toBe("Thanks for the slides for me".length);
    expect(ghost()).toBeNull();
  });

  it("takes one word with the right arrow and keeps the rest", async () => {
    const box = open();
    const quote = box.value;
    await typeAbove(box, "Thanks for the", quote);
    fireEvent.keyDown(box, { key: "ArrowRight" });
    expect(box.value.startsWith("Thanks for the slides ")).toBe(true);
    expect(ghost()).toBe("for me");
    expect(calls("mail_ai_complete")).toHaveLength(1);
  });

  it("leaves Tab and the arrow alone with no ghost, a modifier, or the caret elsewhere", async () => {
    const box = open();
    const quote = box.value;
    fireEvent.keyDown(box, { key: "Tab" });
    expect(box.value).toBe(quote);
    await typeAbove(box, "Thanks for the", quote);
    for (const mod of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
      const keep = fireEvent.keyDown(box, { key: "Tab", ...mod });
      expect(keep).toBe(true);
    }
    expect(box.value).toBe(`Thanks for the${quote}`);
    // Moved away from the end of the typed text: the key means what it always did.
    box.setSelectionRange(3, 3);
    expect(fireEvent.keyDown(box, { key: "Tab" })).toBe(true);
    expect(box.value).toBe(`Thanks for the${quote}`);
  });

  it("asks nothing with the caret inside the quote, mid-line, or selecting", async () => {
    const box = open();
    const quote = box.value;
    await typeAbove(box, "Thanks for the", quote);
    invoke.mockClear();
    // Inside the quoted original.
    const inQuote = box.value.indexOf("Here are the slides") + "Here are the".length;
    box.setSelectionRange(inQuote, inQuote);
    fireEvent.select(box);
    await advance(2000);
    expect(ghost()).toBeNull();
    // In the middle of the typed line.
    box.setSelectionRange(6, 6);
    fireEvent.select(box);
    await advance(2000);
    expect(ghost()).toBeNull();
    // A selection.
    box.setSelectionRange(2, 9);
    fireEvent.select(box);
    await advance(2000);
    expect(ghost()).toBeNull();
    expect(calls("mail_ai_complete")).toHaveLength(0);
  });

  it("never sends the quote as draft when the caret sits above it", async () => {
    const box = open();
    const quote = box.value;
    // Three lines of the user's own text, the caret on the first.
    fireEvent.change(box, { target: { value: `Thanks for the\nline two\nline three${quote}` } });
    box.setSelectionRange("Thanks for the".length, "Thanks for the".length);
    fireEvent.select(box);
    await advance(500);
    expect(calls("mail_ai_complete")[0][1].draft).toBe("Thanks for the");
  });

  it("completes a forward above the forwarded text and a new mail anywhere", async () => {
    const forward = open({ mode: "forward" });
    expect(forward.value).toContain("Here are the slides.");
    await typeAbove(forward, "Please see the", forward.value);
    expect(calls("mail_ai_complete")[0][1]).toMatchObject({ messageId: "INBOX-7", draft: "Please see the" });
    cleanup();
    invoke.mockClear();
    backend();
    const fresh = open({ mode: "new" });
    fireEvent.change(fresh, { target: { value: "Hello Bo, thanks for" } });
    fresh.setSelectionRange(fresh.value.length, fresh.value.length);
    fireEvent.select(fresh);
    await advance(500);
    expect(calls("mail_ai_complete")[0][1]).toMatchObject({ accountId: "a1", messageId: null, draft: "Hello Bo, thanks for" });
    expect(ghost()).toBe(" slides for me");
  });

  it("asks nothing when the account turned autocomplete off, the global switch is off or no Mail model is set", async () => {
    const off = open({ ai: { autocomplete: false } });
    await typeAbove(off, "Thanks for the");
    expect(aiCalls()).toHaveLength(0);
    cleanup();

    useSettingsStore.setState({ settings: { ...READY, mail_ai_allow: false } as Settings });
    const noSwitch = open();
    await typeAbove(noSwitch, "Thanks for the");
    expect(aiCalls()).toHaveLength(0);
    cleanup();

    useSettingsStore.setState({ settings: { mail_client: true, mail_ai_allow: true } as unknown as Settings });
    const noModel = open();
    await typeAbove(noModel, "Thanks for the");
    expect(aiCalls()).toHaveLength(0);
    expect(ghost()).toBeNull();
  });

  it("shows nothing for a status that says completions are not to be had", async () => {
    backend({ status: "locked", text: null });
    const box = open();
    await typeAbove(box, "Thanks for the");
    expect(calls("mail_ai_complete")).toHaveLength(1);
    expect(ghost()).toBeNull();
  });

  it("releases the slot when the composer closes", async () => {
    const box = open();
    await typeAbove(box, "Thanks for the");
    const slot = calls("mail_ai_complete")[0][1].slot;
    cleanup();
    expect(calls("mail_ai_complete_release")).toEqual([["mail_ai_complete_release", { slot }]]);
  });
});
