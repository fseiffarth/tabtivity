/**
 * The titles `sw.js` gives a push that arrived without one (a phone that
 * chose "only that something wants you"), in the phone's language.
 *
 * `sw.js` is a static `public/` file: it cannot import `lib/i18n.ts`. So the
 * build stamps the three titles in every language into the emitted worker
 * (`stampServiceWorker` in `vite.mobile.config.ts`, taken from the i18n keys
 * below), and the page keeps its current language in Cache Storage, where the
 * worker reads it when a push lands — the page itself may be long closed by
 * then. The worker falls back to the browser's language, then English.
 *
 * Kept free of the phone's app modules so the vite config can import it.
 */
import { NAMES } from "../../src/lib/brand";
import {
  LANGUAGES,
  useI18nStore,
  type Dict,
  type Language,
  type TranslationKey,
} from "../../src/lib/i18n";

/** The placeholder in `public/sw.js` the build replaces with the table. */
export const PUSH_TITLES_PLACEHOLDER = "__APP_PUSH_TITLES__";

/** Where the page keeps its language for the worker: a cache of its own (the
 *  worker purges every other cache on activate) and one fixed entry. */
export const PUSH_LANG_CACHE = NAMES.mobilePushLangCache;
export const PUSH_LANG_URL = "/__push-lang";

/** The worker's title slots → their i18n keys. */
export const PUSH_TITLE_KEYS = {
  agentDone: "mobile.push.titleAgentDone",
  agentQuestion: "mobile.push.titleAgentQuestion",
  calendar: "mobile.push.titleCalendar",
} as const satisfies Record<string, TranslationKey>;

export type PushTitleSlot = keyof typeof PUSH_TITLE_KEYS;
export type PushTitleTable = Record<Language, Record<PushTitleSlot, string>>;

/** The table the build stamps, from fully loaded (and `{app}`-filled)
 *  dictionaries; a language missing a key gets English, as `translate` does. */
export function pushTitleTable(dicts: Record<Language, Dict>): PushTitleTable {
  const table = {} as PushTitleTable;
  for (const { value: lang } of LANGUAGES) {
    const row = {} as Record<PushTitleSlot, string>;
    for (const [slot, key] of Object.entries(PUSH_TITLE_KEYS) as [PushTitleSlot, TranslationKey][]) {
      row[slot] = dicts[lang][key] ?? dicts.en[key] ?? key;
    }
    table[lang] = row;
  }
  return table;
}

/** `source` with the placeholder replaced. The placeholder sits inside a
 *  double-quoted string literal (so the unstamped dev copy still parses), so
 *  the table goes in as JSON escaped for that literal. */
export function stampPushTitles(source: string, table: PushTitleTable): string {
  if (!source.includes(PUSH_TITLES_PLACEHOLDER)) {
    throw new Error(`stamp-sw: ${PUSH_TITLES_PLACEHOLDER} is missing from sw.js`);
  }
  const literal = JSON.stringify(JSON.stringify(table)).slice(1, -1);
  return source.split(PUSH_TITLES_PLACEHOLDER).join(literal);
}

function storeLanguage(lang: Language): void {
  try {
    if (typeof caches === "undefined") return;
    void caches
      .open(PUSH_LANG_CACHE)
      .then((cache) => cache.put(PUSH_LANG_URL, new Response(lang, { headers: { "content-type": "text/plain" } })))
      .catch(() => undefined);
  } catch {
    // No Cache Storage (an insecure origin): the worker falls back to the
    // browser's language.
  }
}

/** Keep the phone's language where the worker can read it: now, and on every
 *  change. Returns the unsubscribe. */
export function rememberPushLanguage(): () => void {
  storeLanguage(useI18nStore.getState().lang);
  return useI18nStore.subscribe((state, prev) => {
    if (state.lang !== prev.lang) storeLanguage(state.lang);
  });
}
