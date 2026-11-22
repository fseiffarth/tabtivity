import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { MOBILE_HOST_KEY } from "../lib/brand";
import { isDetachedWindow } from "./detachedContext";
import { useSettingsStore } from "./settings";

/**
 * The "open it on the phone?" asks, shown one at a time by
 * `<PhoneShareDialogHost>` (mounted once, in AppShell's main window):
 *
 * - `project`: a project was just added on the desktop while Tabtivity Mobile
 *   is on and at least one phone is paired — which phones should reach it?
 * - `phone`: a phone just finished pairing — which existing projects and
 *   boxes should it reach?
 *
 * Nothing here writes access: the dialog does, through the same setters as
 * Settings → Mobile, so every rule in `docs/context/mobile_access.md` holds.
 */
export type PhoneShareAsk =
  /** `phones`: the paired phones read when the project was added. */
  | { kind: "project"; projectId: string; phones: PairedDevice[] }
  | { kind: "phone"; deviceId: string; deviceName: string };

interface PhoneShareStore {
  queue: PhoneShareAsk[];
  /** Bumped when the pairing watch sees its phone arrive: the Add device
   *  panel drops its (now spent) code. */
  pairedSeq: number;
  push: (ask: PhoneShareAsk) => void;
  /** Close `ask` if it is the one on screen; the next one, if any, shows.
   *  Idempotent: a second call for the same ask does nothing. */
  done: (ask: PhoneShareAsk) => void;
}

export const usePhoneShareStore = create<PhoneShareStore>((set) => ({
  queue: [],
  pairedSeq: 0,
  push: (ask) => set((s) => ({ queue: [...s.queue, ask] })),
  done: (ask) => set((s) => (s.queue[0] === ask ? { queue: s.queue.slice(1) } : {})),
}));

export interface PairedDevice {
  id: string;
  name: string;
}

/** The paired phones from `devices.json` (host up or down), or `null` when
 *  the file cannot be read. */
async function readPairedDevices(): Promise<PairedDevice[] | null> {
  try {
    const devices = await invoke<PairedDevice[]>("mobile_paired_devices");
    return Array.isArray(devices) ? devices : null;
  } catch {
    return null;
  }
}

/** Ask which phones should reach a project just added on the desktop — only
 *  while Tabtivity Mobile is on and some phone is paired, and only in the main
 *  window (the host lives there). */
export async function askToShareNewProject(projectId: string): Promise<void> {
  if (isDetachedWindow()) return;
  if (useSettingsStore.getState().settings?.[MOBILE_HOST_KEY]?.enabled !== true) return;
  const phones = await readPairedDevices();
  if (!phones || phones.length === 0) return;
  usePhoneShareStore.getState().push({ kind: "project", projectId, phones });
}

/** How often the pairing watch re-reads the paired devices. */
export const PAIRING_WATCH_MS = 2_000;

let watch: { timer: number; until: number; known: Set<string> } | null = null;

function stopWatch() {
  if (watch) window.clearInterval(watch.timer);
  watch = null;
}

/**
 * Watch for the phone a pairing code is waiting for. `known` is the paired
 * ids read before the code was issued; the first id beyond them is the new
 * phone, and it gets the `phone` ask. A code pairs one phone, so the watch then
 * stops — as it does when the code expires (`expiresAt`, Unix seconds). A new
 * code replaces the watch. Main window only, like the host.
 */
export function watchPairing(known: string[], expiresAt: number): void {
  if (isDetachedWindow()) return;
  stopWatch();
  const mine = {
    known: new Set(known),
    until: expiresAt * 1000,
    timer: window.setInterval(() => {
      if (watch !== mine) return;
      if (Date.now() > mine.until) {
        stopWatch();
        return;
      }
      void readPairedDevices().then((devices) => {
        if (watch !== mine || !devices) return;
        const fresh = devices.find((device) => !mine.known.has(device.id));
        if (!fresh) return;
        stopWatch();
        const store = usePhoneShareStore.getState();
        usePhoneShareStore.setState({ pairedSeq: store.pairedSeq + 1 });
        store.push({ kind: "phone", deviceId: fresh.id, deviceName: fresh.name });
      });
    }, PAIRING_WATCH_MS),
  };
  watch = mine;
}

/** The paired ids right now (`null`: unreadable). `watchPairing`'s baseline —
 *  with none there is no watch, since every phone would look new — and the
 *  "paired now" a per-phone list keeps its other phones by. */
export async function pairedIdsNow(): Promise<string[] | null> {
  const devices = await readPairedDevices();
  return devices ? devices.map((device) => device.id) : null;
}
