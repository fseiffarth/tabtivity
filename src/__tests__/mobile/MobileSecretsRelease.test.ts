import { describe, expect, it } from "vitest";
import { answerUnlock, b64url, checkRepin, context, transportKey, unb64url } from "../../../mobile-web/src/secrets";
import { actionPayload } from "../../../mobile-web/src/secretsCore";
import { BRAND } from "../../lib/brand";

const ORIGIN = "https://desk.example.ts.net";
const ecdh = { name: "ECDH", namedCurve: "P-256" } as const;
const ecdsa = { name: "ECDSA", namedCurve: "P-256" } as const;

/** The daemon's half (`services::server::vault`), in WebCrypto: identity
 * key, a wrap's X, a fresh transport key E, the signed start. */
async function daemon(deviceId: string, devicePublic: CryptoKey) {
  const identity = await crypto.subtle.generateKey(ecdsa, false, ["sign", "verify"]);
  const x = await crypto.subtle.generateKey(ecdh, true, ["deriveBits"]);
  const e = await crypto.subtle.generateKey(ecdh, true, ["deriveBits"]);
  const ephemeral = b64url(await crypto.subtle.exportKey("raw", x.publicKey));
  const transport = b64url(await crypto.subtle.exportKey("raw", e.publicKey));
  const id = "exchange_1";
  const payload = [context("unlock"), ORIGIN, deviceId, id, ephemeral, transport].join("\n");
  const signature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, identity.privateKey, new TextEncoder().encode(payload)));
  const expected = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: devicePublic }, x.privateKey, 256));
  return {
    identity: b64url(await crypto.subtle.exportKey("spki", identity.publicKey)),
    start: { state: "locked" as const, id, payload, ephemeral, transport, signature },
    expected,
    /** `finish_unlock`: open the device's answer. */
    async open(answer: Record<string, string>): Promise<Uint8Array> {
      const tRaw = unb64url(answer.transport);
      const t = await crypto.subtle.importKey("raw", tRaw, ecdh, false, []);
      const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: t }, e.privateKey, 256);
      const eRaw = unb64url(transport);
      const salt = new Uint8Array(new ArrayBuffer(eRaw.length + tRaw.length));
      salt.set(eRaw, 0);
      salt.set(tRaw, eRaw.length);
      const key = await transportKey(salt, shared, `${context("transport")}${id}`, ["decrypt"]);
      return new Uint8Array(await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: unb64url(answer.nonce), additionalData: new TextEncoder().encode(`${deviceId}\n${id}`) },
        key,
        unb64url(answer.sealed),
      ));
    },
  };
}

describe(`${BRAND.display} server secrets release`, () => {
  it("derives the transport key exactly as the daemon does", async () => {
    // `vault::tests::hkdf_matches_the_browsers_vector`: the same inputs, the same 32 bytes.
    const salt = new Uint8Array(new ArrayBuffer(130)).fill(1);
    const ikm = new Uint8Array(32).fill(2).buffer;
    const key = await transportKey(salt, ikm, "slug-secrets-v1:transportid", ["encrypt"], true);
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
    expect([...raw].map((b) => b.toString(16).padStart(2, "0")).join("")).toBe("5a006dd92eb477578317865f80184da915d4069bd41cd41c564de0ff7e4d946c");
  });

  it("answers a signed start with the wrap's shared value, readable only with E", async () => {
    const device = await crypto.subtle.generateKey(ecdh, false, ["deriveBits"]);
    const server = await daemon("dev_phone_000001", device.publicKey);
    const record = { deviceId: "dev_phone_000001", ecdhPrivateKey: device.privateKey, identity: server.identity };
    const answer = await answerUnlock(record, server.start, ORIGIN);
    expect(answer).not.toBeNull();
    expect(answer!.sealed).not.toContain(b64url(server.expected));
    expect(await server.open(answer!)).toEqual(server.expected);
  });

  it("releases nothing to a start it cannot trust", async () => {
    const device = await crypto.subtle.generateKey(ecdh, false, ["deriveBits"]);
    const server = await daemon("dev_phone_000001", device.publicKey);
    const impostor = await daemon("dev_phone_000001", device.publicKey);
    const record = { deviceId: "dev_phone_000001", ecdhPrivateKey: device.privateKey, identity: server.identity };
    // Signed by another identity than the pinned one (a gateway in the middle).
    expect(await answerUnlock(record, impostor.start, ORIGIN)).toBeNull();
    // The right signature, but for another origin or another device.
    expect(await answerUnlock(record, server.start, "https://other.example")).toBeNull();
    expect(await answerUnlock({ ...record, deviceId: "dev_other_000001" }, server.start, ORIGIN)).toBeNull();
    // A field swapped after signing.
    expect(await answerUnlock(record, { ...server.start, transport: impostor.start.transport }, ORIGIN)).toBeNull();
  });

  // `vault::tests::the_repin_vector_checks`: made by the daemon, checked here
  // exactly as a phone re-pins a changed identity key with its recovery code.
  const offer = {
    identity: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEKkDURY8Syd9-UTEdLF0YhWAyoWJ34Iaf8hcJyIZne5Z8ERpICQjhw9039TemZ1DEY_mNAye8h1svmWfleHLNOw",
    salt: "Y1NhEUVqetU8Ee2LPjHvHw",
    public: "BDsolR8Xuro9UbcrPIUBXI7HdcXBNfuhYVMoObI6i6Ajmus9zbe4BD1gvLTSKvsjlA82fZZ44O-maPN8GcHGZbc",
    ephemeral: "BKqQH8LgudJ_fBD56lEsYJdgMFzV0w_C0HtCFcHEHIA6KpWv59lA2SdS6U_GBtuwEgC_9YlyggmP1gtbMjktm50",
    nonce: "LWrwX_Jrtxdv4NkD",
    sealed: "gVCmwcvNbmSD-rvI_VQqyOZIC6BbL_WhTVLZJp4qviRmVYkOuyV8rMF-fZtnfj05",
    authNonce: "FjrRrJmXuzIBw9ud",
    binding: "hZ_YVpo4uqHK94P-YZpujj64pDLzzPw5jfLubTaCt_U",
  };
  const code = "8ef8-e89b-c049-e1a0-373c-4944-2858-41c0";

  it("re-pins only an identity the recovery code confirms", async () => {
    expect(await checkRepin(code, offer, ORIGIN)).toBe(true);
    expect(await checkRepin(code.toUpperCase().replace(/-/g, " "), offer, ORIGIN)).toBe(true);
    expect(await checkRepin("0000-0000-0000-0000-0000-0000-0000-0000", offer, ORIGIN)).toBe(false);
    expect(await checkRepin(code, offer, "https://other.example")).toBe(false);
    // A key of someone in the middle under the genuine binding, or a binding
    // the middle made itself: neither checks.
    const middle = await crypto.subtle.generateKey(ecdsa, true, ["sign", "verify"]);
    const spki = b64url(await crypto.subtle.exportKey("spki", middle.publicKey));
    expect(await checkRepin(code, { ...offer, identity: spki }, ORIGIN)).toBe(false);
    expect(await checkRepin(code, { ...offer, binding: b64url(new Uint8Array(32)) }, ORIGIN)).toBe(false);
    expect(await checkRepin("not a code", offer, ORIGIN)).toBe(false);
  });

  it("signs set-up and new codes over its own text, not the server's", () => {
    expect(actionPayload(ORIGIN, "dev_phone_000001", "secrets-setup", "abc_DEF-1", 1700000000).split("\n")).toEqual([
      context("action"), ORIGIN, "dev_phone_000001", "secrets-setup", "abc_DEF-1", "1700000000",
    ]);
  });
});
