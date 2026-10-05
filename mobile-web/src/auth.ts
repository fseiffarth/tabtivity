import { ApiError, api, traceConnect } from "./api";
import { classifyUnavailable, unavailableDetail, type UnavailableReason } from "./connection";
import { LEGACY_NAMES, NAMES } from "../../src/lib/brand";
import { adoptLegacyDatabase, databaseHost, databasePort } from "../../src/lib/brandMigration";

const DB = NAMES.mobileAuthDb;
/** The database an older build of the phone app kept the device key in. */
const LEGACY_DB = LEGACY_NAMES.mobileAuthDb;
const STORE = "keys";
const DEVICE = "device";

interface AuthRecord { deviceId: string; privateKey: CryptoKey }

function b64url(bytes: ArrayBuffer): string {
  const raw = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The device key an older build stored under the app's old name is copied
 * over once, before the database is first used — so the phone stays paired
 * across a rename. A failed copy keeps the old database for the next start. */
let adopted: Promise<unknown> | null = null;

export async function openAuthDatabase(): Promise<IDBDatabase> {
  if (LEGACY_DB !== DB) {
    adopted ??= adoptLegacyDatabase(databaseHost(indexedDB), LEGACY_DB, DB, async () =>
      databasePort(await openCurrentAuthDatabase()),
    ).catch(() => undefined);
    await adopted;
  }
  return openCurrentAuthDatabase();
}

function openCurrentAuthDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function load(): Promise<AuthRecord | null> {
  const database = await openAuthDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE).objectStore(STORE).get(DEVICE);
    request.onsuccess = () => resolve((request.result as AuthRecord | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

async function save(record: AuthRecord): Promise<void> {
  const database = await openAuthDatabase();
  await new Promise<void>((resolve, reject) => {
    const request = database.transaction(STORE, "readwrite").objectStore(STORE).put(record, DEVICE);
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
  });
}

/** The lock's best-effort `DELETE /auth/session`, while it is in flight. Its
 * answer clears the session cookie, so one that lands after the next sign-in
 * — the lock fires as the phone wakes, the reader unlocks at once, and the
 * DELETE was stuck behind a tunnel still reconnecting — wiped the fresh
 * session and the first screen after the unlock met a 401. Sign-in waits for
 * it to settle instead. */
let pendingLogout: Promise<void> | null = null;
/** Short: it is best effort, and a sign-in waits on it. */
const LOGOUT_TIMEOUT = 3_000;

/** One request of the sign-in exchange, its outcome and time on the trace. */
async function traced<T>(name: string, request: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const took = () => `${Math.round(performance.now() - started)} ms`;
  try {
    const answer = await request();
    traceConnect(`${name} ok after ${took()}`);
    return answer;
  } catch (error) {
    traceConnect(`${name} ${error instanceof ApiError ? `${error.status} ${error.code}` : "failed"} after ${took()}`);
    throw error;
  }
}

async function login(record: AuthRecord): Promise<void> {
  if (pendingLogout) {
    traceConnect("waiting for the lock's logout");
    await pendingLogout;
  }
  const challenge = await traced("challenge", () => api<{ nonce: string; payload: string }>("/api/v1/auth/challenge", {
    method: "POST", body: JSON.stringify({ device_id: record.deviceId }),
  }, AUTH_REQUEST_TIMEOUT));
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    record.privateKey,
    new TextEncoder().encode(challenge.payload),
  );
  await traced("session", () => api("/api/v1/auth/session", {
    method: "POST",
    body: JSON.stringify({ device_id: record.deviceId, nonce: challenge.nonce, signature: b64url(signature) }),
  }, AUTH_REQUEST_TIMEOUT));
}

export type ResumeResult =
  | { kind: "paired" }
  | { kind: "unpaired" }
  /** Carries *why*, so the splash can say which machine to go and fix rather
   * than showing one "Host unavailable" for every possible cause. */
  | { kind: "unavailable"; reason: UnavailableReason; detail?: string };

/** Pauses before each further sign-in attempt. */
export const RESUME_RETRY_DELAYS = [300, 800, 1_500, 2_500, 4_000];
/** No new attempt starts once this much has gone by: a phone that really is
 * off the tailnet should reach the splash that says so. It used to be 12 s
 * with 10 s attempts, which left room for exactly two: a tunnel still coming
 * back at the second one meant "Connecting…" for twenty seconds and then the
 * Retry press anyway. Short attempts inside a longer window keep asking until
 * the path is back. */
const RESUME_RETRY_WINDOW = 24_000;
/** Each request of the sign-in exchange. Both are a few hundred bytes the
 * sidecar answers in under a millisecond, so one still silent after this is
 * stalled on a dead path, not slow; the next attempt is worth more than the
 * rest of `REQUEST_TIMEOUT`. */
const AUTH_REQUEST_TIMEOUT = 5_000;

/**
 * A failure that says nothing about the host, only about the path to it. The
 * sign-in after an unlock is the usual victim: the browser still holds the
 * HTTP/2 connection it had before the phone slept, the far end dropped it in
 * the meantime, and the request stalls on it until the browser's own liveness
 * ping gives up — about ten seconds, the same as `REQUEST_TIMEOUT` — and
 * closes it (`timeout`, or `offline` when the close wins). The very next
 * attempt opens a fresh connection and goes through. That was "every second
 * unlock fails, Retry works", with the Retry press as the second attempt. The
 * browser also drops what is in flight when the network changes under it,
 * which is what the Tailscale app bringing its tunnel back looks like.
 */
function transient(reason: unknown): boolean {
  return reason instanceof ApiError && reason.status === 0;
}

/**
 * A 5xx the proxy wrote itself (see `classifyUnavailable`): Tailscale Serve
 * reached the machine but nothing listens behind it. That is the sidecar
 * restarting, which clears within a second or two — or, far more often, the
 * desktop app closed, which stops the sidecar and clears never. Riding it out
 * with the rest kept "Connecting…" up for the whole retry schedule, about
 * 9 s, before the splash said the desktop app isn't running.
 */
function proxyDown(reason: unknown): boolean {
  return reason instanceof ApiError && reason.status >= 502 && reason.status <= 504 && reason.code === "request_failed";
}
/** Further attempts after a proxy-written 5xx. Three ride the schedule's first
 * pauses, 300 + 800 + 1,500 ms: the last goes out about 2.6 s after the
 * first, past a sidecar restart, and a closed desktop reaches its splash
 * then instead of after the whole window. */
const PROXY_DOWN_RETRIES = 3;

/**
 * The sidecar keeps its challenges in memory, so one that restarted between
 * the challenge and the session post answers `invalid_challenge`. The retry
 * repeats the whole exchange with a fresh nonce, which the new sidecar has.
 * Two at most: every try costs two of the device's sign-in attempts per
 * minute (`AUTH_ATTEMPT_BUDGET`, 30), and a challenge that keeps failing is
 * not a restart. A rejected device (`unknown_device`, `invalid_signature`)
 * is never retried — it goes to pairing at once.
 */
function staleChallenge(reason: unknown): boolean {
  return reason instanceof ApiError && reason.status === 401 && reason.code === "invalid_challenge";
}
const STALE_CHALLENGE_RETRIES = 2;

const pause = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** `login`, tried again while the failure is `transient` and the window lasts,
 * or a `proxyDown`/`staleChallenge` one within its own smaller budget. Every
 * try counts against the one schedule, so there are never more than its
 * length plus one. The whole exchange repeats, never just its second half: a
 * nonce the host may already have spent cannot be sent twice. */
async function loginWithRetry(record: AuthRecord): Promise<void> {
  const started = Date.now();
  let proxyRetries = 0;
  let challengeRetries = 0;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await login(record);
      return;
    } catch (reason) {
      const delay = RESUME_RETRY_DELAYS[attempt];
      if (delay === undefined || Date.now() - started >= RESUME_RETRY_WINDOW) throw reason;
      if (proxyDown(reason)) {
        proxyRetries += 1;
        if (proxyRetries > PROXY_DOWN_RETRIES) throw reason;
      } else if (staleChallenge(reason)) {
        challengeRetries += 1;
        if (challengeRetries > STALE_CHALLENGE_RETRIES) throw reason;
      } else if (!transient(reason)) {
        throw reason;
      }
      await pause(delay);
    }
  }
}

export async function resumeAuth(): Promise<ResumeResult> {
  const record = await load();
  if (!record) return { kind: "unpaired" };
  try {
    await loginWithRetry(record);
    return { kind: "paired" };
  } catch (reason) {
    // Only a rejection of *this device's identity* means "re-pair". A timeout,
    // an offline phone, or a 429 from the rate limiter must not send the user
    // to the pairing screen, which is what `status < 500` used to do.
    //
    // `invalid_origin` is a 403 but is emphatically *not* a rejected device —
    // it is the host refusing the address the app was opened from, and
    // re-pairing cannot fix it. It was swept in by the blanket `status === 403`
    // and sent the reader to a pairing screen that could only fail again.
    const rejected = reason instanceof ApiError
      && reason.code !== "invalid_origin"
      && (reason.status === 403 || reason.code === "unknown_device" || reason.code === "invalid_signature");
    if (rejected) return { kind: "unpaired" };
    return {
      kind: "unavailable",
      reason: classifyUnavailable(reason),
      detail: unavailableDetail(reason),
    };
  }
}

export async function hasPairedDevice(): Promise<boolean> {
  return !!await load();
}

/** End the server-side session when the local app is locked. The paired
 * non-exportable signing key stays in IndexedDB, so a verified local unlock
 * can obtain a fresh session without making the user pair again. */
export function logoutAuth(): Promise<void> {
  const request = api("/api/v1/auth/session", { method: "DELETE" }, LOGOUT_TIMEOUT).then(() => undefined);
  const settled: Promise<void> = request.catch(() => undefined).finally(() => {
    if (pendingLogout === settled) pendingLogout = null;
  });
  pendingLogout = settled;
  return request;
}

export async function pair(code: string, deviceName: string): Promise<void> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const spki = await crypto.subtle.exportKey("spki", keys.publicKey);
  const paired = await api<{ device_id: string }>("/api/v1/pair", {
    method: "POST",
    body: JSON.stringify({ code, device_name: deviceName, public_key: b64url(spki) }),
  });
  const record = { deviceId: paired.device_id, privateKey: keys.privateKey };
  await save(record);
}
