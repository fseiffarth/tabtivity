import { matchOption, sanitizeVoiceTranscript } from "../../../shared/voice";
import { fuzzyMatch } from "../fuzzy";
import { translate, type Language, type TranslationKey } from "../i18n";

// Spoken commands, matched without a model (docs/phone_voice_plan.md step 1,
// docs/voice_navigation_plan.md step 2): one matcher for the phone's
// hands-free session and the desktop's push-to-talk. Pure — no store, no
// Tauri, no React — because the phone imports it; it reads its phrases
// through `translate` alone, in the language the caller names (the phone's
// speech language, which may differ from the UI's: `loadDict` that language
// first, or the English templates stand in).
//
// What a command may carry comes only from the caller's live lists (projects,
// tabs, agents, models …), never from free text, except the dictation slot
// `{text}` (a message, a mail reply, a to-do), which the caller reads back
// before anything is sent. Nothing here decides what a command may do; the
// dispatchers own the risk table.

// ---------------------------------------------------------------- catalog

/** What a template's `{slot}` stands for. `n` is a number (digits or a number
 * word), `text` is dictation (the rest of the utterance, raw), every other
 * slot is a name from the matching live list. */
export type VoiceSlot =
  | "project"
  | "box"
  | "tab"
  | "agent"
  | "model"
  | "effort"
  | "card"
  | "localModel"
  | "n"
  | "text";

/** The slots resolved against a live list. */
export type VoiceNameSlot = Exclude<VoiceSlot, "n" | "text">;

interface VoiceCommandSpec {
  /** Slots every template of the command has. */
  readonly slots?: readonly VoiceSlot[];
  /** Slots only some templates have ("new Claude tab [in Alpha]"). */
  readonly optional?: readonly VoiceSlot[];
}

/**
 * Every spoken command, by the id both dispatchers (phone `handsFreeDispatch`,
 * desktop `appCommands`) switch on, with the slots its `voice.cmd.<id>`
 * templates may hold. A dispatcher may leave a command out (the phone has no
 * side panel); it never invents one. Adding a command: a row here and a
 * `voice.cmd.<id>` key in all five dictionaries (tsc fails without the English
 * one; the tests check the slots of every language's templates).
 */
export const VOICE_COMMANDS = {
  // Places
  projects: {},
  root: {},
  openProject: { slots: ["project"] },
  openBox: { slots: ["box"] },
  showOnDesktop: { slots: ["project"] },
  // What needs me
  whatsWaiting: {},
  whatsWorking: {},
  nextWaiting: {},
  nextWorking: {},
  nextDone: {},
  status: {},
  // Tabs
  tabNumber: { slots: ["n"] },
  agentTab: { slots: ["agent"], optional: ["n"] },
  goToTab: { slots: ["tab"] },
  nextTab: {},
  previousTab: {},
  newAgentTab: { slots: ["agent"], optional: ["project"] },
  newShell: { optional: ["project"] },
  newMonitor: {},
  closeTab: {},
  reopenTab: {},
  // A spoken list ("what's waiting" read out in pages)
  listNext: {},
  listBack: {},
  listPick: {},
  // Talking to an agent
  tell: { slots: ["agent", "text"] },
  dictate: {},
  stop: {},
  stopAgent: {},
  model: { slots: ["model"] },
  effort: { slots: ["effort"] },
  plan: {},
  goal: {},
  clearConversation: {},
  undoClear: {},
  // Apps
  openMail: {},
  nextMail: {},
  readMail: {},
  flagMail: {},
  markRead: {},
  replyMail: { slots: ["text"] },
  openCalendar: {},
  today: {},
  nextEvent: {},
  newEvent: { slots: ["text"] },
  openTodo: {},
  newTodo: { slots: ["text"] },
  doneTodo: { slots: ["card"] },
  closeApp: {},
  // Local models
  loadModel: { slots: ["localModel"] },
  unloadModel: { slots: ["localModel"] },
  // Desktop views
  files: {},
  sidePanel: {},
  settings: {},
} as const satisfies Record<string, VoiceCommandSpec>;

export type VoiceCommandId = keyof typeof VOICE_COMMANDS;

export const VOICE_COMMAND_IDS = Object.keys(VOICE_COMMANDS) as VoiceCommandId[];

/** The commands that act on an answer being read aloud (`voice.read.<id>`).
 * Each is the whole utterance, so dictation that contains the word never
 * moves the reading. */
export const VOICE_READ_IDS = [
  "next",
  "nextAnswer",
  "back",
  "repeat",
  "faster",
  "slower",
  "summary",
  "readAll",
  "readCode",
  "where",
  "stop",
] as const;

export type VoiceReadId = (typeof VOICE_READ_IDS)[number];

// ---------------------------------------------------------------- types

/** One entry of a live list. `id` is the caller's own (an opaque tab or
 * project id) and comes back untouched; `name` is what is said; `aliases` are
 * other ways to say it (a short name, a recognizer's usual mishearing). */
export interface VoiceListItem {
  readonly id: string;
  readonly name: string;
  readonly aliases?: readonly string[];
}

/** The live lists a slot is resolved against. A missing list matches nothing. */
export interface VoiceLists {
  readonly projects?: readonly VoiceListItem[];
  readonly boxes?: readonly VoiceListItem[];
  /** The current scope's tabs, by title. */
  readonly tabs?: readonly VoiceListItem[];
  /** Agent names, built-in and custom (see `BUILTIN_AGENT_ALIASES`). */
  readonly agents?: readonly VoiceListItem[];
  readonly models?: readonly VoiceListItem[];
  readonly efforts?: readonly VoiceListItem[];
  /** To-do cards, by title. */
  readonly cards?: readonly VoiceListItem[];
  readonly localModels?: readonly VoiceListItem[];
}

const SLOT_LIST: Record<VoiceNameSlot, keyof VoiceLists> = {
  project: "projects",
  box: "boxes",
  tab: "tabs",
  agent: "agents",
  model: "models",
  effort: "efforts",
  card: "cards",
  localModel: "localModels",
};

interface SlotValues {
  project: VoiceListItem;
  box: VoiceListItem;
  tab: VoiceListItem;
  agent: VoiceListItem;
  model: VoiceListItem;
  effort: VoiceListItem;
  card: VoiceListItem;
  localModel: VoiceListItem;
  /** 1–99. */
  n: number;
  /** Dictation as heard (sanitized, punctuation kept), never empty. */
  text: string;
}

type Spec<Id extends VoiceCommandId> = (typeof VOICE_COMMANDS)[Id];
type RequiredSlots<Id extends VoiceCommandId> =
  Spec<Id> extends { readonly slots: readonly (infer S extends VoiceSlot)[] } ? S : never;
type OptionalSlots<Id extends VoiceCommandId> =
  Spec<Id> extends { readonly optional: readonly (infer S extends VoiceSlot)[] } ? S : never;

/** A command's arguments, typed by its id: `openProject` has `project`,
 * `newAgentTab` has `agent` and maybe `project`, `stop` has none. */
export type VoiceArgs<Id extends VoiceCommandId> = { [K in RequiredSlots<Id>]: SlotValues[K] } & {
  [K in OptionalSlots<Id>]?: SlotValues[K];
};

/** A matched command. Narrow on `id` to read its `args`. */
export type VoiceCommand = {
  [Id in VoiceCommandId]: {
    kind: "command";
    id: Id;
    args: VoiceArgs<Id>;
    /** The utterance began with the command word. */
    heardCommandWord: boolean;
  };
}[VoiceCommandId];

/** Two or three names were too close to tell apart: ask back
 * (`ambiguityLine`), then `resolveAmbiguity` with the answer. */
export interface VoiceAmbiguity {
  kind: "ambiguous";
  id: VoiceCommandId;
  slot: VoiceNameSlot;
  /** Best first; 2–3 of them. */
  candidates: VoiceListItem[];
  /** The command's other slots, already resolved. */
  partial: Readonly<Partial<Record<VoiceSlot, VoiceListItem | number | string>>>;
  heardCommandWord: boolean;
}

/** Why an utterance is no command:
 * - `noCommandWord`: the command word was required and not said first —
 *   dictation, not a failed command;
 * - `commandWordOnly`: the command word and nothing after it;
 * - `unknownName`: a command's words, with a name no live list has;
 * - `unmatched`: no command's words. */
export type VoiceNothingReason = "noCommandWord" | "commandWordOnly" | "unknownName" | "unmatched";

export interface VoiceNothing {
  kind: "nothing";
  reason: VoiceNothingReason;
  heardCommandWord: boolean;
}

export type VoiceMatch = VoiceCommand | VoiceAmbiguity | VoiceNothing;

export interface VoiceMatchOptions {
  /** The owner's personal command word (decision 5). When set it replaces
   * the dictionary's `voice.commandWord`, which then no longer counts. */
  commandWord?: string | null;
  /** `true` (the default): an utterance without the command word in front
   * is `noCommandWord`. `false` in a follow-up window and for push-to-talk,
   * where every utterance is meant as a command; a command word said anyway
   * is still taken off. */
  requireCommandWord?: boolean;
}

// ---------------------------------------------------------------- words

/** Lower case, accents off ("nächste" → "nachste", "schließen" →
 * "schliessen"), so a recognizer's spelling and the dictionary's agree. */
function fold(word: string): string {
  return word.toLocaleLowerCase().replace(/ß/g, "ss").normalize("NFD").replace(/\p{M}/gu, "");
}

/** Number words per language, by the number they name. Articles that double
 * as "one" are left out (de "ein", es "una", it "un"/"una") — French "un" is
 * kept, since "onglet un" is how a tab is named, and the templates are
 * normalized the same way, so "un nouvel onglet" still matches. */
const CARDINALS: Record<Language, readonly string[]> = {
  en: ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"],
  de: ["eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn",
    "elf", "zwölf", "dreizehn", "vierzehn", "fünfzehn", "sechzehn", "siebzehn", "achtzehn", "neunzehn", "zwanzig"],
  es: ["uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez",
    "once", "doce", "trece", "catorce", "quince", "dieciséis", "diecisiete", "dieciocho", "diecinueve", "veinte"],
  // 17–19 are two words in French ("dix-sept"); a tab that far down is said by digit.
  fr: ["un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix",
    "onze", "douze", "treize", "quatorze", "quinze", "seize"],
  it: ["uno", "due", "tre", "quattro", "cinque", "sei", "sette", "otto", "nove", "dieci",
    "undici", "dodici", "tredici", "quattordici", "quindici", "sedici", "diciassette", "diciotto", "diciannove", "venti"],
};

/** Ordinals 1–10, each with its forms. */
const ORDINALS: Record<Language, readonly (readonly string[])[]> = {
  en: [["first"], ["second"], ["third"], ["fourth"], ["fifth"], ["sixth"], ["seventh"], ["eighth"], ["ninth"], ["tenth"]],
  de: [["erste"], ["zweite"], ["dritte"], ["vierte"], ["fünfte"], ["sechste"], ["siebte", "siebente"], ["achte"], ["neunte"], ["zehnte"]]
    .map((forms) => forms.flatMap((form) => [form, `${form}n`, `${form}r`, `${form}s`, `${form}m`])),
  es: [["primero", "primera", "primer"], ["segundo", "segunda"], ["tercero", "tercera", "tercer"], ["cuarto", "cuarta"],
    ["quinto", "quinta"], ["sexto", "sexta"], ["séptimo", "séptima"], ["octavo", "octava"], ["noveno", "novena"], ["décimo", "décima"]],
  fr: [["premier", "première"], ["deuxième", "second", "seconde"], ["troisième"], ["quatrième"], ["cinquième"],
    ["sixième"], ["septième"], ["huitième"], ["neuvième"], ["dixième"]],
  it: [["primo", "prima"], ["secondo", "seconda"], ["terzo", "terza"], ["quarto", "quarta"], ["quinto", "quinta"],
    ["sesto", "sesta"], ["settimo", "settima"], ["ottavo", "ottava"], ["nono", "nona"], ["decimo", "decima"]],
};

const EXTRA_NUMBERS: Partial<Record<Language, Record<string, number>>> = {
  de: { zwo: 2 },
  fr: { vingt: 20 },
};

const NUMBER_WORDS: Record<Language, ReadonlyMap<string, number>> = (() => {
  const out = {} as Record<Language, Map<string, number>>;
  for (const lang of Object.keys(CARDINALS) as Language[]) {
    const map = new Map<string, number>();
    CARDINALS[lang].forEach((word, index) => map.set(fold(word), index + 1));
    ORDINALS[lang].forEach((forms, index) => forms.forEach((form) => map.set(fold(form), index + 1)));
    for (const [word, value] of Object.entries(EXTRA_NUMBERS[lang] ?? {})) map.set(fold(word), value);
    out[lang] = map;
  }
  return out;
})();

/** "2", "02", "2nd", "2e", "2ème", "2o", "2a" → "2". */
const DIGITS = /^(\d{1,3})(?:st|nd|rd|th|e|er|eme|o|a|te|ter|ten)?$/u;

function numberWord(word: string, lang: Language): string {
  const digits = DIGITS.exec(word);
  if (digits) return String(Number(digits[1]));
  const value = NUMBER_WORDS[lang].get(word);
  return value === undefined ? word : String(value);
}

/** Polite words said at either end, as normalized word runs. */
const POLITE: Record<Language, readonly string[]> = {
  en: ["please"],
  de: ["bitte"],
  es: ["por favor"],
  fr: ["s il te plait", "s il vous plait"],
  it: ["per favore"],
};

interface Token {
  /** Folded, number words as digits. */
  norm: string;
  /** Where the word stands in the sanitized text. */
  start: number;
  end: number;
}

interface Words {
  text: string;
  tokens: Token[];
}

/** An utterance as words compared by meaning: case, accents and punctuation
 * aside, apostrophes and hyphens split words ("what's" → "what s", "l'onglet"
 * → "l onglet", "to-do" → "to do"), number words as digits. */
function words(utterance: string, lang: Language): Words {
  const text = sanitizeVoiceTranscript(utterance);
  const tokens: Token[] = [];
  for (const found of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const start = found.index ?? 0;
    tokens.push({ norm: numberWord(fold(found[0]), lang), start, end: start + found[0].length });
  }
  return { text, tokens };
}

function norms(text: string, lang: Language): string[] {
  return words(text, lang).tokens.map((token) => token.norm);
}

function startsWith(tokens: readonly Token[], run: readonly string[], at: number): boolean {
  return run.length > 0 && run.every((word, index) => tokens[at + index]?.norm === word);
}

/** The tokens without polite words at either end. */
function withoutPolite(tokens: Token[], lang: Language): Token[] {
  let out = tokens;
  for (const phrase of POLITE[lang]) {
    const run = phrase.split(" ");
    if (startsWith(out, run, 0)) out = out.slice(run.length);
    if (out.length > run.length && startsWith(out, run, out.length - run.length)) out = out.slice(0, -run.length);
  }
  return out;
}

// ---------------------------------------------------------------- the command word

/** The dictionary's command word (`voice.commandWord`, the app's name by
 * default). The owner's personal one, when set, is never spoken back. */
export function defaultCommandWord(lang: Language): string {
  return translate(lang, "voice.commandWord");
}

/** The command word as one run of letters: "Tab Tivity" said as two words
 * still counts. */
function commandWordKey(lang: Language, personal: string | null | undefined): string {
  const own = personal ? norms(personal, lang).join("") : "";
  return own || norms(defaultCommandWord(lang), lang).join("");
}

/** How many leading tokens the command word takes, 0 when it is not first.
 * An exact match of the normalized words, no fuzzy margin (decision 5). */
function commandWordLength(tokens: readonly Token[], key: string): number {
  if (!key) return 0;
  let joined = "";
  for (let index = 0; index < Math.min(tokens.length, 4); index++) {
    joined += tokens[index].norm;
    if (joined === key) return index + 1;
    if (!key.startsWith(joined)) return 0;
  }
  return 0;
}

/** Whether `utterance` begins with the command word (the personal one when
 * set): while dictating, such an utterance goes to `match`, never into the
 * draft. */
export function hasCommandWord(utterance: string, lang: Language, commandWord?: string | null): boolean {
  return commandWordLength(words(utterance, lang).tokens, commandWordKey(lang, commandWord)) > 0;
}

// ---------------------------------------------------------------- names

/** The score a name must reach. "Delta" heard for "Beta" (0.6) is below it;
 * "bita" for "Beta" (0.75) and "alfa" for "Alpha" are above. */
export const NAME_FLOOR = 0.65;
/** How far the best name must lead the runner-up, or the matcher asks back. */
export const NAME_MARGIN = 0.15;
/** A name slot spans at most this many words. */
const MAX_NAME_WORDS = 8;

/** Spellings a recognizer swaps freely: "alfa"/"alpha", "Kathi"/"Kati",
 * "Gama"/"Gamma". Only for scoring names, never for templates. */
function phonetic(word: string): string {
  return word
    .replace(/ph/g, "f")
    .replace(/th/g, "t")
    .replace(/ck/g, "k")
    .replace(/c(?=[aou])/g, "k")
    .replace(/qu/g, "k")
    .replace(/y/g, "i")
    .replace(/(.)\1+/g, "$1");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 0 : 1 - levenshtein(a, b) / longest;
}

/** A heard prefix of a longer name ("alpha" for "Alpha Centauri") scores
 * between these, more the more of the name it covers: it stands when the name
 * is the only close one, and loses to a name said whole. */
const PREFIX_BASE = 0.6;
const PREFIX_SPAN = 0.2;

/** How well heard words name one spoken form, 0–1: the edit distance per
 * word (equal word counts), over the joined letters (a name heard split or
 * run together), or as a word prefix of a longer name. */
function formScore(heard: readonly string[], form: readonly string[]): number {
  if (!heard.length || !form.length) return 0;
  const h = heard.map(phonetic);
  const f = form.map(phonetic);
  let best = similarity(h.join(""), f.join(""));
  if (h.length === f.length) {
    let weighted = 0;
    let letters = 0;
    h.forEach((word, index) => {
      const size = Math.max(word.length, f[index].length);
      weighted += similarity(word, f[index]) * size;
      letters += size;
    });
    best = Math.max(best, letters ? weighted / letters : 0);
  }
  if (h.length < f.length && h.every((word, index) => similarity(word, f[index]) >= 0.8)) {
    const share = h.join("").length / f.join("").length;
    best = Math.max(best, PREFIX_BASE + PREFIX_SPAN * share);
  }
  return best;
}

interface Scored {
  item: VoiceListItem;
  score: number;
  /** `fuzzyMatch`'s subsequence score, to order equal scores. */
  tie: number;
}

type Resolution =
  | { kind: "one"; item: VoiceListItem; score: number }
  | { kind: "ambiguous"; candidates: VoiceListItem[]; score: number }
  | { kind: "none" };

function scoreItem(heard: readonly string[], item: VoiceListItem, lang: Language): Scored {
  let score = 0;
  for (const form of [item.name, ...(item.aliases ?? [])]) score = Math.max(score, formScore(heard, norms(form, lang)));
  return { item, score, tie: fuzzyMatch(heard.join(" "), norms(item.name, lang).join(" "))?.score ?? 0 };
}

/** The list entry heard words name: one above the floor and clearly ahead,
 * 2–3 too close to call, or none. */
function resolveName(heard: readonly string[], list: readonly VoiceListItem[] | undefined, lang: Language): Resolution {
  if (!list?.length) return { kind: "none" };
  const scored = list
    .map((item) => scoreItem(heard, item, lang))
    .filter((entry) => entry.score >= NAME_FLOOR)
    .sort((a, b) => b.score - a.score || b.tie - a.tie || a.item.name.length - b.item.name.length);
  if (!scored.length) return { kind: "none" };
  const close = scored.filter((entry) => scored[0].score - entry.score < NAME_MARGIN);
  if (close.length === 1) return { kind: "one", item: close[0].item, score: close[0].score };
  return { kind: "ambiguous", candidates: close.slice(0, 3).map((entry) => entry.item), score: close[0].score };
}

// ---------------------------------------------------------------- templates

type Part = { lit: string } | { slot: VoiceSlot };

interface Template {
  id: VoiceCommandId;
  parts: Part[];
  literals: number;
}

const SLOT_NAMES = new Set<string>(["project", "box", "tab", "agent", "model", "effort", "card", "localModel", "n", "text"]);

function isSlot(name: string): name is VoiceSlot {
  return SLOT_NAMES.has(name);
}

function commandKey(id: VoiceCommandId): TranslationKey {
  const key: `voice.cmd.${VoiceCommandId}` = `voice.cmd.${id}`;
  return key;
}

function readKey(id: VoiceReadId): TranslationKey {
  const key: `voice.read.${VoiceReadId}` = `voice.read.${id}`;
  return key;
}

/** One `|`-separated template as parts: literal words (normalized as an
 * utterance is) and `{slot}`s. An unknown `{name}` is a literal that never
 * matches, so a typo shows in the tests, not as a wrong command. */
function parseTemplate(template: string, lang: Language): Part[] {
  const parts: Part[] = [];
  for (const piece of template.split(/(\{\w+\})/)) {
    const slot = /^\{(\w+)\}$/.exec(piece);
    if (slot) {
      parts.push(isSlot(slot[1]) ? { slot: slot[1] } : { lit: `{${slot[1]}}` });
      continue;
    }
    for (const word of norms(piece, lang)) parts.push({ lit: word });
  }
  return parts;
}

function splitTemplates(raw: string): string[] {
  return raw.split("|").map((template) => template.trim()).filter(Boolean);
}

const compiled = new Map<Language, { raw: string; templates: Template[] }>();

/** The language's templates, compiled once per dictionary text (a lazy
 * dictionary landing changes the text, and so recompiles). */
function templatesFor(lang: Language): Template[] {
  const sources = VOICE_COMMAND_IDS.map((id) => translate(lang, commandKey(id)));
  const raw = sources.join("\n");
  const cached = compiled.get(lang);
  if (cached?.raw === raw) return cached.templates;
  const templates: Template[] = [];
  VOICE_COMMAND_IDS.forEach((id, index) => {
    for (const template of splitTemplates(sources[index])) {
      const parts = parseTemplate(template, lang);
      templates.push({ id, parts, literals: parts.filter((part) => "lit" in part).length });
    }
  });
  compiled.set(lang, { raw, templates });
  return templates;
}

type Spans = Map<VoiceSlot, [number, number]>;

/** Every way `tokens` fills the template whole: literals word for word, each
 * slot at least one word, `{n}` exactly one number, `{text}` the rest. */
function fillings(parts: readonly Part[], tokens: readonly Token[]): Spans[] {
  const out: Spans[] = [];
  const walk = (pi: number, ti: number, spans: Spans) => {
    if (pi === parts.length) {
      if (ti === tokens.length) out.push(new Map(spans));
      return;
    }
    const part = parts[pi];
    if ("lit" in part) {
      if (tokens[ti]?.norm === part.lit) walk(pi + 1, ti + 1, spans);
      return;
    }
    const left = tokens.length - ti;
    const needAfter = parts.length - pi - 1;
    if (left - needAfter < 1) return;
    if (part.slot === "n") {
      if (!/^\d+$/.test(tokens[ti].norm)) return;
      spans.set("n", [ti, ti + 1]);
      walk(pi + 1, ti + 1, spans);
      spans.delete("n");
      return;
    }
    if (part.slot === "text") {
      if (needAfter !== 0) return;
      spans.set("text", [ti, tokens.length]);
      walk(pi + 1, tokens.length, spans);
      spans.delete("text");
      return;
    }
    for (let size = 1; size <= Math.min(MAX_NAME_WORDS, left - needAfter); size++) {
      spans.set(part.slot, [ti, ti + size]);
      walk(pi + 1, ti + size, spans);
      spans.delete(part.slot);
    }
  };
  walk(0, 0, new Map());
  return out;
}

interface Parse {
  template: Template;
  values: Partial<Record<VoiceSlot, VoiceListItem | number | string>>;
  ambiguous?: { slot: VoiceNameSlot; candidates: VoiceListItem[] };
  score: number;
}

/** The dictation a `{text}` slot holds, as heard: from its first word to its
 * last, with the punctuation right after it ("what is this?"). */
function rawText(source: Words, tokens: readonly Token[], [from, to]: [number, number]): string {
  const start = tokens[from].start;
  const end = tokens[to - 1].end;
  const trailing = /^[^\s\p{L}\p{N}]*/u.exec(source.text.slice(end))?.[0] ?? "";
  return source.text.slice(start, end + trailing.length).replace(/[\s,;:–-]+$/u, "");
}

function evaluate(template: Template, spans: Spans, source: Words, tokens: readonly Token[], lists: VoiceLists, lang: Language): Parse | null {
  const values: Parse["values"] = {};
  let ambiguous: Parse["ambiguous"];
  let score = 1;
  for (const [slot, span] of spans) {
    const said = tokens.slice(span[0], span[1]);
    if (slot === "n") {
      const value = Number(said[0].norm);
      if (value < 1 || value > 99) return null;
      values.n = value;
    } else if (slot === "text") {
      const text = rawText(source, tokens, span);
      if (!text) return null;
      values.text = text;
    } else {
      const found = resolveName(said.map((token) => token.norm), lists[SLOT_LIST[slot]], lang);
      if (found.kind === "none") return null;
      score = Math.min(score, found.score);
      if (found.kind === "one") values[slot] = found.item;
      else ambiguous ??= { slot, candidates: found.candidates };
    }
  }
  return { template, values, ambiguous, score };
}

function build(id: VoiceCommandId, values: Parse["values"], heardCommandWord: boolean): VoiceCommand {
  // The parse filled exactly the template's slots, and the tests hold every
  // template to its command's spec, so the args have the id's shape.
  return { kind: "command", id, args: { ...values }, heardCommandWord } as VoiceCommand;
}

/**
 * What one utterance commands, in `lang`'s phrases (`voice.cmd.<id>`):
 *
 * 1. normalize (case, accents, punctuation, number words as digits);
 * 2. take off the command word — the personal one when `opts.commandWord` is
 *    set, else the dictionary's — matched exactly; without it, and with
 *    `requireCommandWord` (the default), the utterance is dictation;
 * 3. the rest must be one template **whole**: dictation that merely contains
 *    a command's words is no command;
 * 4. each name slot is resolved against its live list by the spoken-name
 *    score, above `NAME_FLOOR` and `NAME_MARGIN` ahead of the runner-up;
 *    closer than that is an ambiguity of 2–3 candidates.
 *
 * Of several templates that fit, the one with more literal words wins ("new
 * monitor" over "new {agent}"), then the better name score, then the
 * catalog's order.
 */
export function match(text: string, lang: Language, lists: VoiceLists = {}, opts: VoiceMatchOptions = {}): VoiceMatch {
  const source = words(text, lang);
  let tokens = source.tokens;
  const skip = commandWordLength(tokens, commandWordKey(lang, opts.commandWord));
  const heardCommandWord = skip > 0;
  if (!heardCommandWord && (opts.requireCommandWord ?? true)) {
    return { kind: "nothing", reason: "noCommandWord", heardCommandWord };
  }
  tokens = withoutPolite(tokens.slice(skip), lang);
  if (!tokens.length) {
    return { kind: "nothing", reason: heardCommandWord ? "commandWordOnly" : "unmatched", heardCommandWord };
  }
  let best: Parse | null = null;
  let literalFit = false;
  for (const template of templatesFor(lang)) {
    if (template.literals > tokens.length) continue;
    for (const spans of fillings(template.parts, tokens)) {
      // A bare "{agent}" fits any short utterance; only a template's own
      // words make a name the thing that was not understood.
      if (template.literals > 0) literalFit = true;
      const parse = evaluate(template, spans, source, tokens, lists, lang);
      if (!parse) continue;
      if (
        !best ||
        parse.template.literals > best.template.literals ||
        (parse.template.literals === best.template.literals &&
          (parse.score > best.score || (parse.score === best.score && !parse.ambiguous && !!best.ambiguous)))
      ) {
        best = parse;
      }
    }
  }
  if (!best) return { kind: "nothing", reason: literalFit ? "unknownName" : "unmatched", heardCommandWord };
  if (best.ambiguous) {
    return {
      kind: "ambiguous",
      id: best.template.id,
      slot: best.ambiguous.slot,
      candidates: best.ambiguous.candidates,
      partial: best.values,
      heardCommandWord,
    };
  }
  return build(best.template.id, best.values, heardCommandWord);
}

/** Which candidate an answer to "Alpha or Alpha Two?" picks: its number ("one",
 * "option two", "the second", in `lang`), or its name, by the same score as a
 * slot. `null` when it picks none — ask again or give up. */
export function resolveAmbiguity(answer: string, ambiguity: VoiceAmbiguity, lang: Language): VoiceCommand | null {
  const tokens = withoutPolite(words(answer, lang).tokens, lang).map((token) => token.norm);
  const { candidates } = ambiguity;
  if (!tokens.length) return null;
  // The name first: "Alpha Two" is a name, not "two".
  const found = resolveName(tokens, candidates, lang);
  let pick = found.kind === "one" ? found.item : undefined;
  if (!pick) {
    const option = matchOption(answer, candidates.length);
    const last = tokens[tokens.length - 1];
    // "two", "option two" (English, German); "la seconda", "le deuxième".
    if (option !== null) pick = candidates[option];
    else if (tokens.length <= 2 && /^\d+$/.test(last)) pick = candidates[Number(last) - 1];
  }
  if (!pick) return null;
  return build(ambiguity.id, { ...ambiguity.partial, [ambiguity.slot]: pick }, ambiguity.heardCommandWord);
}

// ---------------------------------------------------------------- reading, confirming

function alternatives(key: TranslationKey, lang: Language): string[] {
  return splitTemplates(translate(lang, key)).map((phrase) => norms(phrase, lang).join(" "));
}

/** What an utterance does to an answer being read aloud, or `null`. The whole
 * utterance must be the command (the command word in front is allowed), so
 * "next, fix the parser" stays dictation. */
export function matchReading(utterance: string, lang: Language, commandWord?: string | null): VoiceReadId | null {
  let tokens = words(utterance, lang).tokens;
  tokens = withoutPolite(tokens.slice(commandWordLength(tokens, commandWordKey(lang, commandWord))), lang);
  if (!tokens.length) return null;
  const said = tokens.map((token) => token.norm).join(" ");
  return VOICE_READ_IDS.find((id) => alternatives(readKey(id), lang).includes(said)) ?? null;
}

/** Spaces, case, accents and punctuation aside, the letters and digits of a
 * phrase: what a personal phrase is compared by. */
function phraseKey(phrase: string): string {
  return fold(sanitizeVoiceTranscript(phrase)).replace(/[^\p{L}\p{N}]/gu, "");
}

/** Whether an utterance is exactly the owner's personal phrase (the command
 * word, the confirm phrase): normalized equality, no fuzzy margin, so a radio
 * that says something close does not count. An empty phrase never matches. */
export function matchesPhrase(utterance: string, phrase: string | null | undefined): boolean {
  const key = phrase ? phraseKey(phrase) : "";
  return key.length > 0 && phraseKey(utterance) === key;
}

/** The answer to a spoken confirmation (one 5 s listen):
 * - `yes`: confirmed — the confirm phrase when one is set, else a yes word;
 * - `needPhrase`: a plain yes while a confirm phrase is set ("Say your
 *   confirm phrase", `voice.say.confirmPhrase`);
 * - `no`: a no word;
 * - `other`: anything else. Everything but `yes` cancels. */
export type VoiceConfirm = "yes" | "no" | "needPhrase" | "other";

export function matchConfirm(utterance: string, lang: Language, confirmPhrase?: string | null): VoiceConfirm {
  const phraseSet = !!confirmPhrase && phraseKey(confirmPhrase).length > 0;
  if (phraseSet && matchesPhrase(utterance, confirmPhrase)) return "yes";
  const said = withoutPolite(words(utterance, lang).tokens, lang).map((token) => token.norm).join(" ");
  if (!said) return "other";
  if (alternatives("voice.confirmYes", lang).includes(said)) return phraseSet ? "needPhrase" : "yes";
  if (alternatives("voice.confirmNo", lang).includes(said)) return "no";
  return "other";
}

/** Every word a catalog phrase uses in `lang`: the command and reading
 * templates' literals, the yes and no words. */
function catalogWords(lang: Language): Set<string> {
  const out = new Set<string>();
  for (const template of templatesFor(lang)) for (const part of template.parts) if ("lit" in part) out.add(part.lit);
  const keys: TranslationKey[] = [...VOICE_READ_IDS.map(readKey), "voice.confirmYes", "voice.confirmNo"];
  for (const key of keys) for (const phrase of alternatives(key, lang)) for (const word of phrase.split(" ")) out.add(word);
  return out;
}

/** Whether a personal phrase is too common to keep a radio or another person
 * out (Settings → Voice warns): a single word under 6 letters, or any word
 * that is a catalog word, a stop, yes, no or number word in `lang`. */
export function weakPhrase(phrase: string, lang: Language): boolean {
  const tokens = words(phrase, lang).tokens;
  if (!tokens.length) return true;
  if (tokens.length === 1 && phraseKey(phrase).length < 6) return true;
  const vocab = catalogWords(lang);
  return tokens.some((token) => /^\d+$/.test(token.norm) || vocab.has(token.norm));
}

// ---------------------------------------------------------------- spoken lines

/** "Didn't catch that", in `lang`. */
export function didNotCatchLine(lang: Language): string {
  return translate(lang, "voice.say.didNotCatch");
}

/** The question an ambiguity asks: "Alpha or Alpha Two?". */
export function ambiguityLine(lang: Language, candidates: readonly VoiceListItem[]): string {
  const [first, second, third] = candidates.map((candidate) => candidate.name);
  return third === undefined
    ? translate(lang, "voice.say.ambiguous2", { first, second: second ?? "" })
    : translate(lang, "voice.say.ambiguous3", { first, second, third });
}

/** How recognizers commonly write the built-in agents' names, for the
 * caller's `agents` list (`{ id, name: "Claude", aliases: BUILTIN_AGENT_ALIASES.claude }`). */
export const BUILTIN_AGENT_ALIASES: Readonly<Record<string, readonly string[]>> = {
  claude: ["cloud", "clod", "clawed", "klaud"],
  codex: ["codecs", "code x"],
  gemini: ["jemini", "gemeni"],
  copilot: ["co pilot"],
};
