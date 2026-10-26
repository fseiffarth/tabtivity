/**
 * The display rule for end-to-end signatures (`docs/mail_encryption_plan.md`
 * §4), asserted on the frontend side of the boundary.
 *
 * The rule itself lives in Rust and is tested there; what this file pins is the
 * *rendering* half — that no state but `verified` ever gets positive chrome, and
 * that a message the reader cannot read is never toned as though everything is
 * fine. Both are one-line functions, which is exactly why they need a test: a
 * one-line function is the kind that gets "simplified" into saying something
 * else.
 */
import { describe, it, expect } from "vitest";
import { formatFingerprint, mailCryptoNoteKey, mailCryptoTone } from "../../lib/mail";
import { TRANSLATIONS } from "../../lib/i18n/all";
import type { MailCryptoInfo, MailCryptoState } from "../../types/mail";

function info(over: Partial<MailCryptoInfo> = {}): MailCryptoInfo {
  return {
    format: "openpgp",
    encrypted: false,
    decrypted: false,
    signed: true,
    state: "known",
    supported: true,
    notes: [],
    ...over,
  };
}

describe("mail crypto display", () => {
  it("gives positive chrome to `verified` and to nothing else", () => {
    // The single assertion the whole feature's honesty rests on. `known` is the
    // one most likely to be "improved" into good: it IS a valid signature — it
    // just says nothing about who sent the message, because nobody checked the
    // key.
    const states: MailCryptoState[] = [
      "none",
      "verified",
      "unaligned",
      "known",
      "invalid",
      "nokey",
      "unusable",
      "unsupported",
    ];
    const positive = states.filter((state) => mailCryptoTone(info({ state })) === "good");
    expect(positive).toEqual(["verified"]);
  });

  it("never tones a message the reader cannot read as good", () => {
    // An encrypted message that would not open is a warning whatever its
    // signature says: the reader is looking at something they cannot read, and
    // a green panel above it would describe the wrong thing.
    expect(mailCryptoTone(info({ state: "verified", encrypted: true, decrypted: false }))).toBe(
      "warn",
    );
    expect(mailCryptoTone(info({ state: "verified", encrypted: true, decrypted: true }))).toBe(
      "good",
    );
    // …and a bad signature stays bad rather than being softened to a warning.
    expect(mailCryptoTone(info({ state: "invalid", encrypted: true, decrypted: false }))).toBe(
      "bad",
    );
  });

  it("keeps `invalid` and `nokey` apart", () => {
    // "This is forged" and "I cannot tell" are different sentences and must not
    // share an appearance.
    expect(mailCryptoTone(info({ state: "invalid" }))).toBe("bad");
    expect(mailCryptoTone(info({ state: "nokey" }))).not.toBe("bad");
  });

  it("has wording for every note the backend can emit", () => {
    // The backend speaks in machine tokens so the wording can live in i18n ×5.
    // A token with no key renders as nothing, which is safe but silent — and the
    // note most worth having is `headers-not-signed`, the thing users most
    // reliably assume a tick covers.
    const tokens = [
      "headers-not-signed",
      "signer-key-unverified",
      "signer-not-aligned",
      "signer-key-missing",
      "signature-invalid",
      "format-not-supported",
      "inline-signature-not-checked",
      "decrypt-failed",
      "decrypt-no-key",
      "decrypt-locked",
    ];
    for (const token of tokens) {
      const key = mailCryptoNoteKey(token);
      expect(key, `no wording for ${token}`).not.toBeNull();
      expect(typeof (TRANSLATIONS.en as Record<string, string>)[key!]).toBe("string");
    }
  });

  it("renders an unknown note token as nothing rather than as the token", () => {
    // A user shown `signer-key-unverified` learns less than one shown nothing.
    expect(mailCryptoNoteKey("some-future-token")).toBeNull();
  });

  it("groups a fingerprint so it can actually be compared", () => {
    // 40 run-together hex characters do not get compared, they get glanced at —
    // and a glanced-at fingerprint is OpenPGP's trust model quietly failing.
    expect(formatFingerprint("ABCD1234ABCD1234ABCD1234ABCD1234ABCD1234")).toBe(
      "ABCD 1234 ABCD 1234 ABCD 1234 ABCD 1234 ABCD 1234",
    );
    expect(formatFingerprint("")).toBe("");
  });

  it("has wording for every signature state, in every language", () => {
    const states: MailCryptoState[] = [
      "none",
      "verified",
      "unaligned",
      "known",
      "invalid",
      "nokey",
      "unusable",
      "unsupported",
    ];
    for (const lang of Object.keys(TRANSLATIONS) as (keyof typeof TRANSLATIONS)[]) {
      for (const state of states) {
        const dict = TRANSLATIONS[lang] as Record<string, string>;
        expect(typeof dict[`mail.crypto.state.${state}`], `${lang}/${state}`).toBe("string");
      }
    }
  });
});
