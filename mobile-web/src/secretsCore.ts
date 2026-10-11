/**
 * The device's cryptography for a hosted server's secrets key (plan §6.8;
 * the daemon's half is `services::server::vault` and `secrets`), apart from
 * any request layer: the phone (`secrets.ts`, through `api`) and the browser
 * client's Server settings (`ServerSecrets.tsx`, through `fetch`) both pass
 * in how to POST. Same origin, so both read the same IndexedDB records.
 *
 * - **The unlock exchange** ([`answerUnlock`]): checks the daemon's
 *   signature over X and the transport key E against the pinned identity,
 *   then sends `ECDH(device, X)` sealed to `ECDH(T, E)`.
 * - **Signed actions** ([`signedAction`]): set-up and a new recovery code
 *   carry the pairing key's signature over a single-use nonce (user decision
 *   2026-10-03); the payload is built here, never taken from the server.
 * - **Re-pinning** ([`checkRepin`], [`repinIdentity`]): when the daemon's
 *   identity key changed (lost and made anew), the recovery code typed on
 *   this device decides whether the new one is trusted. The code never
 *   leaves the device: it gives K (through the code's key `r` and the
 *   recovery wrap) and the auth key A, and from those the sealed A the
 *   daemon holds — the binding the daemon sent must be made from it.
 */
import { BRAND } from "../../src/lib/brand";
import { loadDevice, openAuthDatabase, STORE } from "./authStore";

const SECRETS = "secrets";

export interface SecretsRecord { deviceId: string; ecdhPrivateKey: CryptoKey; identity: string }

export type UnlockStart =
  | { state: "unlocked" | "not-set-up" | "no-wrap" }
  | { state: "locked"; id: string; payload: string; ephemeral: string; transport: string; signature: string };

/** `Vault::repin_offer`. */
export interface RepinOffer {
  identity: string;
  salt: string;
  public: string;
  ephemeral: string;
  nonce: string;
  sealed: string;
  authNonce: string;
  binding: string;
}

/** How a caller POSTs JSON and reads the JSON answer (throws on an error). */
export type Post = <T>(path: string, body: unknown) => Promise<T>;

const encode = (text: string) => new TextEncoder().encode(text);

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let raw = "";
  for (const byte of view) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64url(text: string): Uint8Array<ArrayBuffer> {
  const raw = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/** `<slug>-secrets-v1:<purpose>`: `secrets::context` on the daemon. */
export function context(purpose: string): string {
  return `${BRAND.slug}-secrets-v1:${purpose}`;
}

/** HKDF-SHA256 → an AES-256-GCM key; the daemon's `vault::hkdf32`. */
export async function transportKey(salt: Uint8Array<ArrayBuffer>, ikm: ArrayBuffer | Uint8Array<ArrayBuffer>, info: string, usage: KeyUsage[], extractable = false): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: encode(info) },
    base,
    { name: "AES-GCM", length: 256 },
    extractable,
    usage,
  );
}

/** HKDF-SHA256 to 32 raw bytes (`secrets::derive`). */
async function hkdfBytes(salt: Uint8Array<ArrayBuffer>, ikm: ArrayBuffer | Uint8Array<ArrayBuffer>, info: string): Promise<Uint8Array<ArrayBuffer>> {
  const base = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: encode(info) }, base, 256));
}

export async function loadSecrets(): Promise<SecretsRecord | null> {
  const database = await openAuthDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE).objectStore(STORE).get(SECRETS);
    request.onsuccess = () => resolve((request.result as SecretsRecord | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

export async function saveSecrets(record: SecretsRecord): Promise<void> {
  const database = await openAuthDatabase();
  await new Promise<void>((resolve, reject) => {
    const request = database.transaction(STORE, "readwrite").objectStore(STORE).put(record, SECRETS);
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
  });
}

/** The device's answer to a locked start, or `null` when the start is not
 * what this device can trust (wrong signature, someone else's fields). */
export async function answerUnlock(record: SecretsRecord, start: Extract<UnlockStart, { state: "locked" }>, origin: string): Promise<Record<string, string> | null> {
  const identity = await crypto.subtle.importKey("spki", unb64url(record.identity), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const signed = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, identity, unb64url(start.signature), encode(start.payload));
  const expected = [context("unlock"), origin, record.deviceId, start.id, start.ephemeral, start.transport].join("\n");
  if (!signed || start.payload !== expected) return null;
  const x = await crypto.subtle.importKey("raw", unb64url(start.ephemeral), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const released = await crypto.subtle.deriveBits({ name: "ECDH", public: x }, record.ecdhPrivateKey, 256);
  const t = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const tRaw = new Uint8Array(await crypto.subtle.exportKey("raw", t.publicKey));
  const eRaw = unb64url(start.transport);
  const e = await crypto.subtle.importKey("raw", eRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: e }, t.privateKey, 256);
  const salt = new Uint8Array(new ArrayBuffer(eRaw.length + tRaw.length));
  salt.set(eRaw, 0);
  salt.set(tRaw, eRaw.length);
  const key = await transportKey(salt, shared, `${context("transport")}${start.id}`, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: encode(`${record.deviceId}\n${start.id}`) },
    key,
    released,
  );
  return { id: start.id, transport: b64url(tRaw), nonce: b64url(nonce), sealed: b64url(sealed) };
}

/** Release a locked key through the unlock exchange (`untrusted`: the start
 * is not signed by the pinned identity; nothing is sent then). */
export async function unlockWith(post: Post, origin = location.origin): Promise<string> {
  const record = await loadSecrets();
  if (!record) return "unenrolled";
  const start = await post<UnlockStart>("/api/v1/secrets/unlock", {});
  if (start.state !== "locked") return start.state;
  const answer = await answerUnlock(record, start, origin);
  if (!answer) return "untrusted";
  await post("/api/v1/secrets/unlock/finish", answer);
  return "released";
}

/** `Vault::action_payload`: what the pairing key signs for `action`. */
export function actionPayload(origin: string, deviceId: string, action: string, nonce: string, expiresAt: number): string {
  return [context("action"), origin, deviceId, action, nonce, String(expiresAt)].join("\n");
}

/** The body of a signed secrets action (`secrets-setup`,
 * `secrets-recovery-code`): a nonce from the daemon, signed by this
 * device's pairing key. Throws `unpaired` where this browser holds none. */
export async function signedAction(action: string, post: Post, origin = location.origin): Promise<{ nonce: string; signature: string }> {
  const device = await loadDevice();
  if (!device) throw new Error("unpaired");
  const challenge = await post<{ nonce: string; expiresAt: number }>("/api/v1/secrets/challenge", { action });
  // Only a nonce and a time go into the signed text: a server that sent a
  // line break could otherwise shape what this key signs.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(challenge.nonce) || !Number.isSafeInteger(challenge.expiresAt)) throw new Error("invalid_challenge");
  const payload = actionPayload(origin, device.deviceId, action, challenge.nonce, challenge.expiresAt);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, device.privateKey, encode(payload));
  return { nonce: challenge.nonce, signature: b64url(signature) };
}

/** P-256's group order n, big-endian. */
const ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

function toBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/** The code as the daemon's `normalize_code` reads it: 32 lowercase hex
 * digits, as bytes; `null` when it is not a code. */
function normalizeCode(code: string): Uint8Array<ArrayBuffer> | null {
  const hex = code.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  return hex.length === 32 ? encode(hex) : null;
}

/** `secrets::recovery_scalar`: the first of `…`, `…1`, … under n. */
async function recoveryScalar(code: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  for (let round = 0; round < 8; round += 1) {
    const info = round === 0 ? context("recovery-scalar") : `${context("recovery-scalar")}${round}`;
    const bytes = await hkdfBytes(salt, code, info);
    const value = toBigInt(bytes);
    if (value > 0n && value < ORDER) return bytes;
  }
  throw new Error("no recovery key for this code");
}

/** `secrets::check_repin`: does the code confirm `offer.identity`? */
export async function checkRepin(code: string, offer: RepinOffer, origin: string): Promise<boolean> {
  try {
    const ikm = normalizeCode(code);
    if (!ikm) return false;
    const salt = unb64url(offer.salt);
    const d = await recoveryScalar(ikm, salt);
    const r = unb64url(offer.public);
    if (r.length !== 65 || r[0] !== 4) return false;
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", d: b64url(d), x: b64url(r.slice(1, 33)), y: b64url(r.slice(33)), ext: false },
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
    const xRaw = unb64url(offer.ephemeral);
    const x = await crypto.subtle.importKey("raw", xRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: x }, key, 256);
    const kek = await transportKey(xRaw, shared, context("recovery"), ["decrypt"]);
    const k = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64url(offer.nonce), additionalData: encode("recovery") }, kek, unb64url(offer.sealed)));
    if (k.length !== 32) return false;
    const a = await hkdfBytes(salt, ikm, context("recovery-auth-key"));
    const sub = await transportKey(new Uint8Array(new ArrayBuffer(0)), k, context("recovery-auth"), ["encrypt"]);
    k.fill(0);
    const authNonce = unb64url(offer.authNonce);
    if (authNonce.length !== 12) return false;
    const sealedAuth = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: authNonce, additionalData: encode("recovery-auth") }, sub, a));
    a.fill(0);
    const binding = await hkdfBytes(new Uint8Array(new ArrayBuffer(0)), sealedAuth, `${context("identity")}\n${origin}\n${offer.identity}`);
    return b64url(binding) === offer.binding;
  } catch {
    return false;
  }
}

export type RepinOutcome = "repinned" | "mismatch" | "unenrolled";

/** Trust the daemon's (new) identity key if the recovery code confirms it.
 * Nothing changes on `mismatch`. */
export async function repinIdentity(code: string, post: Post, origin = location.origin): Promise<RepinOutcome> {
  const offer = await post<RepinOffer>("/api/v1/secrets/repin", {});
  if (!(await checkRepin(code, offer, origin))) return "mismatch";
  const record = await loadSecrets();
  // Nothing pinned yet: the next sign-in enrols and pins as on first use.
  if (!record) return "unenrolled";
  await saveSecrets({ ...record, identity: offer.identity });
  return "repinned";
}
