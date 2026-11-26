/**
 * Ghost-text completion of a mail being written (docs/mail_autocomplete_plan.md):
 * the pure rules (zone above the quote, the caret, one word), the per-account
 * gate (absent is on, `false` is off, the global switch and a Mail model are
 * still needed), and `useMailComplete` against a mocked backend: when it asks,
 * what it sends, the 60 s backoff on the statuses that say "not to be had",
 * and the slot's warm-up and release.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import {
  firstCompletionWord,
  mailAiFeatureOn,
  mailAiPrefOn,
  mailCaretCompletes,
  mailCompletionZoneEnd,
  newMailSlot,
  useMailComplete,
  type MailCompleteInput,
} from "../../lib/mail";
import { NEXT_PROMPT_COMPLETE_BACKOFF_MS, NEXT_PROMPT_COMPLETE_MS, NEXT_PROMPT_MAX_DRAFT_CHARS, windowDraft } from "../../../mobile-web/src/terminal/nextPrompt";
import { PaneVisibleContext } from "../../lib/files/fileAccess";
import type { MailAccount, MailCompleteAnswer } from "../../types/mail";
import type { Settings } from "../../types";
import { useSettingsStore } from "../../stores/settings";

const account = (ai?: MailAccount["ai"]) => ({ id: "a1", label: "Me", address: "me@home.example", ...(ai ? { ai } : {}) }) as MailAccount;
const READY = { mail_client: true, mail_ai_allow: true, ollama_model: "qwen3:4b" } as unknown as Settings;

describe("the per-account gate", () => {
  it("is on when the account never set autocomplete, off only for an explicit false", () => {
    expect(mailAiPrefOn(account(), "autocomplete")).toBe(true);
    expect(mailAiPrefOn(account({}), "autocomplete")).toBe(true);
    expect(mailAiPrefOn(account({ autocomplete: true }), "autocomplete")).toBe(true);
    expect(mailAiPrefOn(account({ autocomplete: false }), "autocomplete")).toBe(false);
    expect(mailAiPrefOn(null, "autocomplete")).toBe(false);
  });

  it("leaves every other toggle opt-in", () => {
    expect(mailAiPrefOn(account(), "formalize")).toBe(false);
    expect(mailAiPrefOn(account({ formalize: true }), "formalize")).toBe(true);
  });

  it("still needs Mail AI allowed, a Mail model and the AI switch", () => {
    expect(mailAiFeatureOn(READY, account(), "autocomplete")).toBe(true);
    expect(mailAiFeatureOn({ ...READY, mail_ai_allow: false } as Settings, account(), "autocomplete")).toBe(false);
    expect(mailAiFeatureOn({ ...READY, mail_ai_allow: undefined } as Settings, account(), "autocomplete")).toBe(false);
    expect(mailAiFeatureOn({ mail_client: true, mail_ai_allow: true } as unknown as Settings, account(), "autocomplete")).toBe(false);
    expect(mailAiFeatureOn({ ...READY, ollama_host: "http://gpu-box.example.test:11434" } as Settings, account(), "autocomplete")).toBe(false);
    expect(mailAiFeatureOn({ ...READY, ai_off: true } as unknown as Settings, account(), "autocomplete")).toBe(false);
    expect(mailAiFeatureOn(null, account(), "autocomplete")).toBe(false);
    expect(mailAiFeatureOn(READY, account({ autocomplete: false }), "autocomplete")).toBe(false);
  });
});

describe("the completion zone", () => {
  const tail = "\n\nOn Tue, Ann wrote:\n> Hi\n> there";
  const intro = "On Tue, Ann wrote:";

  it("ends where the quote the composer appended starts", () => {
    const text = `Thanks for the slides${tail}`;
    expect(mailCompletionZoneEnd(text, { tail, intro })).toBe("Thanks for the slides".length);
    // The user's own text may even repeat the quote's words above it.
    const echoed = `${intro}\n> Hi\n> there\nok${tail}`;
    expect(mailCompletionZoneEnd(echoed, { tail, intro })).toBe(echoed.length - tail.length);
  });

  it("falls back to the first quote intro or quoted line once the quote was edited", () => {
    const edited = "Thanks\nmore\n\nOn Tue, Ann wrote:\n> Hi";
    expect(mailCompletionZoneEnd(edited, { tail, intro })).toBe("Thanks\nmore\n\n".length);
    expect(mailCompletionZoneEnd("Thanks\n> quoted\nlater", { tail, intro: "" })).toBe("Thanks\n".length);
    expect(mailCompletionZoneEnd("Thanks\nno quote here", { tail, intro })).toBe("Thanks\nno quote here".length);
  });

  it("is the whole text when there is no original", () => {
    expect(mailCompletionZoneEnd("> not a quote\nhere", null)).toBe("> not a quote\nhere".length);
  });

  it("completes only a collapsed caret above the quote, at the end of its line", () => {
    const text = `Thanks for\nsecond line${tail}`;
    const zone = mailCompletionZoneEnd(text, { tail, intro });
    const at = (start: number, end = start) => mailCaretCompletes(text, { start, end }, zone);
    expect(at("Thanks for".length)).toBe(true); // line end
    expect(at("Thanks".length)).toBe(false); // mid-line
    expect(at(zone)).toBe(true); // the quote's own break follows
    expect(at(zone + 3)).toBe(false); // inside the quote
    expect(at(text.length)).toBe(false); // the end of the quote
    expect(at(2, "Thanks for".length)).toBe(false); // a selection
    expect(mailCaretCompletes("abc", { start: 3, end: 3 }, 3)).toBe(true);
  });

  it("takes one word with the space before it and the one after", () => {
    expect(firstCompletionWord(" slides for me")).toBe(" slides ");
    expect(firstCompletionWord("ide for me")).toBe("ide ");
    expect(firstCompletionWord(" end.")).toBe(" end.");
    expect(firstCompletionWord("")).toBe("");
  });

  it("windows a long draft at a line start, else a word start", () => {
    const line = "word ".repeat(100);
    const long = `${line}\n`.repeat(8);
    const windowed = windowDraft(long);
    expect(windowed.length).toBeLessThanOrEqual(NEXT_PROMPT_MAX_DRAFT_CHARS);
    expect(windowed.startsWith("word ")).toBe(true);
    expect(long.endsWith(windowed)).toBe(true);
    const oneLine = "abc ".repeat(800);
    expect(oneLine.endsWith(windowDraft(oneLine))).toBe(true);
    expect(windowDraft(oneLine).startsWith("abc ")).toBe(true);
    expect(windowDraft("short")).toBe("short");
    // No space or line to cut at, and the cut splits an emoji: the window
    // never opens on its lone low surrogate.
    const emoji = "\u{1F600}".repeat(NEXT_PROMPT_MAX_DRAFT_CHARS);
    const cut = windowDraft(`${emoji}x`);
    expect(cut.length).toBeLessThanOrEqual(NEXT_PROMPT_MAX_DRAFT_CHARS);
    const first = cut.charCodeAt(0);
    expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
    expect(cut.startsWith("\u{1F600}") && cut.endsWith("x")).toBe(true);
    expect(newMailSlot()).toMatch(/^mail-[0-9a-f]{12}$/);
  });
});

const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const calls = (command: string) => invoke.mock.calls.filter(([name]) => name === command);
const ok = (text: string | null): MailCompleteAnswer => ({ status: "ok", text, model: "qwen3:4b" });

function setup(props: Partial<MailCompleteInput> = {}, answer: (draft: string) => MailCompleteAnswer = () => ok(" slides for me"), paneVisible = true) {
  invoke.mockImplementation(async (command: string, args: { draft?: string }) => {
    if (command === "mail_ai_complete") return answer(args.draft ?? "");
    if (command === "mail_ai_complete_warm") return { status: "warmed", text: null } satisfies MailCompleteAnswer;
    return undefined;
  });
  const base: MailCompleteInput = { enabled: true, accountId: "a1", messageId: "INBOX-7", subject: "Re: Slides", to: ["ann@x.example"], draft: "", atEnd: true, ...props };
  const hook = renderHook((input: MailCompleteInput) => useMailComplete(input), {
    initialProps: base,
    wrapper: ({ children }) => <PaneVisibleContext.Provider value={paneVisible}>{children}</PaneVisibleContext.Provider>,
  });
  const update = (next: Partial<MailCompleteInput>) => {
    Object.assign(base, next);
    hook.rerender({ ...base });
  };
  return { hook, update };
}

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockReset();
  useSettingsStore.setState({ settings: READY });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useMailComplete", () => {
  it("asks once the typing rests, with the opaque original, never a body, and shows the rest", async () => {
    const { hook, update } = setup();
    update({ draft: "Thanks for the" });
    await advance(NEXT_PROMPT_COMPLETE_MS - 50);
    expect(calls("mail_ai_complete")).toHaveLength(0);
    await advance(100);
    expect(calls("mail_ai_complete")).toHaveLength(1);
    const [, args] = calls("mail_ai_complete")[0];
    expect(args).toEqual({
      slot: expect.stringMatching(/^mail-[0-9a-f]{12}$/),
      accountId: "a1",
      messageId: "INBOX-7",
      subject: "Re: Slides",
      to: ["ann@x.example"],
      draft: "Thanks for the",
    });
    expect(hook.result.current).toEqual({ text: " slides for me", model: "qwen3:4b", local: true });
    // Typing along it keeps the rest and asks nothing more.
    update({ draft: "Thanks for the slides" });
    await advance(NEXT_PROMPT_COMPLETE_MS + 100);
    expect(hook.result.current.text).toBe(" for me");
    expect(calls("mail_ai_complete")).toHaveLength(1);
  });

  it("sends a long draft windowed to its last 2000 characters", async () => {
    setup({ draft: `${"filler words here\n".repeat(200)}and then` });
    await advance(NEXT_PROMPT_COMPLETE_MS + 50);
    const draft = calls("mail_ai_complete")[0][1].draft as string;
    expect(draft.length).toBeLessThanOrEqual(NEXT_PROMPT_MAX_DRAFT_CHARS);
    expect(draft.endsWith("and then")).toBe(true);
    expect(draft.startsWith("filler")).toBe(true);
  });

  it("asks nothing with the gate off, off the line end, or in a hidden pane", async () => {
    for (const props of [{ enabled: false }, { atEnd: false }] as const) {
      const { hook } = setup({ ...props, draft: "Thanks for the" });
      await advance(NEXT_PROMPT_COMPLETE_MS * 3);
      expect(hook.result.current.text).toBe("");
      hook.unmount();
    }
    invoke.mockClear();
    setup({ draft: "Thanks for the" }, undefined, false);
    await advance(NEXT_PROMPT_COMPLETE_MS * 3);
    expect(calls("mail_ai_complete")).toHaveLength(0);
    expect(calls("mail_ai_complete_warm")).toHaveLength(0);
  });

  it.each(["off", "locked", "no_model", "refused", "not_running", "unavailable"] as const)("backs off for 60 s after %s", async (status) => {
    const { update } = setup({ draft: "Thanks for the" }, () => ({ status, text: null }));
    await advance(NEXT_PROMPT_COMPLETE_MS + 50);
    expect(calls("mail_ai_complete")).toHaveLength(1);
    update({ draft: "Thanks for the slides" });
    await advance(NEXT_PROMPT_COMPLETE_MS + 50);
    expect(calls("mail_ai_complete")).toHaveLength(1);
    await advance(NEXT_PROMPT_COMPLETE_BACKOFF_MS);
    update({ draft: "Thanks for the slides and" });
    await advance(NEXT_PROMPT_COMPLETE_MS + 50);
    expect(calls("mail_ai_complete")).toHaveLength(2);
  });

  it.each(["skipped", "busy"] as const)("does not back off after %s", async (status) => {
    const { update } = setup({ draft: "Thanks for the" }, () => ({ status, text: null }));
    await advance(NEXT_PROMPT_COMPLETE_MS + 50);
    update({ draft: "Thanks for the slides" });
    await advance(NEXT_PROMPT_COMPLETE_MS + 50);
    expect(calls("mail_ai_complete")).toHaveLength(2);
  });

  it("reads a rejected command as unavailable (a backoff, never an error)", async () => {
    const { hook, update } = setup({ draft: "Thanks for the" });
    invoke.mockImplementation(async (command: string) => {
      if (command === "mail_ai_complete") throw new Error("boom");
      return undefined;
    });
    await advance(NEXT_PROMPT_COMPLETE_MS + 50);
    expect(hook.result.current.text).toBe("");
    update({ draft: "Thanks for the slides" });
    await advance(NEXT_PROMPT_COMPLETE_MS + 50);
    expect(calls("mail_ai_complete")).toHaveLength(1);
  });

  it("warms a reply as it opens, once, and releases the slot when it closes", async () => {
    const { hook, update } = setup({ draft: "" });
    await advance(10);
    expect(calls("mail_ai_complete_warm")).toHaveLength(1);
    const slot = calls("mail_ai_complete_warm")[0][1].slot as string;
    expect(calls("mail_ai_complete_warm")[0][1]).toEqual({ slot, accountId: "a1", messageId: "INBOX-7", subject: "Re: Slides", to: ["ann@x.example"] });
    update({ draft: "Thanks for the" });
    await advance(NEXT_PROMPT_COMPLETE_MS + 50);
    expect(calls("mail_ai_complete_warm")).toHaveLength(1);
    hook.unmount();
    expect(calls("mail_ai_complete_release")).toEqual([["mail_ai_complete_release", { slot }]]);
  });

  it("warms a new mail only at its first completable draft, and releases nothing it never used", async () => {
    const { hook, update } = setup({ messageId: null, subject: "Hello", to: ["bo@x.example"], draft: "Hi" });
    await advance(100);
    expect(calls("mail_ai_complete_warm")).toHaveLength(0);
    update({ draft: "Hi Bo, thanks" });
    await advance(10);
    expect(calls("mail_ai_complete_warm")).toHaveLength(1);
    expect(calls("mail_ai_complete_warm")[0][1]).toMatchObject({ messageId: null, subject: "Hello", to: ["bo@x.example"] });
    hook.unmount();

    invoke.mockClear();
    const idle = setup({ enabled: false });
    await advance(100);
    idle.hook.unmount();
    expect(invoke).not.toHaveBeenCalled();
  });
});
