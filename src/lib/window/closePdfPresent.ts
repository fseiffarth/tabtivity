/**
 * Closing every **PDF present window** (`components/embed/pdf/present.ts`) —
 * what a scope change does, so a PDF shown fullscreen from one project's tab
 * never stays over the next project.
 *
 * Unlike a popout, a present window is not parked and brought back: it belongs
 * to a tab of the scope just left, which keeps no record of it to restore from,
 * and pressing Present again re-opens it on the sheet the reader is on.
 *
 * The sleep inhibitor goes first, as the window's own `closeSelf` does it:
 * `close_presenter_window` destroys the renderer, so the window's unmount
 * cleanup that would release it is not guaranteed to run.
 */
import { invoke } from "@tauri-apps/api/core";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { isPdfPresentLabel } from "../../components/embed/pdf/present";

export async function closePdfPresentWindows(): Promise<void> {
  let labels: string[];
  try {
    labels = (await getAllWebviewWindows()).map((w) => w.label).filter(isPdfPresentLabel);
  } catch {
    return;
  }
  if (labels.length === 0) return;
  await invoke("presenter_release_sleep").catch(() => {});
  await Promise.all(
    labels.map((label) => invoke("close_presenter_window", { label }).catch(() => {})),
  );
}
