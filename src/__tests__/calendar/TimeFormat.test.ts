import { describe, expect, it } from "vitest";

import { defaultUse24h, resolveUse24h } from "../../lib/timeFormat";
import { localeUses24h, osUse24hFrom } from "../../lib/osClock";
import { formatLongDate, formatStampTime, formatTime } from "../../lib/calendar/calendarTime";
import { registerDict, useI18nStore } from "../../lib/i18n";
import { dict as es } from "../../lib/i18nDicts/es";

/**
 * The app-wide clock.
 *
 * Three questions, and the last is the one worth pinning: what a language
 * implies, what the OS's report says, and which input wins when more than one
 * has an opinion.
 */

describe("defaultUse24h", () => {
  it("gives English AM/PM and everything else 24-hour", () => {
    expect(defaultUse24h("en")).toBe(false);
    expect(defaultUse24h("de")).toBe(true);
    expect(defaultUse24h("es")).toBe(true);
    expect(defaultUse24h("fr")).toBe(true);
    expect(defaultUse24h("it")).toBe(true);
  });
});

describe("resolveUse24h", () => {
  it("follows the OS while nothing is set, whatever the language", () => {
    // The case this default exists for: an English UI on a 24-hour desktop.
    expect(resolveUse24h(undefined, undefined, true, "en")).toBe(true);
    expect(resolveUse24h(undefined, undefined, false, "de")).toBe(false);
  });

  it("falls back to the language when the OS has no opinion", () => {
    expect(resolveUse24h(undefined, undefined, null, "en")).toBe(false);
    expect(resolveUse24h(undefined, undefined, undefined, "de")).toBe(true);
    // `null` is the same statement as absent — it is what clearing a setting
    // leaves behind, and reading it as `false` would silently pick 12-hour.
    expect(resolveUse24h(null, null, null, "de")).toBe(true);
  });

  it("lets an explicit choice beat the OS and the language, in both directions", () => {
    // The half that a `?? false` read would get wrong: a user who deliberately
    // turned 24-hour on against a 12-hour OS, and one who turned it off.
    expect(resolveUse24h(true, undefined, false, "en")).toBe(true);
    expect(resolveUse24h(false, undefined, true, "de")).toBe(false);
  });

  it("carries the retired calendar-only key over, but never above a real choice", () => {
    expect(resolveUse24h(undefined, true, false, "en")).toBe(true);
    expect(resolveUse24h(false, true, null, "de")).toBe(false);
  });
});

describe("osUse24hFrom", () => {
  it("takes the desktop's explicit switch over its locale", () => {
    expect(osUse24hFrom({ use24h: true, locale: "en-US" })).toBe(true);
    expect(osUse24hFrom({ use24h: false, locale: "de-DE" })).toBe(false);
  });

  it("asks ICU about the locale when the desktop has no switch", () => {
    expect(osUse24hFrom({ use24h: null, locale: "de-DE" })).toBe(true);
    expect(osUse24hFrom({ use24h: null, locale: "en-US" })).toBe(false);
  });

  it("reads anything malformed as no opinion", () => {
    expect(osUse24hFrom(undefined)).toBeNull();
    expect(osUse24hFrom({ use24h: null, locale: null })).toBeNull();
    expect(osUse24hFrom({ use24h: "yes" })).toBeNull();
    expect(localeUses24h("not a locale!")).toBeNull();
  });
});

describe("formatTime", () => {
  it("leaves a 24-hour clock alone", () => {
    expect(formatTime("09:00", true)).toBe("09:00");
    expect(formatTime("17:05", true)).toBe("17:05");
  });

  it("reads the whole day in AM/PM, including both noons", () => {
    expect(formatTime("00:00", false)).toBe("12:00 AM");
    expect(formatTime("09:05", false)).toBe("9:05 AM");
    expect(formatTime("12:00", false)).toBe("12:00 PM");
    expect(formatTime("17:30", false)).toBe("5:30 PM");
    expect(formatTime("23:59", false)).toBe("11:59 PM");
  });

  it("returns anything that is not a clock unchanged", () => {
    // The empty string is the common one: `timePart` gives it for every
    // date-only stamp, and the naive guard turned it into "12:undefined AM".
    expect(formatTime("", false)).toBe("");
    expect(formatTime("tomorrow", false)).toBe("tomorrow");
    expect(formatTime("31:00", false)).toBe("31:00");
  });

  it("gives a date-only stamp no clock at all", () => {
    expect(formatStampTime("2026-07-08", false)).toBe("");
    expect(formatStampTime("2026-07-08T17:00", false)).toBe("5:00 PM");
    expect(formatStampTime("2026-07-08T17:00", true)).toBe("17:00");
  });
});


describe("calendar display in the app language", () => {
  it("spells the day period in the app language, by default and when passed", () => {
    registerDict("es", es);
    const before = useI18nStore.getState().lang;
    try {
      expect(formatTime("09:05", false, "es")).toBe("9:05 a. m.");
      expect(formatTime("17:30", false, "en")).toBe("5:30 PM");
      useI18nStore.setState({ lang: "es" });
      expect(formatTime("17:30", false)).toBe("5:30 p. m.");
      expect(formatStampTime("2026-07-08T09:00", false)).toBe("9:00 a. m.");
      // A 24-hour clock has no day period to spell.
      expect(formatTime("17:30", true)).toBe("17:30");
    } finally {
      useI18nStore.setState({ lang: before });
    }
  });

  it("spells a long date in the app language unless told otherwise", () => {
    const before = useI18nStore.getState().lang;
    try {
      useI18nStore.setState({ lang: "de" });
      expect(formatLongDate("2026-07-08")).toContain("Juli");
      expect(formatLongDate("2026-07-08", "en")).toContain("July");
    } finally {
      useI18nStore.setState({ lang: before });
    }
  });
});
