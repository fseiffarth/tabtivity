import { basename } from "./paths";
import { useOpenExternalStore } from "../stores/openExternal";

/**
 * Gap 21 (decision C2): every hand-off of a file to the operating system's
 * default app asks first, naming the file, and a launcher or executable is
 * refused outright. The backend judges (`services::os_open`, through the
 * command's `checkOnly` call, which opens nothing); this asks the user.
 */

/** The backend's fixed refusal for a launcher type or an executable file. */
export const OPEN_REFUSED_LAUNCHER = "open_refused_launcher";

export function isLauncherRefusal(err: unknown): boolean {
  const text = typeof err === "string" ? err : err instanceof Error ? err.message : "";
  return text === OPEN_REFUSED_LAUNCHER;
}

/** Show the "not opened, it can run a program" note for `path`. */
export async function showLauncherRefusal(path: string): Promise<void> {
  await useOpenExternalStore.getState().ask({ kind: "refused", name: basename(path) || path, path });
}

/**
 * Ask before `path` goes to the OS. `check` runs the command with
 * `checkOnly: true`. Resolves `"open"` when the user agreed, `"declined"`
 * when they did not or the backend refused a launcher (the note was shown),
 * and `"opened"` when `check` answered with something other than nothing —
 * a backend that predates `checkOnly` and so opened the file already.
 * Other errors of the check reject as they are.
 */
export async function confirmOsOpen(
  path: string,
  check: () => Promise<unknown>,
): Promise<"open" | "declined" | "opened"> {
  let answer: unknown;
  try {
    answer = await check();
  } catch (err) {
    if (!isLauncherRefusal(err)) throw err;
    await showLauncherRefusal(path);
    return "declined";
  }
  if (answer != null) return "opened";
  const approved = await useOpenExternalStore
    .getState()
    .ask({ kind: "confirm", name: basename(path) || path, path });
  return approved ? "open" : "declined";
}
