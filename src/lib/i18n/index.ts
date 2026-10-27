import { useMemo } from "react";
import { create } from "zustand";
import { fillBrand, storageDashKey } from "../brand";
import { enSource } from "./en";

/**
 * Tabtivity's in-house internationalization (i18n) — the ONE place every language
 * lives, so adding a string or a whole language is a single edit here and never
 * a hunt through the component tree.
 *
 * Design (kept deliberately dependency-free — no i18next, no network):
 *  - Each language is a flat `key → text` map. English (`en`, below) is the
 *    source of truth and holds *every* key; the other languages provide what
 *    they translate and fall back to English (then to the raw key) for anything
 *    missing, so a half-translated language degrades gracefully instead of
 *    rendering blanks.
 *  - The four non-English dictionaries are code-split (§5.2 startup size): they
 *    live in `i18n/{de,es,fr,it}.ts` and are `import()`ed on demand, so
 *    the startup chunk carries only English plus the language actually in use.
 *    The cached language's dictionary is kicked off at module evaluation, in
 *    parallel with the rest of startup; until it lands, `translate` falls back
 *    to English — never a blank. `i18n/all.ts` re-aggregates the full set
 *    for the parity tests; importing it from app code would undo the split.
 *  - The current language is a tiny zustand store (`useI18nStore`). Switching is
 *    **instant**: `setLangLocal` flips one field and every component reading
 *    `useT()` re-renders in place — no reload, no restart. Persistence rides the
 *    ordinary settings file (`Settings.language`); this store is only the live,
 *    reactive mirror, seeded from a localStorage cache so the first paint after
 *    launch already shows the chosen language before settings finish loading.
 *
 * To add a language: add its code to `Language`, a `{ value, label }` row to
 * `LANGUAGES`, a dictionary module under `i18n/`, and its loader to
 * `dictLoaders` (+ `i18n/all.ts`). To add a string: add the key to the
 * `en` block (and, ideally, the dictionaries) and call `t("your.key")`.
 */
export type Language = "en" | "de" | "es" | "fr" | "it";

/** The languages offered in the switcher, labelled in their own tongue. */
export const LANGUAGES: { value: Language; label: string }[] = [
  { value: "en", label: "English" },
  { value: "de", label: "Deutsch" },
  { value: "es", label: "Español" },
  { value: "fr", label: "Français" },
  { value: "it", label: "Italiano" },
];

const LANG_CODES = new Set<string>(LANGUAGES.map((l) => l.value));

/** Coerce an arbitrary string (settings value, cache) to a supported language. */
export function normalizeLang(value: string | null | undefined): Language {
  return value && LANG_CODES.has(value) ? (value as Language) : "en";
}

// English is the base (see `./en`): it defines the full key set. Other languages
// need only override; anything absent falls through to English via `translate`.
// Exported solely for the tests — components go through `useT()`/`translate`.
export { enSource };

/** English with `{app}` filled. Exported solely for the test aggregator
 *  (`i18n/all.ts`). */
export const en = fillBrand(enSource);

/** The key set every component is allowed to translate. */
export type TranslationKey = keyof typeof en;

export type Dict = Partial<Record<TranslationKey, string>>;

// The non-English dictionaries, registered as their lazy chunks land. English
// is read straight off `en` and never lives here.
const loadedDicts: Partial<Record<Language, Dict>> = {};

const dictLoaders: Record<Exclude<Language, "en">, () => Promise<{ dict: Dict }>> = {
  de: () => import("./de"),
  es: () => import("./es"),
  fr: () => import("./fr"),
  it: () => import("./it"),
};

/** Make `lang`'s dictionary available to `translate` synchronously. Called by
 *  the dynamic loaders below and by the test aggregator (`i18n/all.ts`). */
export function registerDict(lang: Language, dict: Dict) {
  if (lang === "en") return;
  loadedDicts[lang] = fillBrand(dict);
  // If this is the live language, bump the generation so every `useT()`
  // subscriber re-renders out of the English fallback.
  const s = useI18nStore.getState();
  if (s.lang === lang) s.bumpDictGen();
}

const dictsInFlight = new Set<Language>();

/** Idempotently start the background load of `lang`'s dictionary. */
function ensureDict(lang: Language) {
  if (lang === "en" || loadedDicts[lang] || dictsInFlight.has(lang)) return;
  dictsInFlight.add(lang);
  dictLoaders[lang]()
    .then((m) => registerDict(lang, m.dict))
    .catch(() => {
      // Chunk failed to load (dev-server hiccup, torn install): English stands
      // in; clearing the in-flight mark lets a later applyLanguage retry.
      dictsInFlight.delete(lang);
    });
}

const LANG_CACHE_KEY = storageDashKey("lang");

function cachedLang(): Language {
  try {
    return normalizeLang(localStorage.getItem(LANG_CACHE_KEY));
  } catch {
    return "en";
  }
}

interface I18nStore {
  lang: Language;
  /** Bumped when a lazily-loaded dictionary lands, so `useT()` subscribers
   *  re-render out of the English fallback without a language change. */
  dictGen: number;
  /** Set the live language WITHOUT persisting (persistence rides settings.json).
   *  Every `useT()` subscriber re-renders instantly. */
  setLangLocal: (lang: Language) => void;
  bumpDictGen: () => void;
}

export const useI18nStore = create<I18nStore>((set) => ({
  lang: cachedLang(),
  dictGen: 0,
  setLangLocal: (lang) => set({ lang }),
  bumpDictGen: () => set((s) => ({ dictGen: s.dictGen + 1 })),
}));

// First paint: start fetching the cached language's dictionary immediately, in
// parallel with the rest of startup — settings only confirm (or change) the
// choice later via `applyLanguage`.
ensureDict(cachedLang());

/** Apply a language app-wide: flips the reactive store and caches it so the next
 *  launch paints this language before settings finish loading. Mirrors
 *  `applyTheme` in `stores/settings`. */
export function applyLanguage(value: string | null | undefined) {
  const lang = normalizeLang(value);
  ensureDict(lang);
  useI18nStore.getState().setLangLocal(lang);
  try {
    localStorage.setItem(LANG_CACHE_KEY, lang);
  } catch {
    // localStorage unavailable — the switch still works this session.
  }
}

/** The locale to spell dates in (weekday and month names) for `lang`: the
 *  browser's own when it already speaks that language, so its regional habits
 *  (`en-GB`, `de-AT`) survive, else the bare language — a phone held in one
 *  language while the app is set to another would otherwise mix the two. */
export function dateLocale(
  lang: Language = useI18nStore.getState().lang,
  browser: string | undefined = typeof navigator === "undefined" ? undefined : navigator.language,
): string | undefined {
  return browser && browser.toLowerCase().split("-")[0] === lang ? undefined : lang;
}

/** Look up a key in `lang`, falling back to English then the raw key (also the
 *  interim answer while `lang`'s lazy dictionary is still loading). `params`
 *  substitutes `{name}` placeholders. */
export function translate(
  lang: Language,
  key: TranslationKey,
  params?: Record<string, string | number>,
): string {
  const raw = loadedDicts[lang]?.[key] ?? en[key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name) =>
    name in params ? String(params[name]) : m,
  );
}

/** `translate` at the live language — for code outside React (stores, plain
 *  helpers, DOM-built dialogs, thrown error messages) that has no `useT`. It
 *  reads the language when called, so a caller that runs again after a
 *  language switch (the next render, the next dialog) speaks the new one. */
export function translateNow(key: TranslationKey, params?: Record<string, string | number>): string {
  return translate(useI18nStore.getState().lang, key, params);
}

/** The translator hook: `const t = useT(); t("settings.title")`. Re-renders the
 *  component whenever the language changes, so switching is live. */
export function useT() {
  const lang = useI18nStore((s) => s.lang);
  // `dictGen` moves when a lazy dictionary lands: the returned `t` must be a
  // NEW function then, or memoized consumers keep rendering the English
  // fallback they translated before the dict arrived.
  const dictGen = useI18nStore((s) => s.dictGen);
  return useMemo(
    () =>
      (key: TranslationKey, params?: Record<string, string | number>) =>
        translate(lang, key, params),
    // dictGen looks unnecessary to the linter because `translate` reads module
    // state (`loadedDicts`) it cannot see — the bump is what re-mints `t`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lang, dictGen],
  );
}
