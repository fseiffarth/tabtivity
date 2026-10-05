/**
 * Who owns the lone Super/Meta key — the desktop shell, or Tabtivity?
 *
 * Tabtivity's panel toggle is the bare Super key on Linux. That only works on a
 * desktop that leaves the key to the focused window; Cinnamon does, which is
 * where the binding was written. GNOME does not: Super opens the Activities
 * overview, and every `Super+<key>` shell shortcut delivers a lone `Meta`
 * keydown to the focused window first. On GNOME the panels therefore blink out
 * on presses the user aimed at the shell, with nothing on screen saying why —
 * exactly the failure that made Windows switch to F9 (see `useKeyboard.ts`).
 *
 * The desktop is a backend fact (`XDG_CURRENT_DESKTOP`), so this is a cached
 * one-shot probe rather than something derived from `navigator`. It cannot
 * change under a running session.
 */
import { invoke } from "@tauri-apps/api/core";

/**
 * Default and error fallback: the key is OURS.
 *
 * Deliberately today's behavior, not the safe-looking opposite. A frontend
 * routinely runs ahead of the backend here (`src/` hot-reloads, `src-tauri/`
 * does not), so this command is missing on any window whose backend predates
 * it — and a rejected probe must not silently take the Super binding away from
 * the Cinnamon/XFCE desktops it works on. Only a backend that actually answers
 * can hand the key to the shell.
 */
let ownedByDesktop = false;
let probe: Promise<boolean> | null = null;

/** Synchronous answer for the key handler and the shortcut sheet. */
export function desktopOwnsSuperKey(): boolean {
  return ownedByDesktop;
}

/** Run the probe once per session; later calls await the same result. */
export function probeSuperKeyOwnership(): Promise<boolean> {
  probe ??= invoke<boolean>("desktop_owns_super_key")
    // `=== true` and not a plain cast: an unmocked test `invoke` resolves to
    // `null`, which must read as "ours" like every other non-answer.
    .then((owned) => (ownedByDesktop = owned === true))
    .catch(() => (ownedByDesktop = false));
  return probe;
}

/** Test seam: forget the cached answer so the next probe runs again. */
export function resetSuperKeyOwnership(): void {
  ownedByDesktop = false;
  probe = null;
}
