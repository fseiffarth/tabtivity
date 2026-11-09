import { type Language } from "../../src/lib/i18n";
import { matchStartWord, mayNavigate } from "../../src/lib/voice/voiceCommands";
import { type StartLexicon } from "./voiceInput";

/** The start word, as the utterance layer asks for it (`voiceInput.ts`), in
 * the language spoken: the matcher's `matchStartWord` / `mayNavigate`, over
 * the heard words. */
export function startLexicon(lang: Language): StartLexicon {
  return {
    start(words) {
      const found = matchStartWord(words.join(" "), lang);
      if (!found) return 0;
      return words.length - (found.rest ? found.rest.split(" ").length : 0);
    },
    mayNavigate: (words) => mayNavigate(words.join(" "), lang),
  };
}
