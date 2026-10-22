/**
 * The Settings search: ranking a query against the setting-level index, and
 * taking the user to the setting it found.
 *
 * The index itself lives with the pages (`SEARCH_INDEX` in `SettingsPanel`);
 * this module knows nothing about which settings exist. A setting is found on
 * its page by its label's text — the same text the user reads — so nothing on
 * a page needs an id to be searchable, and a fold it sits in is opened the
 * way a click would open it.
 */

/** One searchable text with its weight: a hit in a setting's own label
 *  outranks one in its synonyms, which outranks one in the page it is on. */
export interface SearchField {
  text: string;
  weight: number;
}

/** Lowercase, accents dropped ("Übersicht" finds "ubersicht" and back). */
export function normalizeSearch(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

const WORD = /[^\p{L}\p{N}]+/u;

/** The query's terms: what is between punctuation and spaces, so
 *  "claude-api" and "claude api" are the same search. */
export function searchTerms(query: string): string[] {
  return normalizeSearch(query).split(WORD).filter(Boolean);
}

/** The score of a setting for `terms`, or `null` when a term matches none of
 *  its fields — every word typed must match. A term counts in full at the
 *  start of a word; a longer one also counts at half weight inside a word
 *  ("board" in "keyboard"), a short one never does ("api" is not in
 *  "capital"). */
export function scoreSearch(terms: string[], fields: SearchField[]): number | null {
  const prepared = fields.map((f) => {
    const text = normalizeSearch(f.text);
    return { text, words: text.split(WORD), weight: f.weight };
  });
  let score = 0;
  for (const term of terms) {
    let best = 0;
    for (const f of prepared) {
      if (f.words.some((w) => w.startsWith(term))) best = Math.max(best, f.weight);
      else if (term.length >= 4 && f.text.includes(term)) best = Math.max(best, f.weight / 2);
    }
    if (best === 0) return null;
    score += best;
  }
  return score;
}

/** An element's own text: its direct text nodes, so a label followed by a
 *  pill or a help icon still reads as the label alone. */
function ownText(el: Element): string {
  let text = "";
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? "";
  }
  return text.replace(/\s+/g, " ").trim();
}

function findByText(scope: Element, text: string): HTMLElement | null {
  const want = text.replace(/\s+/g, " ").trim();
  if (!want) return null;
  for (const el of scope.querySelectorAll<HTMLElement>("*")) {
    if (ownText(el) === want) return el;
  }
  return null;
}

/** What gets scrolled to and highlighted around a found label: its card,
 *  block or row, else the label itself. */
const TARGET_BOX = ".settings-card, .agents-block, .agents-option, .agents-row, .agents-group, .settings-advanced";
const TEXT_INPUT = "input:not([type]):not([disabled]), input[type=text]:not([disabled]), input[type=password]:not([disabled]), input[type=number]:not([disabled]), input[type=url]:not([disabled]), textarea:not([disabled])";
export const FLASH_CLASS = "settings-search-flash";
const FLASH_MS = 1800;
/** How long a page may take to render the setting (a sub-panel's rows often
 *  wait on a backend status) before the search gives up on it. */
const WAIT_MS = 4000;

/**
 * Take the user to a setting already on screen in `root`, or about to be:
 * open each fold of `path` but the last (by its toggle's label), then scroll
 * to the last — the setting's label — and highlight it. With `open`, the
 * setting is itself a fold and is opened too. A setting with exactly one
 * field to type into gets the focus, so "claude api" lands in the key field.
 * Waits for rows that render late; returns the cancel.
 */
export function revealSetting(root: HTMLElement, path: string[], open = false): () => void {
  let step = 0;
  let scope: Element = root;
  let done = false;
  const toggleOf = (el: HTMLElement) => el.closest<HTMLElement>("[aria-expanded]");
  const expand = (toggle: HTMLElement | null) => {
    if (toggle?.getAttribute("aria-expanded") === "false") toggle.click();
  };
  const attempt = (): boolean => {
    while (step < path.length) {
      const el = findByText(scope, path[step]);
      if (!el) return false;
      if (step < path.length - 1) {
        const toggle = toggleOf(el);
        expand(toggle);
        // The next label is looked for inside this fold only: a page can
        // use the same word twice ("Models").
        scope = toggle?.parentElement ?? scope;
        step += 1;
        continue;
      }
      if (open) expand(toggleOf(el));
      const target = el.closest<HTMLElement>(TARGET_BOX) ?? el;
      const inputs = target.querySelectorAll<HTMLElement>(TEXT_INPUT);
      if (inputs.length === 1) inputs[0].focus({ preventScroll: true });
      target.scrollIntoView?.({ block: "center", behavior: "smooth" });
      target.classList.remove(FLASH_CLASS);
      // Restart the animation when the same setting is picked twice.
      void target.offsetWidth;
      target.classList.add(FLASH_CLASS);
      window.setTimeout(() => target.classList.remove(FLASH_CLASS), FLASH_MS);
      return true;
    }
    return true;
  };
  if (attempt()) return () => {};
  const observer = new MutationObserver(() => {
    if (!done && attempt()) stop();
  });
  const timer = window.setTimeout(() => stop(), WAIT_MS);
  function stop() {
    done = true;
    observer.disconnect();
    window.clearTimeout(timer);
  }
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  return stop;
}
