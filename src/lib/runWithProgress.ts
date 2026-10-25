import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";

/**
 * Run a long backend job (an installer, a model pull) while following its
 * progress event. The subscription is made inside the `try`, so a rejected
 * `listen` surfaces as this call's rejection — the caller's own `catch` and
 * `finally` (the "installing" flag) still run — and the unlisten is called
 * however the job ends.
 */
export async function runWithProgress<P, R>(
  event: string,
  onProgress: (payload: P) => void,
  run: () => Promise<R>,
): Promise<R> {
  let unlisten: UnlistenFn | undefined;
  try {
    unlisten = await listen<P>(event, (e) => onProgress(e.payload));
    return await run();
  } finally {
    unlisten?.();
  }
}
