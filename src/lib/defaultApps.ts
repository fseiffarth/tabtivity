import { invoke } from "@tauri-apps/api/core";

/**
 * The global default-apps map (`default_apps.json`) is written per change
 * (headless owner plan, H1b step 7): `patch_default_apps` merges `set` and
 * `remove` under the file's lock, so a laptop's dialog and a phone's settings
 * page saving at once never erase each other's entries. A backend without the
 * command (a dev window hot-reloading `src/` against an older binary) gets the
 * whole map through `save_default_apps`, as before.
 */
export interface DefaultAppsPatch {
  set?: Record<string, string>;
  remove?: string[];
}

function isUnknownCommand(error: unknown): boolean {
  return /(?:command\b.*\bnot found|unknown command|not allowed)/i.test(String(error));
}

/** The set/remove between two maps, for a settings page that edits a copy. */
export function diffDefaultApps(before: Record<string, string>, after: Record<string, string>): DefaultAppsPatch {
  const set: Record<string, string> = {};
  for (const [ext, exec] of Object.entries(after)) {
    if (before[ext] !== exec) set[ext] = exec;
  }
  const remove = Object.keys(before).filter((ext) => !(ext in after));
  return { ...(Object.keys(set).length ? { set } : {}), ...(remove.length ? { remove } : {}) };
}

/** Apply `patch`; `whole` is the map the caller would have saved outright,
 * for a backend that only knows the whole-document save. Answers the map as
 * stored (the patch command's answer), or `whole` on the fallback. */
export async function patchDefaultApps(
  patch: DefaultAppsPatch,
  whole: () => Record<string, string>,
): Promise<Record<string, string>> {
  try {
    return (await invoke<Record<string, string>>("patch_default_apps", { set: patch.set ?? {}, remove: patch.remove ?? [] })) ?? whole();
  } catch (error) {
    if (!isUnknownCommand(error)) throw error;
    const next = whole();
    await invoke("save_default_apps", { defaultApps: next });
    return next;
  }
}
