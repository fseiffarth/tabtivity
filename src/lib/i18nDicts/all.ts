/**
 * TEST-ONLY aggregation of every dictionary. The app loads the non-English
 * dictionaries lazily (see `lib/i18n.ts`), so importing this module from app
 * code would statically pull all four back into the startup chunk — exactly
 * what the split exists to prevent. The key-parity tests need the full set
 * synchronously; importing this module also registers every dictionary, so
 * `translate` answers in all five languages without awaiting a chunk.
 */
import { fillBrand } from "../brand";
import { en, registerDict, type Dict, type Language } from "../i18n";
import { dict as de } from "./de";
import { dict as es } from "./es";
import { dict as fr } from "./fr";
import { dict as it } from "./it";

/** Every language's block must cover the same keys English defines, or a UI
 *  string silently renders in English for four of the five languages with
 *  nothing failing — the parity tests compare against this map. `{app}` is
 *  filled, as it is in what `translate` reads. */
export const TRANSLATIONS: Record<Language, Dict> = {
  en,
  de: fillBrand(de),
  es: fillBrand(es),
  fr: fillBrand(fr),
  it: fillBrand(it),
};

registerDict("de", de);
registerDict("es", es);
registerDict("fr", fr);
registerDict("it", it);
