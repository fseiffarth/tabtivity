import { invoke } from "@tauri-apps/api/core";

/**
 * The OS credential store as a *thing with a state*, not just a place secrets go.
 *
 * Every "is this password saved?" in Tabtivity is a keychain read, and on Linux a read
 * against a **locked** Secret Service collection answers exactly like an empty one:
 * nothing saved. So a user who ticked "Save password", connected, and restarted finds
 * the box blank, no silent connect, and no explanation — the credential was there the
 * whole time, behind a lock nothing in the UI ever mentioned.
 *
 * These two calls are what let a surface say that instead of guessing. Neither ever
 * throws: an unreachable backend degrades to "locked", which is the state with an
 * action behind it, rather than to a false "unlocked" that sends the caller back into
 * the silent path that is already failing.
 */
export type KeyringState = "unlocked" | "locked" | "unavailable";

/** The store's lock state. Never prompts — the backend probes with a zero-second
 *  prompt timeout, so asking is always safe (including on a launch path). */
export async function keyringState(): Promise<KeyringState> {
  return invoke<KeyringState>("keyring_state").catch(() => "locked" as const);
}

/**
 * Ask the OS to unlock the store, raising **its own** dialog. Resolves `true` once
 * unlocked (including when it already was), `false` if the dialog was dismissed or
 * there is no store at all.
 *
 * Only call this from an explicit user action. Auto-connect promises not to prompt,
 * and a system unlock dialog during startup is still a prompt.
 */
export async function unlockKeyring(): Promise<boolean> {
  return invoke("keyring_unlock")
    .then(() => true)
    .catch(() => false);
}
