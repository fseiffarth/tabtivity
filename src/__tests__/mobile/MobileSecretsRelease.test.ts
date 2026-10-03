import { describe, expect, it } from "vitest";
import { answerUnlock, b64url, context, transportKey, unb64url } from "../../../mobile-web/src/secrets";
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
});
