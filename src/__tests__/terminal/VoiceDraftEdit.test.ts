import { beforeAll, describe, expect, it } from "vitest";
import { leadDraft } from "../../../mobile-web/src/slashCommands";
import { LANGUAGES, loadDict, translate, type Language } from "../../lib/i18n";
import { DraftVoiceHistory } from "../../lib/voice/draftEdit";
import { lastSpokenSpan, matchDraftEdit, matchStartWord, type SpokenDraftEdit } from "../../lib/voice/voiceCommands";

// Spoken corrections of the composer's draft: "Tabby scratch that", "Tabby
// replace X by Y", "Tabby correction …", "Tabby clear all", "Tabby plan".

beforeAll(async () => {
  for (const { value } of LANGUAGES) expect(await loadDict(value)).toBe(true);
});

const CLAUDE_CHIPS = ["/plan", "/goal"];
const lead = (draft: string, command: "/plan" | "/goal") => leadDraft(draft, command, CLAUDE_CHIPS);

function edit(utterance: string, lang: Language = "en"): SpokenDraftEdit {
  const found = matchDraftEdit(utterance, lang);
  if (!found) throw new Error(`no edit in "${utterance}"`);
  return found;
}

describe("the start word", () => {
  it("is the assistant's name said first, as recognizers spell it", () => {
    expect(matchStartWord("Tabby, scratch that.", "en")).toEqual({ rest: "scratch that." });
    expect(matchStartWord("Tabbi plan", "en")?.rest).toBe("plan");
    expect(matchStartWord("tavi plan", "en")?.rest).toBe("plan");
    expect(matchStartWord("Tabby", "en")).toEqual({ rest: "" });
  });

  it("is no start word further in, or as a different name", () => {
    expect(matchStartWord("ask Tabby to plan", "en")).toBeNull();
    expect(matchStartWord("Debbie plan", "en")).toBeNull();
    expect(matchStartWord("Abi plan", "de")).toBeNull();
  });

  it("is the same word in every language", () => {
    for (const { value } of LANGUAGES) expect(translate(value, "voice.startWord")).toBe("Tabby");
  });
});

describe("matchDraftEdit", () => {
  it("takes plan and goal from the command catalog's phrases", () => {
    expect(edit("Tabby plan")).toMatchObject({ kind: "prefix", command: "/plan", send: false });
    expect(edit("Tabby, plan mode.")).toMatchObject({ kind: "prefix", command: "/plan" });
    expect(edit("Tabby goal")).toMatchObject({ kind: "prefix", command: "/goal" });
    expect(edit("Tabby Ziel", "de")).toMatchObject({ kind: "prefix", command: "/goal" });
  });

  it("reads undo, clear, replace and restate", () => {
    expect(edit("Tabby, scratch that.")).toMatchObject({ kind: "undo" });
    expect(edit("Tabby clear all")).toMatchObject({ kind: "clear" });
    expect(edit("Tabby replace login with sign in.")).toMatchObject({ kind: "replace", splits: [{ from: "login", to: "sign in" }] });
    expect(edit("Tabby replace word by word")).toMatchObject({ kind: "replace", splits: [{ from: "word", to: "word" }] });
    expect(edit("Tabby correction, fix the parser.")).toMatchObject({ kind: "restate", text: "fix the parser" });
    expect(edit("Tabby streich das", "de")).toMatchObject({ kind: "undo" });
    expect(edit("Tabby ersetze Login durch Anmeldung", "de")).toMatchObject({ kind: "replace", splits: [{ from: "Login", to: "Anmeldung" }] });
    expect(edit("Tabby Korrektur, das Frontend", "de")).toMatchObject({ kind: "restate", text: "das Frontend" });
  });

  it("offers every split of an ambiguous middle word, the longest first", () => {
    expect(edit("Tabby replace meet with you with see you")).toMatchObject({
      splits: [{ from: "meet with you", to: "see you" }, { from: "meet", to: "you with see you" }],
    });
  });

  it("takes a trailing \"go on\" as a send after the edit", () => {
    expect(edit("Tabby scratch that, go on")).toMatchObject({ kind: "undo", send: true });
    expect(edit("Tabby correction fix the parser go on")).toMatchObject({ kind: "restate", text: "fix the parser", send: true });
  });

  it("falls back to the English phrases in another language", () => {
    expect(edit("Tabby scratch that", "de")).toMatchObject({ kind: "undo", lang: "en" });
  });

  it("never guesses: only a whole phrase after the start word is an edit", () => {
    expect(matchDraftEdit("replace the loop with a map", "en")).toBeNull();
    expect(matchDraftEdit("scratch that", "en")).toBeNull();
    expect(matchDraftEdit("Tabby, plan the refactor", "en")).toBeNull();
    expect(matchDraftEdit("Tabby plane", "en")).toBeNull();
    expect(matchDraftEdit("Tabby scratch that line in the parser", "en")).toBeNull();
    expect(matchDraftEdit("Tabby", "en")).toBeNull();
  });
});

describe("lastSpokenSpan", () => {
  it("finds the last place a phrase is said, case, punctuation and number words aside", () => {
    expect(lastSpokenSpan("Fix the parser. Then fix the Parser!", "the parser", "en")).toEqual({ start: 25, end: 35 });
    expect(lastSpokenSpan("open 2 files", "two files", "en")).toEqual({ start: 5, end: 12 });
    expect(lastSpokenSpan("line one\nline two", "line two", "en")).toEqual({ start: 9, end: 17 });
    expect(lastSpokenSpan("fix the login", "logout", "en")).toBeNull();
  });
});

describe("DraftVoiceHistory", () => {
  it("scratches the last dictated piece, then the one before", () => {
    const history = new DraftVoiceHistory();
    history.piece("", "fix the login", "fix the login");
    history.piece("fix the login", "fix the login and the logout", "and the logout");
    const first = history.apply(edit("Tabby scratch that"), "fix the login and the logout", lead);
    expect(first).toEqual({ draft: "fix the login", note: { key: "voice.editNote.removed", params: { text: "and the logout" } } });
    expect(history.apply(edit("Tabby scratch that"), "fix the login", lead).draft).toBe("");
    expect(history.apply(edit("Tabby scratch that"), "", lead)).toEqual({ draft: null, note: { key: "voice.editNote.nothingToUndo" } });
  });

  it("takes nothing back once the draft was typed into", () => {
    const history = new DraftVoiceHistory();
    history.piece("", "fix the login", "fix the login");
    expect(history.apply(edit("Tabby scratch that"), "fix the login now", lead)).toEqual({ draft: null, note: { key: "voice.editNote.nothingToUndo" } });
  });

  it("replaces the last place the words stand, keeping a capital, and undoes it", () => {
    const history = new DraftVoiceHistory();
    const replaced = history.apply(edit("Tabby replace fix with check"), "Fix the login, then fix the logout", lead);
    expect(replaced).toEqual({
      draft: "Fix the login, then check the logout",
      note: { key: "voice.editNote.replaced", params: { from: "fix", to: "check" } },
    });
    const capital = history.apply(edit("Tabby replace fix the login with check the login"), "Fix the login, then check the logout", lead);
    expect(capital.draft).toBe("Check the login, then check the logout");
    expect(history.apply(edit("Tabby scratch that"), "Check the login, then check the logout", lead)).toEqual({
      draft: "Fix the login, then check the logout",
      note: { key: "voice.editNote.undone" },
    });
  });

  it("picks the split whose words are in the draft, and says when none are", () => {
    const history = new DraftVoiceHistory();
    expect(history.apply(edit("Tabby replace meet with you with see you"), "I'll meet with you", lead).draft).toBe("I'll see you");
    expect(history.apply(edit("Tabby replace logout with sign out"), "fix the login", lead)).toEqual({
      draft: null,
      note: { key: "voice.editNote.notFound", params: { text: "logout" } },
    });
  });

  it("says the last piece again on a correction, and adds the words when there is none", () => {
    const history = new DraftVoiceHistory();
    history.piece("fix the login", "fix the login in the backend", "in the backend");
    const restated = history.apply(edit("Tabby correction in the frontend"), "fix the login in the backend", lead);
    expect(restated).toEqual({ draft: "fix the login in the frontend", note: { key: "voice.editNote.restated", params: { text: "in the frontend" } } });
    expect(history.apply(edit("Tabby scratch that"), "fix the login in the frontend", lead).draft).toBe("fix the login");
    const fresh = new DraftVoiceHistory();
    expect(fresh.apply(edit("Tabby correction add a test"), "typed by hand", lead)).toEqual({
      draft: "typed by hand add a test",
      note: { key: "voice.editNote.added", params: { text: "add a test" } },
    });
  });

  it("clears the draft, and brings it back", () => {
    const history = new DraftVoiceHistory();
    expect(history.apply(edit("Tabby clear all"), "fix the login", lead)).toEqual({ draft: "", note: { key: "voice.editNote.cleared" } });
    expect(history.apply(edit("Tabby scratch that"), "", lead).draft).toBe("fix the login");
    expect(history.apply(edit("Tabby clear all"), "  ", lead)).toEqual({ draft: null, note: { key: "voice.editNote.empty" } });
  });

  it("leads the draft with /plan or /goal as the chips do, and only where the agent has them", () => {
    const history = new DraftVoiceHistory();
    expect(history.apply(edit("Tabby plan"), "fix the login", lead)).toEqual({
      draft: "/plan fix the login",
      note: { key: "voice.editNote.prefix", params: { command: "/plan" } },
    });
    // Said again it stays on; a goal replaces it.
    expect(history.apply(edit("Tabby plan"), "/plan fix the login", lead).draft).toBeNull();
    expect(history.apply(edit("Tabby goal"), "/plan fix the login", lead).draft).toBe("/goal fix the login");
    expect(history.apply(edit("Tabby scratch that"), "/goal fix the login", lead).draft).toBe("/plan fix the login");
    const gemini = (draft: string, command: "/plan" | "/goal") => leadDraft(draft, command, ["/plan"]);
    expect(history.apply(edit("Tabby goal"), "fix it", gemini)).toEqual({
      draft: null,
      note: { key: "voice.editNote.noPrefix", params: { command: "/goal" } },
    });
  });
});
