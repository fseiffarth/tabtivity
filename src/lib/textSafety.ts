/**
 * Display-text safety primitives — pure, dependency-free, and deliberately so.
 *
 * This module exists because the *rule* and the *reach* came apart. Stripping
 * bidi and zero-width characters out of attacker-chosen text was written once,
 * for the mail client, and lived in `lib/mail.ts` — which imports
 * `@tauri-apps/api/core`. So every other feature that renders text somebody else
 * wrote either imported the whole Tauri invoke surface to get one regex, or (in
 * practice) did without: an imported `.ics` put its `SUMMARY` on screen with no
 * stripping at all, while a mail subject three panes away was cleaned.
 *
 * Keeping the helpers here, with no imports, means the pure layers can use them
 * — `lib/calendar/ics.ts` parses with no runtime and is unit-tested with none. `lib/mail.ts`
 * re-exports `stripFormatControls` so its own call sites and public API are
 * unchanged; this is the one definition behind both.
 *
 * The Rust half of the same rule is `services::web_safety::{FORMAT_CHARS,
 * strip_format_controls}`. The two lists are kept identical on purpose, and
 * `src/__tests__/security/TextSafety.test.ts` reads the Rust one out of that file and
 * fails if they drift.
 */

/**
 * Remove bidi overrides, isolates and zero-width characters from display text.
 *
 * These are what turn a filename with an embedded RLO into something that reads
 * as a harmless `.png`, an event title into one that reads as another calendar's,
 * or a machine label into one that reads as a host it is not.
 *
 * Note what this is *not*: it is not an escape, and it is not a sanitizer. The
 * text is still text, and still has to be rendered as a text node. It removes a
 * class of character whose only effect is to make a string *look* like a
 * different string.
 */
export function stripFormatControls(text: string): string {
  return text.replace(new RegExp(FORMAT_CONTROL_CLASS, "g"), "");
}

/**
 * The character class, as a source string, so the strip and the *detector* below
 * cannot come apart.
 *
 * They are two operations on one list, and writing the list twice is the same
 * mistake the module header describes between TypeScript and Rust \u2014 one copy
 * gains a character, the other silently does not, and the detector goes on
 * reporting "nothing hidden here" about text the stripper is quietly rewriting.
 */
const FORMAT_CONTROL_CLASS =
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\u00AD\\u061C\\u180E\\uFEFF]";

/**
 * Whether text contains any of them \u2014 i.e. whether [`stripFormatControls`] would
 * change it.
 *
 * The strip is deliberately silent (it runs over every imported event title and
 * every mail subject, and narrating it would be noise), which is exactly why
 * something has to be able to *ask*. `lib/calendar/icsSafety.ts` does, so that a file
 * whose titles are disguised can be reported before it is imported rather than
 * cleaned without a word.
 */
export function hasFormatControls(text: string): boolean {
  return new RegExp(FORMAT_CONTROL_CLASS).test(text);
}

const HTML_SPECIAL = /[&<>"']/;
const HTML_SPECIAL_ALL = /[&<>"']/g;

function escapeHtmlChar(c: string): string {
  switch (c) {
    case "&": return "&amp;";
    case "<": return "&lt;";
    case ">": return "&gt;";
    case '"': return "&quot;";
    case "'": return "&#39;";
    default: return c;
  }
}

/**
 * HTML-escape `s` (`& < > " '`) — the ONE escape for a text node and for a
 * quoted attribute value alike. One pass, and no pass at all for the common
 * case of nothing to escape: the highlighter calls this once per token — and,
 * for a run of prose, once per character — on every keystroke of the whole
 * document, and the old five chained `replace` calls were most of what
 * highlighting a large `.tex` file cost.
 */
export function escapeHtml(s: string): string {
  if (s.length === 1) return escapeHtmlChar(s);
  if (!HTML_SPECIAL.test(s)) return s;
  return s.replace(HTML_SPECIAL_ALL, escapeHtmlChar);
}
