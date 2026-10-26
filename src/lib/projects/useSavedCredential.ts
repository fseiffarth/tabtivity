import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { KeyringState } from "../keyring";

/**
 * **"Is a password saved for this host?" — asked so the answer can be _"we don't
 * know"_.**
 *
 * Five surfaces used to ask this the same wrong way: `remote_has_saved_password`,
 * `.catch(() => false)`, one boolean. That boolean then drove the "Save password"
 * pre-tick — and an unticked box is not a neutral state, it is an instruction:
 * `ssh_connect`'s `remember: false` means *clear the saved credential*. So an
 * unreadable keychain (locked Secret Service — which answers every lookup exactly
 * like an empty one) unticked the box, and the next successful connect deleted the
 * very password it had just authenticated with. That is not hypothetical: it is
 * how the user's most-used host lost its credential.
 *
 * This hook is the one implementation, and it fixes the three things that made
 * that possible:
 *
 *  1. **A tri-state**, not a boolean — `saved` / `notSaved` / `unreadable`, plus
 *     `checking` while the read is in flight. "Unknown" never masquerades as
 *     "nothing saved" again, which is what lets the UI say so (and offer the
 *     unlock) instead of quietly proposing a delete.
 *  2. **A bounded read.** The backing keychain call is a D-Bus round trip that
 *     blocks *indefinitely* against a locked collection, so the read is raced
 *     against a 4 s timer (the pattern `VpnIndicator` established) and a timeout
 *     lands on `unreadable` — the state with an action behind it — never on a
 *     confident `notSaved`.
 *  3. **`applyOutcome`.** What is saved is what the *backend did*
 *     (`SshConnectOutcome`), never what the request asked for: a locked keyring
 *     refuses the write and reports why, and the row has to show that rather than
 *     a ticked box with an empty keychain behind it.
 *
 * `forget()` is the only path that deletes. Clearing a credential is an explicit
 * act by the user, never a side effect of connecting — see `rememberArg`.
 */
export type SavedCredential = "checking" | "saved" | "notSaved" | "unreadable";

/** Mirrors `commands::ssh::SavedPasswordState`. Never fails backend-side. */
export interface SavedPasswordState {
  saved: boolean;
  keyring: KeyringState;
}

/** Mirrors `commands::ssh::SshConnectOutcome` — what `ssh_connect` did to the
 *  keychain, as distinct from whether it connected. */
export interface SshConnectOutcome {
  saved: boolean;
  save_error: string | null;
}

/** The host a credential is keyed by (`user@host:port`), in the spelling every
 *  caller here already has. */
export interface CredentialTarget {
  user?: string | null;
  host: string;
  port?: number | null;
}

/** How long a keychain read is allowed to take before it is called unreadable.
 *  Same bound (and same reason) as `VpnIndicator`'s keyring probes. */
const READ_TIMEOUT_MS = 4000;

/**
 * How long the identity has to hold still before the store is asked about it
 * (G.24).
 *
 * The `key` is `user@host:port` built from **address fields being typed into**,
 * so it changes on every keystroke — and each read is now two keychain
 * operations (the lock-state probe plus the lookup), i.e. two D-Bus round trips
 * per character against a service that is slow while its daemon starts and
 * blocks outright while the collection is locked. Typing `user@host.example`
 * fired eighteen of those, seventeen of them about hosts that were only ever
 * prefixes of the real one.
 *
 * Short enough to feel immediate once typing stops, long enough that a name is
 * asked about once rather than per character. It costs nothing on the paths that
 * matter most — a dialog opened on an already-filled target, or a `refresh()`
 * after an unlock — because those settle immediately and never move again.
 */
const SETTLE_MS = 300;

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    void p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/**
 * **The value a connect may send as `remember` — `true` or `null`, never `false`.**
 *
 * `false` is not "don't save", it is `Remember::Clear`: the backend deletes the
 * account. Since `ssh_connect` resolves `typed || saved` *before* it writes, a
 * successful connect carrying `false` destroys the password it authenticated
 * with. So an unticked box means **leave the keychain alone** (`null`), and
 * deleting is left to the explicit forget the untick handler already calls.
 *
 * The same rule covers `checking` and `unreadable` for free: the pre-tick is
 * seeded from the resolved state, so a box that has not been (or cannot be)
 * resolved is unticked, and an unticked box sends `null`. A box the user ticked
 * *themselves* still sends `true` even on an unreadable keyring — that is a
 * request to save, and the backend answers it with `save_error` if it can't.
 *
 * The pattern is `stores/remote/globalMachines`' (`opts.remember ? true : null`); this
 * is that decision named, so no fourth copy has to rediscover it.
 */
export function rememberArg(checked: boolean): true | null {
  return checked ? true : null;
}

export interface SavedCredentialHandle {
  /** The tri-state (plus `checking`). */
  state: SavedCredential;
  /** The credential store's own condition, for the locked-keyring disclosure. */
  keyring: KeyringState;
  /** A password is known to be saved. */
  saved: boolean;
  /** The store could not be read, so nothing can be concluded either way. */
  unreadable: boolean;
  /** The read is still in flight. */
  checking: boolean;
  /** Why the last connect did not save what it was asked to (verbatim from the
   *  keychain layer), or `""`. */
  saveError: string;
  /** Re-ask (after an unlock, or after a connect that may have written). */
  refresh: () => void;
  /** Delete the saved password for this target. The only deleting path. */
  forget: () => Promise<void>;
  /** Adopt what `ssh_connect` actually did — the source of truth for "saved". */
  applyOutcome: (outcome: SshConnectOutcome | null | undefined) => void;
}

/**
 * The machinery, factored off the SSH target so a second credential kind can
 * reuse it rather than grow a second copy of the tri-state, the 4 s bound and the
 * "unknown is not absence" rule (the mail client is the first such kind — its
 * secret is keyed by account, not by `user@host:port`).
 *
 * `key` identifies the credential: it is the effect's dependency, and an EMPTY
 * key means "there is nothing to ask about", which resolves to `notSaved` without
 * a store trip — the same answer a missing host has always produced. `read` and
 * `forget` are held in a ref rather than being effect deps, so a caller need not
 * memoize them for the read to stay keyed to the credential's identity.
 */
export function useSavedCredentialSource(
  key: string,
  read: () => Promise<SavedPasswordState>,
  forget: () => Promise<void>,
  opts?: { enabled?: boolean },
): SavedCredentialHandle {
  const enabled = opts?.enabled ?? true;

  const [state, setState] = useState<SavedCredential>("checking");
  const [keyring, setKeyring] = useState<KeyringState>("unlocked");
  const [saveError, setSaveError] = useState("");
  // Bumped by `refresh`; a dep of the read effect rather than a second code path.
  const [nonce, setNonce] = useState(0);

  const io = useRef({ read, forget });
  io.current = { read, forget };

  useEffect(() => {
    if (!key || !enabled) {
      // Nothing to ask about (or nobody asking yet) is genuinely "nothing saved" —
      // there is no store trip to be uncertain about.
      setState("notSaved");
      return;
    }
    let cancelled = false;
    // `checking` goes up immediately, before the settle wait: the row must not
    // keep showing the *previous* target's answer while the new one is pending,
    // which for a half-typed host would read as a confident "nothing saved".
    setState("checking");
    setSaveError("");
    // Debounced (see SETTLE_MS): the identity is typed, so most values this
    // effect sees are prefixes nobody is asking about. A superseded key clears
    // its own timer below, so only the settled one ever reaches the keychain.
    const timer = setTimeout(() => {
      void withTimeout(
        io.current.read().catch(
          // The command is declared infallible, so a rejection means the bridge
          // itself is gone — which tells us nothing about the store.
          () => ({ saved: false, keyring: "unavailable" as KeyringState }),
        ),
        READ_TIMEOUT_MS,
        // A read that never came back is a locked collection until proven otherwise:
        // "locked" is the state with an unlock behind it.
        { saved: false, keyring: "locked" as KeyringState },
      ).then((answer) => {
        if (cancelled) return;
        // An answer that arrived but carries nothing gets read as the same
        // unreadable store a timeout does, rather than destructured blind: this
        // runs inside an unawaited promise, so a `null` from the bridge would
        // surface only as an unhandled rejection — the row would sit on
        // "checking" forever with nothing on screen saying why.
        const res: SavedPasswordState = answer ?? { saved: false, keyring: "unavailable" };
        setKeyring(res.keyring);
        // A `false` from a store we could not read is not evidence of absence — the
        // whole point of the tri-state. A `true` is still trustworthy either way.
        setState(res.saved ? "saved" : res.keyring === "unlocked" ? "notSaved" : "unreadable");
      });
    }, SETTLE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, enabled, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const doForget = useCallback(async () => {
    if (!key) return;
    await io.current.forget().catch(() => {});
    setState("notSaved");
    setSaveError("");
  }, [key]);

  const applyOutcome = useCallback((outcome: SshConnectOutcome | null | undefined) => {
    // No outcome (an older/void call site) leaves the state alone rather than
    // asserting a keychain fact nobody reported.
    if (!outcome) return;
    setState(outcome.saved ? "saved" : "notSaved");
    setSaveError(outcome.save_error ?? "");
  }, []);

  return {
    state,
    keyring,
    saved: state === "saved",
    unreadable: state === "unreadable",
    checking: state === "checking",
    saveError,
    refresh,
    forget: doForget,
    applyOutcome,
  };
}

/**
 * Track the saved-password state of an SSH `target`. Re-reads whenever the target
 * changes; `opts.enabled` gates the read entirely for a surface that must not
 * touch the keychain until the user asks (a pill's context menu — one unbounded
 * D-Bus trip per project at launch is exactly the cost this avoids).
 */
export function useSavedCredential(
  target: CredentialTarget | null | undefined,
  opts?: { enabled?: boolean },
): SavedCredentialHandle {
  // Destructured to primitives so the effect keys off the *identity of the host*,
  // not off a spec object the store re-creates on every unrelated patch.
  const user = target?.user ?? null;
  const host = target?.host ?? "";
  const port = target?.port ?? null;

  const read = useCallback(
    () => invoke<SavedPasswordState>("remote_saved_password_state", { user, host, port }),
    [user, host, port],
  );
  const forget = useCallback(
    () => invoke<void>("remote_forget_password", { user, host, port }),
    [user, host, port],
  );

  return useSavedCredentialSource(
    host ? `ssh:${user ?? ""}@${host}:${port ?? ""}` : "",
    read,
    forget,
    opts,
  );
}
