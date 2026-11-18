/**
 * What the desktop shell (`DesktopShell.tsx`) tells the app inside it: which
 * desktop is on screen, whether a switch button belongs there, and how to
 * open the picker. Its own module, so `App` and the shell import it without
 * importing each other.
 */
import { createContext, useContext, useMemo } from "react";
import { postToShell, shellOrigin } from "./frameBridge";

export interface DesktopShellApi {
  /** The framed desktop on screen, or null for the home. */
  selected: string | null;
  /** Whether a switch button belongs on screen. */
  canSwitch: boolean;
  openPicker: () => void;
  /** `App` says whether its own lock is passed: the picker and frame need it. */
  setUnlocked: (unlocked: boolean) => void;
}

export const ShellContext = createContext<DesktopShellApi | null>(null);

/** Without the shell (a framed page, or a test rendering `App` alone): no
 * selection, and in a frame the switch button asks the shell. */
function frameSide(): DesktopShellApi {
  const framed = shellOrigin() !== null;
  return {
    selected: null,
    canSwitch: framed,
    openPicker: () => { postToShell({ type: "openPicker" }); },
    setUnlocked: () => undefined,
  };
}

export function useDesktopShell(): DesktopShellApi {
  const shell = useContext(ShellContext);
  return useMemo(() => shell ?? frameSide(), [shell]);
}

