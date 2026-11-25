import { type Language } from "../../src/lib/i18n";
import { matchStartWord, mayAskHelp, mayEditDraft, mayNavigate } from "../../src/lib/voice/voiceCommands";
import { type StartLexicon } from "./voiceInput";

/** The start word, as the utterance layer asks for it (`voiceInput.ts`), in
 * the language spoken: the matcher's `matchStartWord` / `mayNavigate`, over
 * the heard words (`mayNavigate` also holds back what may be a draft edit or
 * a "Tabby help"). */
export function startLexicon(lang: Language): StartLexicon {
  return {
    start(words) {
      const found = matchStartWord(words.join(" "), lang);
      if (!found) return 0;
      return words.length - (found.rest ? found.rest.split(" ").length : 0);
    },
    // Held until it settles: it may be "navigate …", "help" or a spoken draft
    // edit ("scratch that", "plan").
    mayNavigate: (words) => {
      const text = words.join(" ");
      return mayNavigate(text, lang) || mayEditDraft(text, lang) || mayAskHelp(text, lang);
    },
  };
}
