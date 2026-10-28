import { beforeAll, describe, expect, it } from "vitest";
import { matchOption } from "../../../shared/voice";
import { BRAND } from "../../lib/brand";
import { LANGUAGES, loadDict, translate, type Language, type TranslationKey } from "../../lib/i18n";
import {
  BUILTIN_AGENT_ALIASES,
  VOICE_COMMANDS,
  VOICE_COMMAND_IDS,
  VOICE_READ_IDS,
  ambiguityLine,
  defaultCommandWord,
  didNotCatchLine,
  hasCommandWord,
  match,
  matchConfirm,
  matchReading,
  matchesPhrase,
  resolveAmbiguity,
  weakPhrase,
  type VoiceCommandId,
  type VoiceLists,
  type VoiceMatch,
  type VoiceSlot,
} from "../../lib/voice/voiceCommands";

const LANGS = LANGUAGES.map((language) => language.value);
const WORD = BRAND.display;

// The matcher reads its phrases in the language it is given, whatever the UI
// speaks: `loadDict` is how the phone gets its speech language's templates.
beforeAll(async () => {
  for (const lang of LANGS) expect(await loadDict(lang)).toBe(true);
});

const lists: VoiceLists = {
  projects: [
    { id: "p-alpha", name: "Alpha" },
    { id: "p-alpha2", name: "Alpha 2" },
    { id: "p-beta", name: "Beta" },
    { id: "p-kitchen", name: "Kitchen Remodel" },
  ],
  boxes: [{ id: "b-thesis", name: "Thesis" }],
  tabs: [{ id: "t-build", name: "Build log" }],
  agents: [
    { id: "claude", name: "Claude", aliases: BUILTIN_AGENT_ALIASES.claude },
    { id: "codex", name: "Codex", aliases: BUILTIN_AGENT_ALIASES.codex },
    { id: "gemini", name: "Gemini", aliases: BUILTIN_AGENT_ALIASES.gemini },
  ],
  models: [
    { id: "opus", name: "Opus" },
    { id: "sonnet", name: "Sonnet" },
    { id: "haiku", name: "Haiku" },
  ],
  efforts: [
    { id: "low", name: "low" },
    { id: "high", name: "high" },
  ],
  cards: [{ id: "c-milk", name: "Buy milk" }],
  localModels: [{ id: "llama", name: "Llama" }],
};

const free = { requireCommandWord: false } as const;

/** The command id and a flat view of its args (list items by id). */
function said(result: VoiceMatch): string {
  if (result.kind !== "command") return `${result.kind}${result.kind === "nothing" ? `:${result.reason}` : ""}`;
  const args = Object.entries(result.args as Record<string, unknown>)
    .map(([slot, value]) => `${slot}=${typeof value === "object" && value ? (value as { id: string }).id : String(value)}`)
    .sort();
  return [result.id, ...args].join(" ");
}

function templates(lang: Language, id: VoiceCommandId): string[] {
  return translate(lang, `voice.cmd.${id}` as TranslationKey).split("|").map((t) => t.trim()).filter(Boolean);
}

function slotsOf(template: string): VoiceSlot[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as VoiceSlot);
}

describe("the voice command catalog", () => {
  it.each(LANGS)("%s: every template holds its command's slots, and only those", (lang) => {
    const problems: string[] = [];
    for (const id of VOICE_COMMAND_IDS) {
      const spec: { slots?: readonly VoiceSlot[]; optional?: readonly VoiceSlot[] } = VOICE_COMMANDS[id];
      const required = spec.slots ?? [];
      const allowed = new Set([...required, ...(spec.optional ?? [])]);
      const used = new Set<VoiceSlot>();
      const list = templates(lang, id);
      if (!list.length) problems.push(`${id}: no template`);
      for (const template of list) {
        const slots = slotsOf(template);
        slots.forEach((slot) => used.add(slot));
        for (const slot of slots) if (!allowed.has(slot)) problems.push(`${id}: "${template}" has {${slot}}`);
        for (const slot of required) if (!slots.includes(slot)) problems.push(`${id}: "${template}" lacks {${slot}}`);
        if (slots.includes("text") && !/\{text\}$/.test(template)) problems.push(`${id}: {text} not last in "${template}"`);
      }
      for (const slot of allowed) if (!used.has(slot)) problems.push(`${id}: {${slot}} in no template`);
    }
    expect(problems).toEqual([]);
  });

  // Each template, said with names from the lists, comes back as its own
  // command: no other command's template takes it.
  it.each(LANGS)("%s: every template is heard as its own command", (lang) => {
    const fill: Record<VoiceSlot, string> = {
      project: "Beta",
      box: "Thesis",
      tab: "Build log",
      agent: "Gemini",
      model: "Sonnet",
      effort: "high",
      card: "Buy milk",
      localModel: "Llama",
      n: "3",
      text: "hello there",
    };
    const wrong: string[] = [];
    for (const id of VOICE_COMMAND_IDS) {
      for (const template of templates(lang, id)) {
        const utterance = template.replace(/\{(\w+)\}/g, (_, slot: VoiceSlot) => fill[slot]);
        const result = match(utterance, lang, lists, free);
        if (result.kind !== "command" || result.id !== id) wrong.push(`${id}: "${utterance}" → ${said(result)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it.each(LANGS)("%s: the reading commands and yes/no have phrases", (lang) => {
    for (const id of VOICE_READ_IDS) expect(matchReading(translate(lang, `voice.read.${id}` as TranslationKey).split("|")[0], lang), id).toBe(id);
    expect(matchConfirm(translate(lang, "voice.confirmYes").split("|")[0], lang)).toBe("yes");
    expect(matchConfirm(translate(lang, "voice.confirmNo").split("|")[0], lang)).toBe("no");
  });

  it("the default command word is the app's name in every language, and not the assistant's", () => {
    for (const lang of LANGS) {
      expect(defaultCommandWord(lang)).toBe(BRAND.display);
      expect(defaultCommandWord(lang)).not.toBe(BRAND.assistant);
    }
  });
});

describe("matching an utterance (English)", () => {
  it("takes the command word off and matches the rest whole", () => {
    expect(said(match(`${WORD}, project Alpha.`, "en", lists))).toBe("openProject project=p-alpha");
    expect(said(match(`${WORD.toUpperCase()} what's waiting?`, "en", lists))).toBe("whatsWaiting");
    expect(said(match(`${WORD} projects please`, "en", lists))).toBe("projects");
  });

  it("hears the command word split in two", () => {
    const split = `${WORD.slice(0, 3)} ${WORD.slice(3)}`;
    expect(said(match(`${split} projects`, "en", lists))).toBe("projects");
  });

  it("turns number words into numbers", () => {
    expect(said(match("tab three", "en", lists, free))).toBe("tabNumber n=3");
    expect(said(match("Tab 12.", "en", lists, free))).toBe("tabNumber n=12");
    expect(said(match("second Claude", "en", lists, free))).toBe("agentTab agent=claude n=2");
    expect(said(match("the 2nd Claude", "en", lists, free))).toBe("agentTab agent=claude n=2");
    expect(said(match("Codex tab", "en", lists, free))).toBe("agentTab agent=codex");
  });

  it("tells close names apart: Alpha, Alpha 2, alfa", () => {
    expect(said(match("project alpha", "en", lists, free))).toBe("openProject project=p-alpha");
    expect(said(match("project alpha two", "en", lists, free))).toBe("openProject project=p-alpha2");
    expect(said(match("project Alpha 2", "en", lists, free))).toBe("openProject project=p-alpha2");
    expect(said(match("project alfa", "en", lists, free))).toBe("openProject project=p-alpha");
    expect(said(match("project bita", "en", lists, free))).toBe("openProject project=p-beta");
    // A prefix stands when the name is the only close one.
    expect(said(match("project kitchen", "en", lists, free))).toBe("openProject project=p-kitchen");
  });

  it("takes a long name said exactly over the same name with a number", () => {
    // The joined letters of "Project Alpha 2" score 0.92 against "project
    // alpha": without the exact rule that was an ambiguity, and saying the
    // exact name again could not resolve it.
    const numbered: VoiceLists = {
      projects: [{ id: "pa", name: "Project Alpha" }, { id: "pa2", name: "Project Alpha 2" }, { id: "km", name: "Kitchen Remodel" }, { id: "km2", name: "Kitchen Remodel 2" }],
    };
    expect(said(match("project project alpha", "en", numbered, free))).toBe("openProject project=pa");
    expect(said(match("project project alpha two", "en", numbered, free))).toBe("openProject project=pa2");
    expect(said(match("project kitchen remodel", "en", numbered, free))).toBe("openProject project=km");
    const asked: VoiceMatch = {
      kind: "ambiguous",
      id: "openProject",
      slot: "project",
      candidates: [numbered.projects![0], numbered.projects![1]],
      partial: {},
      heardCommandWord: false,
    };
    expect(said(resolveAmbiguity("Project Alpha", asked, "en") ?? match("", "en"))).toBe("openProject project=pa");
    expect(said(resolveAmbiguity("Project Alpha 2", asked, "en") ?? match("", "en"))).toBe("openProject project=pa2");
  });

  it("does not take a different name for a misheard one", () => {
    expect(said(match("project delta", "en", lists, free))).toBe("nothing:unknownName");
    expect(said(match("project omega", "en", lists, free))).toBe("nothing:unknownName");
    // One letter off a short name is still that name.
    expect(said(match("project zeta", "en", lists, free))).toBe("openProject project=p-beta");
  });

  it("hears the built-in agents as recognizers write them", () => {
    expect(said(match("new cloud tab", "en", lists, free))).toBe("newAgentTab agent=claude");
    expect(said(match("new Claude tab in alpha two", "en", lists, free))).toBe("newAgentTab agent=claude project=p-alpha2");
    expect(said(match("new shell in Beta", "en", lists, free))).toBe("newShell project=p-beta");
    expect(said(match("new monitor", "en", lists, free))).toBe("newMonitor");
  });

  it("asks back when names are too close, and resolves the answer", () => {
    const twins: VoiceLists = { projects: [{ id: "x2", name: "Alpha Two" }, { id: "x3", name: "Alpha Three" }] };
    const result = match("project alpha", "en", twins, free);
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") return;
    expect(result.slot).toBe("project");
    expect(result.candidates.map((c) => c.id)).toEqual(["x2", "x3"]);
    expect(ambiguityLine("en", result.candidates)).toBe("Alpha Two or Alpha Three?");
    expect(said(resolveAmbiguity("two", result, "en") ?? match("", "en"))).toBe("openProject project=x3");
    expect(said(resolveAmbiguity("the second one", result, "en") ?? match("", "en"))).toBe("openProject project=x3");
    expect(said(resolveAmbiguity("Alpha Two", result, "en") ?? match("", "en"))).toBe("openProject project=x2");
    expect(resolveAmbiguity("five", result, "en")).toBeNull();
    expect(resolveAmbiguity("banana", result, "en")).toBeNull();
    // Same-sounding names, and three of them.
    const three: VoiceLists = { projects: [{ id: "a", name: "Alpha" }, { id: "b", name: "Alfa" }, { id: "c", name: "Alpher" }] };
    const asked = match("project alpha", "en", three, free);
    expect(asked.kind).toBe("ambiguous");
    if (asked.kind === "ambiguous") expect(asked.candidates.map((c) => c.id).sort().slice(0, 2)).toEqual(["a", "b"]);
  });

  it("keeps resolved slots through an ambiguity", () => {
    const twins: VoiceLists = { ...lists, projects: [{ id: "x2", name: "Alpha Two" }, { id: "x3", name: "Alpha Three" }] };
    const result = match("new Codex tab in alpha", "en", twins, free);
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") return;
    expect(said(resolveAmbiguity("one", result, "en") ?? match("", "en"))).toBe("newAgentTab agent=codex project=x2");
  });

  it("takes dictation that merely contains command words for no command", () => {
    // No command word: dictation.
    expect(said(match("please close the tab when you are done", "en", lists))).toBe("nothing:noCommandWord");
    expect(said(match(`ask ${WORD} to open project Alpha`, "en", lists))).toBe("nothing:noCommandWord");
    // Even where no command word is needed, the whole utterance must be a template.
    for (const text of [
      "close the tab when the build is done",
      "I think project Alpha needs a new shell",
      "stop the server and run the tests",
      "next we should look at the parser",
      "the model is wrong here",
    ]) {
      expect(match(text, "en", lists, free).kind, text).toBe("nothing");
    }
  });

  it("says why nothing matched", () => {
    expect(match(WORD, "en", lists)).toMatchObject({ kind: "nothing", reason: "commandWordOnly", heardCommandWord: true });
    expect(match(`${WORD} frobnicate the widgets`, "en", lists)).toMatchObject({ kind: "nothing", reason: "unmatched", heardCommandWord: true });
    expect(match(`${WORD} project omega`, "en", lists)).toMatchObject({ kind: "nothing", reason: "unknownName" });
    expect(match("", "en", lists, free)).toMatchObject({ kind: "nothing", reason: "unmatched", heardCommandWord: false });
    expect(didNotCatchLine("en")).toBe("Didn't catch that.");
  });

  it("carries dictation as heard in a {text} slot", () => {
    const result = match(`${WORD}, tell Claude to fix the parser, please`, "en", lists);
    expect(said(result)).toBe("tell agent=claude text=to fix the parser");
    expect(said(match("tell Claude what is this?", "en", lists, free))).toBe("tell agent=claude text=what is this?");
    expect(said(match("tell Claude that the build is green", "en", lists, free))).toBe("tell agent=claude text=the build is green");
    expect(said(match("new to-do Buy oat milk", "en", lists, free))).toBe("newTodo text=Buy oat milk");
    // A text slot never stands empty.
    expect(match("reply", "en", lists, free).kind).toBe("nothing");
    // Nor starts inside a word: "that's" is not "that" plus the dictation "s …".
    expect(said(match("tell Claude that's wrong", "en", lists, free))).toBe("tell agent=claude text=that's wrong");
    expect(said(match("reply that's fine, thanks", "en", lists, free))).toBe("replyMail text=that's fine, thanks");
  });

  it("reports whether the command word was said, and types the args by id", () => {
    const result = match("model Opus", "en", lists, free);
    expect(result).toMatchObject({ kind: "command", id: "model", heardCommandWord: false });
    if (result.kind === "command" && result.id === "model") expect(result.args.model.id).toBe("opus");
    const withWord = match(`${WORD} model sonnet`, "en", lists, free);
    expect(withWord.kind === "command" && withWord.heardCommandWord).toBe(true);
  });

  it("prefers the template with more fixed words", () => {
    // "new monitor" is not "new {agent}" with an agent called Monitor, and
    // "load model Llama" is not "load {localModel}" with "model Llama".
    expect(said(match("load model llama", "en", lists, free))).toBe("loadModel localModel=llama");
    expect(said(match("close tab", "en", lists, free))).toBe("closeTab");
    expect(said(match("close", "en", lists, free))).toBe("closeApp");
  });
});

describe("the personal command word", () => {
  const own = { commandWord: "Jarvis" };

  it("replaces the default one", () => {
    expect(said(match("Jarvis, projects", "en", lists, own))).toBe("projects");
    expect(said(match(`${WORD} projects`, "en", lists, own))).toBe("nothing:noCommandWord");
    expect(hasCommandWord("Jarvis next waiting", "en", "Jarvis")).toBe(true);
    expect(hasCommandWord(`${WORD} next waiting`, "en", "Jarvis")).toBe(false);
    expect(hasCommandWord(`${WORD} next waiting`, "en")).toBe(true);
  });

  it("is matched exactly, with no fuzzy margin", () => {
    expect(said(match("Jarvi projects", "en", lists, own))).toBe("nothing:noCommandWord");
    expect(said(match("Jarviss projects", "en", lists, own))).toBe("nothing:noCommandWord");
    expect(said(match("Jar vis projects", "en", lists, own))).toBe("projects");
  });

  it("may be a phrase of five words or more", () => {
    // The safer the phrase, the longer: it once stopped being heard past four words.
    const phrase = { commandWord: "listen up my kitchen helper" };
    expect(said(match("Listen up, my kitchen helper: projects", "en", lists, phrase))).toBe("projects");
    expect(hasCommandWord("listen up my kitchen helper next waiting", "en", phrase.commandWord)).toBe(true);
    expect(said(match("listen up my kitchen projects", "en", lists, phrase))).toBe("nothing:noCommandWord");
    expect(matchReading("listen up my kitchen helper next", "en", phrase.commandWord)).toBe("next");
  });

  it("works in every language, and a blank one falls back to the default", () => {
    for (const lang of LANGS) {
      const projects = templates(lang, "projects")[0];
      expect(said(match(`Jarvis ${projects}`, lang, lists, own)), lang).toBe("projects");
      expect(said(match(`${WORD} ${projects}`, lang, lists, { commandWord: "  " })), lang).toBe("projects");
    }
  });
});

describe("matching in each language", () => {
  const cases: Record<Language, [string, string][]> = {
    en: [
      ["what's working", "whatsWorking"],
      ["where am I", "status"],
      ["next waiting", "nextWaiting"],
      ["show Beta on the desktop", "showOnDesktop project=p-beta"],
      ["switch the model to Opus", "model model=opus"],
      ["mark Buy milk as done", "doneTodo card=c-milk"],
      ["go to build log", "goToTab tab=t-build"],
    ],
    de: [
      ["Projekt Alpha", "openProject project=p-alpha"],
      ["Projekt Alpha zwei", "openProject project=p-alpha2"],
      ["Projekt Alfa", "openProject project=p-alpha"],
      ["Tab drei", "tabNumber n=3"],
      ["zweiter Claude", "agentTab agent=claude n=2"],
      ["der dritte Codex", "agentTab agent=codex n=3"],
      ["neuen Claude Tab in Beta", "newAgentTab agent=claude project=p-beta"],
      ["Tab schließen", "closeTab"],
      ["Tab schliessen", "closeTab"],
      ["was wartet?", "whatsWaiting"],
      ["wo bin ich", "status"],
      ["sag Claude, dass der Build grün ist", "tell agent=claude text=der Build grün ist"],
      ["Modell Sonnet", "model model=sonnet"],
      ["Buy milk erledigt", "doneTodo card=c-milk"],
    ],
    es: [
      ["proyecto Alpha", "openProject project=p-alpha"],
      ["proyecto alfa dos", "openProject project=p-alpha2"],
      ["pestaña dos", "tabNumber n=2"],
      ["segundo Claude", "agentTab agent=claude n=2"],
      ["el tercer Codex", "agentTab agent=codex n=3"],
      ["cierra la pestaña", "closeTab"],
      ["qué espera", "whatsWaiting"],
      ["dónde estoy", "status"],
      ["dile a Claude que revise el código", "tell agent=claude text=revise el código"],
      ["nueva pestaña de Claude en Beta", "newAgentTab agent=claude project=p-beta"],
    ],
    fr: [
      ["projet Alpha", "openProject project=p-alpha"],
      ["projet alpha deux", "openProject project=p-alpha2"],
      ["onglet trois", "tabNumber n=3"],
      ["le deuxième Claude", "agentTab agent=claude n=2"],
      ["ferme l'onglet", "closeTab"],
      ["qu'est-ce qui attend ?", "whatsWaiting"],
      ["où suis-je", "status"],
      ["dis à Claude que tout va bien", "tell agent=claude text=tout va bien"],
      ["nouvel onglet Claude dans Beta", "newAgentTab agent=claude project=p-beta"],
    ],
    it: [
      ["progetto Alpha", "openProject project=p-alpha"],
      ["progetto alfa due", "openProject project=p-alpha2"],
      ["scheda due", "tabNumber n=2"],
      ["il secondo Claude", "agentTab agent=claude n=2"],
      ["chiudi la scheda", "closeTab"],
      ["cosa aspetta", "whatsWaiting"],
      ["dove sono", "status"],
      ["dì a Claude che va tutto bene", "tell agent=claude text=va tutto bene"],
      ["nuova scheda Claude in Beta", "newAgentTab agent=claude project=p-beta"],
    ],
  };

  it.each(LANGS)("%s: commands, number words, close and misheard names", (lang) => {
    for (const [text, expected] of cases[lang]) {
      expect(said(match(`${WORD} ${text}`, lang, lists)), text).toBe(expected);
    }
  });

  const dictation: Record<Language, string[]> = {
    en: ["close the tab once the tests pass", "tell me what the project does"],
    de: ["schließe den Tab, wenn die Tests grün sind", "das Projekt Alpha braucht einen neuen Test"],
    es: ["cierra la pestaña cuando terminen las pruebas", "el proyecto Alpha necesita una prueba"],
    fr: ["ferme l'onglet quand les tests passent", "le projet Alpha a besoin d'un test"],
    it: ["chiudi la scheda quando i test passano", "il progetto Alpha ha bisogno di un test"],
  };

  it.each(LANGS)("%s: dictation that contains command words is no command", (lang) => {
    for (const text of dictation[lang]) {
      expect(match(text, lang, lists).kind, text).toBe("nothing");
      expect(match(text, lang, lists, free).kind, text).toBe("nothing");
    }
  });

  it.each(LANGS)("%s: asks back between two close names", (lang) => {
    const twins: VoiceLists = { projects: [{ id: "x2", name: "Alpha Two" }, { id: "x3", name: "Alpha Three" }] };
    const projectWord = templates(lang, "openProject")[0].replace("{project}", "alpha");
    const result = match(projectWord, lang, twins, free);
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      const line = ambiguityLine(lang, result.candidates);
      expect(line).toContain("Alpha Two");
      expect(line).toContain("Alpha Three");
    }
  });
});

describe("reading commands", () => {
  it("are the whole utterance", () => {
    expect(matchReading("Next.", "en")).toBe("next");
    expect(matchReading("skip this answer", "en")).toBe("nextAnswer");
    expect(matchReading(`${WORD}, repeat`, "en")).toBe("repeat");
    expect(matchReading("next, fix the parser", "en")).toBeNull();
    expect(matchReading("go back to the old version", "en")).toBeNull();
    expect(matchReading("weiter", "de")).toBe("next");
    expect(matchReading("nächste Antwort", "de")).toBe("nextAnswer");
    expect(matchReading("Überspringen!", "de")).toBe("nextAnswer");
    expect(matchReading("más rápido", "es")).toBe("faster");
    expect(matchReading("réponse suivante", "fr")).toBe("nextAnswer");
    expect(matchReading("leggi tutto", "it")).toBe("readAll");
    expect(matchReading("leggi tutto il file", "it")).toBeNull();
  });
});

describe("the personal phrases", () => {
  it("matchesPhrase is exact, case, accents, spaces and punctuation aside", () => {
    expect(matchesPhrase("Blue falcon!", "blue falcon")).toBe(true);
    expect(matchesPhrase("bluefalcon", "Blue Falcon")).toBe(true);
    expect(matchesPhrase("Café Olé", "cafe ole")).toBe(true);
    expect(matchesPhrase("blue falcons", "blue falcon")).toBe(false);
    expect(matchesPhrase("blue falco", "blue falcon")).toBe(false);
    expect(matchesPhrase("the blue falcon", "blue falcon")).toBe(false);
    expect(matchesPhrase("", "")).toBe(false);
    expect(matchesPhrase("yes", null)).toBe(false);
    expect(matchesPhrase("!!", "?")).toBe(false);
  });

  it("without a confirm phrase, a yes confirms and anything else cancels", () => {
    expect(matchConfirm("Yes.", "en")).toBe("yes");
    expect(matchConfirm("yes please", "en")).toBe("yes");
    expect(matchConfirm("no", "en")).toBe("no");
    expect(matchConfirm("yes, and delete the rest", "en")).toBe("other");
    expect(matchConfirm("maybe", "en")).toBe("other");
    expect(matchConfirm("Ja", "de")).toBe("yes");
    expect(matchConfirm("nein", "de")).toBe("no");
    expect(matchConfirm("sí", "es")).toBe("yes");
    expect(matchConfirm("oui", "fr")).toBe("yes");
    expect(matchConfirm("sì", "it")).toBe("yes");
  });

  it("with a confirm phrase, only the phrase confirms; a plain yes asks for it", () => {
    for (const lang of LANGS) {
      const yes = translate(lang, "voice.confirmYes").split("|")[0];
      expect(matchConfirm(yes, lang, "blue falcon"), lang).toBe("needPhrase");
      expect(matchConfirm("Blue falcon.", lang, "blue falcon"), lang).toBe("yes");
      expect(matchConfirm("blue falco", lang, "blue falcon"), lang).toBe("other");
      expect(matchConfirm(translate(lang, "voice.confirmNo").split("|")[0], lang, "blue falcon"), lang).toBe("no");
    }
    expect(translate("en", "voice.say.confirmPhrase")).toBe("Say your confirm phrase.");
    // A blank phrase is no phrase.
    expect(matchConfirm("yes", "en", "  ")).toBe("yes");
  });

  it("weakPhrase flags short words, catalog words, yes/no, stop and numbers", () => {
    expect(weakPhrase("bird", "en")).toBe(true);
    expect(weakPhrase("", "en")).toBe(true);
    expect(weakPhrase("open sesame", "en")).toBe(true);
    expect(weakPhrase("seven seas", "en")).toBe(true);
    expect(weakPhrase("yes indeed", "en")).toBe(true);
    expect(weakPhrase("stop", "en")).toBe(true);
    expect(weakPhrase("blue falcon", "en")).toBe(false);
    expect(weakPhrase("Falcon", "en")).toBe(false);
    expect(weakPhrase("ja genau", "de")).toBe(true);
    expect(weakPhrase("zwei Falken", "de")).toBe(true);
    expect(weakPhrase("Kaffeemaschine", "de")).toBe(false);
    expect(weakPhrase("halcón azul", "es")).toBe(false);
    expect(weakPhrase("faucon bleu", "fr")).toBe(false);
    expect(weakPhrase("falco azzurro", "it")).toBe(false);
  });
});

describe("matchOption with the rows' own words", () => {
  const labels = ["Yes", "Yes, and don't ask again", "No"];

  it("picks a row whose label is said whole", () => {
    expect(matchOption("yes and don't ask again", 3, labels)).toBe(1);
    expect(matchOption("No.", 3, labels)).toBe(2);
    expect(matchOption("two", 3, labels)).toBe(1);
    expect(matchOption("yes and", 3, labels)).toBeNull();
    expect(matchOption("No", 2, labels)).toBeNull();
    expect(matchOption("same", 2, ["Same", "same"])).toBeNull();
    expect(matchOption("No", 3)).toBeNull();
  });
});
