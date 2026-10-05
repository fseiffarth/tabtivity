import { create } from "zustand";

/**
 * The shot waiting for an answer to "where should this go?".
 *
 * **No screenshot is written into a project without passing through here.** The
 * old flow filed every capture straight into the active project's
 * `tabtivity-screenshots/` folder, which for a project with a public remote is a
 * private-data leak one `git add -A` away — a screen grab holds whatever was on
 * the screen at the time, not only the thing being documented. So a capture now
 * lands in a staging area (`<state_dir>/screenshots-pending/`, outside every
 * project tree and so invisible to file watches, git and the sync loops) and
 * `ScreenshotSaveOverlay` asks before anything is filed.
 *
 * The clipboard copy happens either way and is deliberately *not* gated on the
 * answer: it is what makes Discard a safe, cheap choice — the pixels are still
 * there to paste, only the file is dropped.
 *
 * Two shapes reach the overlay, because two capture paths do:
 *  - `staged` — an OS region tool's PNG, already on disk in the staging area.
 *    Save moves it (`save_pending_screenshot`), Discard deletes it.
 *  - `bytes` — an in-app capture that never touched the disk, currently the PDF
 *    viewer's document-sharp region crop. Save writes the bytes, Discard just
 *    forgets them.
 *
 * A store rather than props for the family's usual reason: the capture is
 * triggered from the header's global-app menu or from any visible PDF viewer
 * (in any window pane), while the overlay must be mounted once at the shell.
 */

export type PendingScreenshot =
  | {
      kind: "staged";
      /** Absolute path in the staging area — the handle for save/discard. */
      path: string;
      /** Suggested file name, pre-filled in the overlay. */
      name: string;
      /** Project directory to preselect, when the capture knows one. */
      hintDir?: string | null;
    }
  | {
      kind: "bytes";
      /** The PNG itself; never written until the user says so. */
      png: Uint8Array;
      name: string;
      hintDir?: string | null;
    };

interface ScreenshotPendingState {
  /** The shot awaiting an answer, or null when the overlay is closed. */
  pending: PendingScreenshot | null;
  /** Show the overlay for a shot. A second capture replaces the first — the
   *  previous staged file is then swept by the backend's TTL sweep. */
  show: (shot: PendingScreenshot) => void;
  /** Close the overlay. Disposing of the shot itself is the caller's job (the
   *  overlay discards or saves before calling this). */
  close: () => void;
}

export const useScreenshotPendingStore = create<ScreenshotPendingState>((set) => ({
  pending: null,
  show: (shot) => set({ pending: shot }),
  close: () => set({ pending: null }),
}));
