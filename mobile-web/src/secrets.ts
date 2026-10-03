/**
 * The device's half of a hosted server's device-released secrets key
 * (hosted plan §6.8; the daemon's half is `services::server::vault`; the
 * cryptography is `secretsCore.ts`).
 *
 * After every sign-in on a server the phone (or a browser paired at `/`)
 * makes sure it has enrolled an ECDH key — non-extractable, in the same
 * IndexedDB as its signing key — and pinned the daemon's identity key; then,
 * if the key is locked (the server rebooted), it releases it: it checks the
 * daemon's signature over X and the transport key E, computes
 * `ECDH(device, X)` inside WebCrypto and sends it back sealed to
 * `ECDH(T, E)`, so the TLS-terminating gateway sees only ciphertext.
 *
 * The pin is first-use only: an identity that differs from the pinned one
 * (the daemon's key was lost, or someone in the middle) is never adopted
 * here — the answer is `untrusted`, and only the recovery code re-pins it
 * (`repinIdentity`, from the phone's prompt or the Server settings).
 *
 * Off a server (the desktop's own sidecar) `GET /api/v1/secrets` answers
 * `available: false` and nothing else happens. Never throws: a failure here
 * must not cost the sign-in it follows.
 */
import { api } from "./api";
import { loadDevice } from "./authStore";
import { b64url, context, loadSecrets, repinIdentity, saveSecrets, unlockWith, type Post, type RepinOutcome, type SecretsRecord } from "./secretsCore";

export { answerUnlock, b64url, checkRepin, context, transportKey, unb64url } from "./secretsCore";

interface SecretsState { available: boolean; setUp?: boolean; unlocked?: boolean; enrolled?: boolean; identity?: string | null }

/** The phone's POST through its request layer. */
const post: Post = <T,>(path: string, body: unknown) => api<T>(path, { method: "POST", body: JSON.stringify(body) });

/** Enrol a fresh ECDH key, signed by the pairing key. The identity the
 * daemon answers is pinned only if nothing was pinned before; a different
 * one keeps the old pin (`untrusted` follows). */
async function enrol(device: { deviceId: string; privateKey: CryptoKey }, pinned: string | null): Promise<SecretsRecord> {
  const keys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const ecdh = b64url(await crypto.subtle.exportKey("raw", keys.publicKey));
  const payload = `${context("enrol")}\n${location.origin}\n${device.deviceId}\n${ecdh}`;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, device.privateKey, new TextEncoder().encode(payload));
  const answer = await post<{ identity: string }>("/api/v1/secrets/enrol", { ecdh_public_key: ecdh, signature: b64url(signature) });
  const record = { deviceId: device.deviceId, ecdhPrivateKey: keys.privateKey, identity: pinned ?? answer.identity };
  await saveSecrets(record);
  return record;
}

/** Enrol if needed, then release the key if it is locked. Answers what it
 * found, for the trace (`untrusted`: the daemon's identity key is not the
 * pinned one — the cue for the re-pin prompt); never throws. */
export async function releaseSecrets(): Promise<string> {
  try {
    const state = await api<SecretsState>("/api/v1/secrets");
    if (!state.available) return "off";
    const device = await loadDevice();
    if (!device) return "unpaired";
    let record = await loadSecrets();
    const pinned = record && record.deviceId === device.deviceId ? record.identity : null;
    if (!record || record.deviceId !== device.deviceId || !state.enrolled) record = await enrol(device, pinned);
    if (state.identity && state.identity !== record.identity) return "untrusted";
    if (!state.setUp || state.unlocked) return state.setUp ? "unlocked" : "not-set-up";
    return await unlockWith(post);
  } catch {
    return "failed";
  }
}

/** The phone's re-pin with the recovery code, then a release with the new
 * pin (mail reopens at once if the server was locked). */
export async function repinWithCode(code: string): Promise<RepinOutcome> {
  const outcome = await repinIdentity(code, post);
  if (outcome === "repinned") await releaseSecrets();
  return outcome;
}
