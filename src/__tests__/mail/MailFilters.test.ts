import { describe, expect, it } from "vitest";

import {
  FIELD_LABEL_KEY,
  FILTER_FIELDS,
  PROBLEM_KEY,
  addTerms,
  blankRule,
  hasTerm,
  moveRule,
  parseTermInput,
  removeTerm,
  ruleLabel,
  ruleProblems,
  toggleField,
} from "../../lib/mailFilters";
import { TRANSLATIONS } from "../../lib/i18n/all";
import type { MailFilterRule } from "../../types/mail";

/**
 * The pure half of the mail filter dialog.
 *
 * What is deliberately **not** tested here is whether a rule matches a message:
 * that lives in Rust (`services::mail_filters`) and has its own suite, and a
 * TypeScript copy of it would be the second implementation of the one thing the
 * feature must not be ambiguous about. What *is* tested is everything a user can
 * do to a rule before it gets there — because each of these has a failure mode
 * that produces a rule which saves cleanly and then never fires.
 */

function rule(over: Partial<MailFilterRule> = {}): MailFilterRule {
  return { ...blankRule(), ...over };
}

describe("term input", () => {
  it("keeps a phrase together and splits on commas and newlines", () => {
    // The whole reason this is not a whitespace split: "board meeting" is one
    // thing to watch for, and two terms would fire on every board and every
    // meeting.
    expect(parseTermInput("board meeting")).toEqual(["board meeting"]);
    expect(parseTermInput("invoice, receipt\npayment")).toEqual([
      "invoice",
      "receipt",
      "payment",
    ]);
  });

  it("drops blanks and surrounding space", () => {
    expect(parseTermInput("  invoice ,, \n  ")).toEqual(["invoice"]);
  });

  it("refuses a duplicate however it is capitalized", () => {
    // The matcher is case-insensitive, so `Invoice` beside `invoice` would be
    // one rule showing two chips that do the same thing.
    const terms = addTerms([], "invoice");
    expect(addTerms(terms, "INVOICE")).toBe(terms);
    expect(hasTerm(terms, " Invoice ")).toBe(true);
    expect(addTerms(terms, "invoice, receipt")).toEqual(["invoice", "receipt"]);
  });

  it("does not add the same new term twice in one commit", () => {
    expect(addTerms([], "invoice, Invoice")).toEqual(["invoice"]);
  });

  it("removes exactly the term that was clicked", () => {
    expect(removeTerm(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });
});

describe("searched fields", () => {
  it("toggles without reshuffling the row", () => {
    // The chips are rendered in `FILTER_FIELDS` order, so a field re-added must
    // land back in its place rather than at the end — otherwise the row dances
    // as it is edited.
    const r = rule({ fields: ["subject", "sender"] });
    const off = toggleField(r.fields, "subject");
    expect(off).toEqual(["sender"]);
    expect(toggleField(off, "subject")).toEqual(["subject", "sender"]);
  });

  it("a new rule starts on subject and sender, never on the preview", () => {
    // The preview is the field that fires on mail merely *mentioning* a word,
    // which is the fastest route to a rule the user switches off.
    expect(blankRule().fields).toEqual(["subject", "sender"]);
    expect(blankRule().mark).toBe("urgent");
    expect(blankRule().enabled).toBe(true);
    expect(blankRule().id).toBe("");
  });
});

describe("a rule that would never fire is an error", () => {
  it("names both inert cases", () => {
    expect(ruleProblems(rule({ terms: [], fields: ["subject"] }))).toEqual(["noTerms"]);
    expect(ruleProblems(rule({ terms: ["x"], fields: [] }))).toEqual(["noFields"]);
    expect(ruleProblems(rule({ terms: ["  "], fields: ["subject"] }))).toEqual(["noTerms"]);
    expect(ruleProblems(rule({ terms: ["x"], fields: ["subject"] }))).toEqual([]);
  });
});

describe("order", () => {
  it("moves a rule and leaves the rest in place", () => {
    const list = [rule({ id: "a" }), rule({ id: "b" }), rule({ id: "c" })];
    expect(moveRule(list, 2, 0).map((r) => r.id)).toEqual(["c", "a", "b"]);
    expect(moveRule(list, 0, 1).map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("is a no-op for a move that goes nowhere or off the end", () => {
    const list = [rule({ id: "a" }), rule({ id: "b" })];
    expect(moveRule(list, 1, 1)).toBe(list);
    expect(moveRule(list, 0, 5)).toBe(list);
    expect(moveRule(list, -1, 0)).toBe(list);
  });
});

describe("a rule's label", () => {
  it("prefers the name, falls back to the words, and never shows an id", () => {
    expect(ruleLabel(rule({ name: "Billing", terms: ["x"] }), "?")).toBe("Billing");
    expect(ruleLabel(rule({ name: "  ", terms: ["invoice", "receipt"] }), "?")).toBe(
      "invoice, receipt",
    );
    expect(ruleLabel(rule({ name: "", terms: ["a", "b", "c", "d"] }), "?")).toBe(
      "a, b, c …",
    );
    expect(ruleLabel(rule({ name: "", terms: [] }), "Unnamed rule")).toBe("Unnamed rule");
  });
});

describe("every key the dialog can render exists in English", () => {
  // The dialog builds no key by template — the two maps below are the reason —
  // but a renamed key would still reach the user as raw dotted text, and this is
  // the cheap check that catches it.
  it("covers both maps and the dialog's own strings", () => {
    const en = TRANSLATIONS.en as Record<string, string | undefined>;
    for (const field of FILTER_FIELDS) {
      expect(en[FIELD_LABEL_KEY[field]], FIELD_LABEL_KEY[field]).toBeTruthy();
    }
    for (const key of Object.values(PROBLEM_KEY)) {
      expect(en[key], key).toBeTruthy();
    }
    for (const key of [
      "mail.filters.open",
      "mail.filters.title",
      "mail.filters.intro",
      "mail.filters.limitLocal",
      "mail.filters.limitNew",
      "mail.filters.limitPreview",
      "mail.filters.limitFolders",
      "mail.filters.reportDry",
      "mail.filters.reportApplied",
      "mail.filters.sampleWhy",
      "mail.filters.filedNotice",
    ]) {
      expect(en[key], key).toBeTruthy();
    }
  });

  it("keeps the preview limit stated in every language that translates it", () => {
    // This is the sentence that stops "message text" being read as a full-text
    // search. A language that translated the dialog but dropped this line would
    // silently make the strongest promise the feature cannot keep.
    for (const [lang, dict] of Object.entries(TRANSLATIONS)) {
      const d = dict as Record<string, string | undefined>;
      if (!d["mail.filters.title"]) continue;
      expect(d["mail.filters.limitPreview"], lang).toBeTruthy();
      expect(d["mail.filters.limitLocal"], lang).toBeTruthy();
    }
  });
});
