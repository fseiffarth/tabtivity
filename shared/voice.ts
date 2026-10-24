// Voice text helpers shared by the phone (Chrome's Web Speech) and the
// desktop (the backend's whisper): what is heard becomes terminal input, what
// is said is an answer's prose. Pure functions only — no browser, no i18n.

/** Voice text is terminal input, so never forward terminal control bytes. */
export function sanitizeVoiceTranscript(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "go on", or German "los", said last sends the draft. Only after a word
 * boundary, so "ziellos" or a "Los Angeles" mid-draft stays text. */
const SPOKEN_SEND = /(^|[\s\p{P}])(go\s+on|los)[\s\p{P}]*$/iu;

/**
 * The draft without its spoken send, when it ends in one; `null` otherwise.
 * German "was ist los" is a question, not a send, so a "los" right after
 * "ist" stays in the draft.
 */
export function spokenSend(draft: string): string | null {
  const match = SPOKEN_SEND.exec(draft);
  if (!match) return null;
  const before = draft.slice(0, match.index);
  if (match[2].toLowerCase() === "los" && /(^|[\s\p{P}])ist$/iu.test(before.trimEnd())) return null;
  return before.replace(/[\s,;:–-]+$/u, "");
}

/** An utterance as words compared by meaning: case and punctuation ignored,
 * so "Stop, stop!" reads as `["stop", "stop"]` and "Option 2." as
 * `["option", "2"]`. */
function utteranceWords(utterance: string): string[] {
  return sanitizeVoiceTranscript(utterance)
    .toLocaleLowerCase()
    .split(" ")
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
}

const STOP_WORDS = new Set(["stop", "stopp"]);

/**
 * Whether one heard utterance is "stop" (German "stopp") said alone, once or
 * repeated. It cancels the hands-free send window and, in headset mode,
 * interrupts the voice. Applied to a single utterance, never to the draft:
 * "don't stop" or "stop the server" is text for the agent.
 */
export function isStopWord(utterance: string): boolean {
  const words = utteranceWords(utterance);
  return words.length > 0 && words.every((word) => STOP_WORDS.has(word));
}

/** Cardinals and ordinals, English and German, by the number they name.
 * German "ein" is left out: it is the article far more often than the
 * number. */
const OPTION_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  eins: 1, zwei: 2, zwo: 2, drei: 3, vier: 4, fünf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9,
};

const OPTION_ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9,
  erste: 1, zweite: 2, dritte: 3, vierte: 4, fünfte: 5, sechste: 6, siebte: 7, siebente: 7, achte: 8, neunte: 9,
};

/** Words that only ever name an option after "option" or "number": said
 * alone, "to", "too" and "for" are what a recognizer hears for every other
 * sentence's filler. */
const OPTION_HOMOPHONES: Record<string, number> = { to: 2, too: 2, for: 4 };

/** Words that say "the option" before its number. */
const OPTION_NOUNS = new Set(["option", "number", "nummer", "antwort"]);
const OPTION_ARTICLES = new Set(["the", "die", "der", "das", "den"]);
const OPTION_POLITE = new Set(["please", "bitte"]);

/** A German ordinal with its case ending: "zweiten", "erster", "drittes". */
function ordinalOf(word: string): number | undefined {
  return OPTION_ORDINALS[word] ?? OPTION_ORDINALS[word.replace(/[nrsm]$/u, "")];
}

/**
 * Which of a question card's `count` options one utterance picks, as a
 * 0-based index; `null` when it picks none. The whole utterance must be the
 * pick — "one", "option two", "Nummer 3, bitte", "the second one", "die
 * Zweite" — so a sentence that merely contains a number is never taken for
 * one. A number outside the card is no pick, and nothing is guessed at.
 */
export function matchOption(utterance: string, count: number): number | null {
  let words = utteranceWords(utterance);
  while (words.length > 0 && OPTION_POLITE.has(words[words.length - 1])) words = words.slice(0, -1);
  while (words.length > 0 && OPTION_POLITE.has(words[0])) words = words.slice(1);
  if (words.length > 0 && OPTION_ARTICLES.has(words[0])) words = words.slice(1);
  let named = false;
  if (words.length > 0 && OPTION_NOUNS.has(words[0])) {
    named = true;
    words = words.slice(1);
  }
  // "the second one": an ordinal may be followed by "one", which is then no
  // number of its own.
  if (words.length === 2 && words[1] === "one" && ordinalOf(words[0]) !== undefined) words = words.slice(0, 1);
  if (words.length !== 1) return null;
  const [word] = words;
  const number = /^\d{1,2}$/u.test(word)
    ? Number(word)
    : OPTION_NUMBERS[word] ?? ordinalOf(word) ?? (named ? OPTION_HOMOPHONES[word] : undefined);
  if (number === undefined || number < 1 || number > count) return null;
  return number - 1;
}

/**
 * An answer as it should be said: its prose, without the markup. A code block
 * is not read out symbol by symbol — `codeLabel` stands in for it — and a link
 * is its label, a table its cells.
 */
export function spokenText(markdown: string, codeLabel: string): string {
  return markdown
    .replace(/\r\n?/g, "\n")
    .replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:^[ \t]*\1[^\n]*$|(?![\s\S]))/gm, `\n${codeLabel}.\n`)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<?https?:\/\/\S+>?/g, " ")
    .replace(/^[ \t]*\|?[ \t:|-]*-{3,}[ \t:|-]*$/gm, "")
    .replace(/^[ \t]{0,3}>+[ \t]?/gm, "")
    // A heading or a list item rarely ends its own sentence, and the line
    // break that did is about to go.
    .replace(/^[ \t]*(?:#{1,6}[ \t]+|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+)(.*)$/gm,
      (_line, body: string) => (/[.!?:;,]\s*$/.test(body) || !body.trim() ? body : `${body}.`))
    // A table row is a sentence of its cells.
    .replace(/^[ \t]*\|[ \t]*(.*?)[ \t]*\|?[ \t]*$/gm, "$1.")
    .replace(/[ \t]*\|[ \t]*/g, ", ")
    .replace(/[`*_~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/(?:[,.] ?){2,}/g, ". ")
    .replace(/^[,. ]+/, "")
    .trim();
}

/** `text` in pieces of at most `max` characters, each short enough for the
 * caller's voice to speak whole: sentences, packed together while they fit,
 * and a sentence too long for one piece cut at a word. */
export function speechChunks(text: string, max: number): string[] {
  const chunks: string[] = [];
  let open = "";
  const close = () => {
    if (open) chunks.push(open);
    open = "";
  };
  for (const sentence of text.match(/[^.!?…]+[.!?…]*\s*/g) ?? []) {
    let rest = sentence.trim();
    if (!rest) continue;
    if (open && open.length + 1 + rest.length <= max) {
      open = `${open} ${rest}`;
      continue;
    }
    close();
    while (rest.length > max) {
      const space = rest.lastIndexOf(" ", max);
      const cut = space > 0 ? space : max;
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut).trim();
    }
    open = rest;
  }
  close();
  return chunks;
}
