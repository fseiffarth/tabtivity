/**
 * The device's half of a hosted server's device-released secrets key
 * (hosted plan §6.8; the daemon's half is `services::server::vault`).
 *
 * After every sign-in on a server the phone (or a browser paired at `/`)
 * makes sure it has enrolled an ECDH key — non-extractable, in the same
 * IndexedDB as its signing key — and pinned the daemon's identity key; then,
 * if the key is locked (the server rebooted), it releases it: it checks the
 * daemon's signature over X and the transport key E, computes
 * `ECDH(device, X)` inside WebCrypto and sends it back sealed to
 * `ECDH(T, E)`, so the TLS-terminating gateway sees only ciphertext.
 *
 * Off a server (the desktop's own sidecar) `GET /api/v1/secrets` answers
 * `available: false` and nothing else happens. Never throws: a failure here
 * must not cost the sign-in it follows.
 */
import { api } from "./api";
import { deviceRecord, openAuthDatabase } from "./auth";
import { BRAND } from "../../src/lib/brand";

const STORE = "keys";
const SECRETS = "secrets";

interface SecretsRecord { deviceId: string; ecdhPrivateKey: CryptoKey; identity: string }

interface SecretsState { available: boolean; setUp?: boolean; unlocked?: boolean; enrolled?: boolean }

type UnlockStart =
  | { state: "unlocked" | "not-set-up" | "no-wrap" }
  | { state: "locked"; id: string; payload: string; ephemeral: string; transport: string; signature: string };

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
export async function transportKey(salt: Uint8Array<ArrayBuffer>, ikm: ArrayBuffer, info: string, usage: KeyUsage[], extractable = false): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode(info) },
    base,
    { name: "AES-GCM", length: 256 },
    extractable,
    usage,
  );
}

async function loadSecrets(): Promise<SecretsRecord | null> {
  const database = await openAuthDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE).objectStore(STORE).get(SECRETS);
    request.onsuccess = () => resolve((request.result as SecretsRecord | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

async function saveSecrets(record: SecretsRecord): Promise<void> {
  const database = await openAuthDatabase();
  await new Promise<void>((resolve, reject) => {
    const request = database.transaction(STORE, "readwrite").objectStore(STORE).put(record, SECRETS);
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
  });
}

/** Enrol a fresh ECDH key, signed by the pairing key; pin the identity. */
async function enrol(device: { deviceId: string; privateKey: CryptoKey }): Promise<SecretsRecord> {
  const keys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const ecdh = b64url(await crypto.subtle.exportKey("raw", keys.publicKey));
  const payload = `${context("enrol")}\n${location.origin}\n${device.deviceId}\n${ecdh}`;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, device.privateKey, new TextEncoder().encode(payload));
  const answer = await api<{ identity: string }>("/api/v1/secrets/enrol", {
    method: "POST",
    body: JSON.stringify({ ecdh_public_key: ecdh, signature: b64url(signature) }),
  });
  const record = { deviceId: device.deviceId, ecdhPrivateKey: keys.privateKey, identity: answer.identity };
  await saveSecrets(record);
  return record;
}

/** The device's answer to a locked start, or `null` when the start is not
 * what this device can trust (wrong signature, someone else's fields). */
export async function answerUnlock(record: SecretsRecord, start: Extract<UnlockStart, { state: "locked" }>, origin: string): Promise<Record<string, string> | null> {
  const identity = await crypto.subtle.importKey("spki", unb64url(record.identity), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const signed = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, identity, unb64url(start.signature), new TextEncoder().encode(start.payload));
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
    { name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(`${record.deviceId}\n${start.id}`) },
    key,
    released,
  );
  return { id: start.id, transport: b64url(tRaw), nonce: b64url(nonce), sealed: b64url(sealed) };
}

/** Enrol if needed, then release the key if it is locked. Answers what it
 * found, for the trace; never throws. */
export async function releaseSecrets(): Promise<string> {
  try {
    const state = await api<SecretsState>("/api/v1/secrets");
    if (!state.available) return "off";
    const device = await deviceRecord();
    if (!device) return "unpaired";
    let record = await loadSecrets();
    if (!record || record.deviceId !== device.deviceId || !state.enrolled) record = await enrol(device);
    if (!state.setUp || state.unlocked) return state.setUp ? "unlocked" : "not-set-up";
    const start = await api<UnlockStart>("/api/v1/secrets/unlock", { method: "POST", body: "{}" });
    if (start.state !== "locked") return start.state;
    const answer = await answerUnlock(record, start, location.origin);
    if (!answer) return "untrusted";
    await api("/api/v1/secrets/unlock/finish", { method: "POST", body: JSON.stringify(answer) });
    return "released";
  } catch {
    return "failed";
  }
}
