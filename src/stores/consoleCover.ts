import { create } from "zustand";

/**
 * Which was raised last: the console window (`layout/RootOverlay`) or the
 * Machines / Models overlay (`header/MachinesOverlay`, `models/ModelsOverlay`).
 *
 * All three are `.modal-backdrop`s at one z-index, so the DOM order in
 * `layout/AppShell` decides, and it puts the console last (a terminal sign-in or
 * install started from an overlay opens the console over it). An overlay opened
 * FROM the window (the Usage view's "Open Machines", the Root view's "Add
 * agent...") used to land under it. This flag says the overlay was opened while
 * the window was up, so the window steps one layer down (`.under-overlay`) and the
 * overlay is the front one; the window opening afresh (`rootOverlay.show/openView`)
 * clears it. Whether it matters is `lib/window/consoleFront` (an overlay must also
 * be open). Session-only; no data.
 */
export const useConsoleCover = create<{ covered: boolean }>(() => ({ covered: false }));

/** An overlay just opened; it covers the window iff the window was up. */
export function coverConsole(windowOpen: boolean): void {
  useConsoleCover.setState({ covered: windowOpen });
}

/** The window opened afresh: it is in front of whatever was open. */
export function uncoverConsole(): void {
  if (useConsoleCover.getState().covered) useConsoleCover.setState({ covered: false });
}
