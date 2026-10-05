import { beforeEach, describe, expect, it } from "vitest";
import { readSpeechLang, speechLangLabel, speechTag, SPEECH_LANGS, writeSpeechLang } from "../../../mobile-web/src/speechLang";
import { BRAND, storageKey } from "../../lib/brand";

describe(`${BRAND.display} Mobile voice language`, () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("offers the phone's own language and every app language", () => {
    expect([...SPEECH_LANGS]).toEqual(["auto", "en", "de", "es", "fr", "it"]);
    expect(speechLangLabel("auto")).toBeNull();
    expect(speechLangLabel("de")).toBe("Deutsch");
  });

  it("follows the browser until a language is chosen", () => {
    expect(readSpeechLang()).toBe("auto");
    expect(speechTag("auto", { language: "de-AT" })).toBe("de-AT");
    // A browser that reports nothing is read as US English, not left to the
    // engine's guess.
    expect(speechTag("auto", { language: "" })).toBe("en-US");
    expect(speechTag("auto", {})).toBe("en-US");
  });

  it("asks for a region-tagged language once one is chosen", () => {
    writeSpeechLang("de");
    expect(readSpeechLang()).toBe("de");
    expect(localStorage.getItem(storageKey("mobile.speechLang"))).toBe("de");
    // The phone's own language no longer decides it.
    expect(speechTag(readSpeechLang(), { language: "en-GB" })).toBe("de-DE");
    expect(speechTag("fr")).toBe("fr-FR");
  });

  it("falls back to the phone when the stored value is not a language", () => {
    localStorage.setItem(storageKey("mobile.speechLang"), "kl");
    expect(readSpeechLang()).toBe("auto");
  });
});
