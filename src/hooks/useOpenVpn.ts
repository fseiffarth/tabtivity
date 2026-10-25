import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { subscribeTauri } from "./useTauriListener";
import { onTerminalOutput } from "../lib/terminal/terminalBus";
import type { LogLine } from "../components/common/ConnectionLog";

/**
 * The OpenVPN pieces the Connect dialog (`useRemoteSession`), the reconnect
 * panel (`useRemoteReconnect`), the password prompt (`VpnPasswordPrompt`) and
 * the header menu (`VpnIndicator`) each used to carry a copy of.
 */

/**
 * OpenVPN prints this once the tunnel is fully up (mirrors the backend's
 * READY_MARKER in services/openvpn.rs). An embedded VPN login terminal is
 * watched for it to flip the lamp green.
 */
export const VPN_READY_MARKER = "Initialization Sequence Completed";

/** Lines kept of a handshake log; older ones are trimmed from the head. */
const VPN_LOG_CAP = 500;

/**
 * The live OpenVPN handshake of `config`, streamed from the backend's
 * `openvpn-progress` event (each line is tagged with the config it belongs to,
 * so only this config's lines are kept) and capped so a chatty handshake cannot
 * grow without bound. `clearLog` drops the previous config's / attempt's output.
 * A null/empty `config` listens to nothing.
 */
export function useOpenVpnLog(config: string | null | undefined): {
  log: LogLine[];
  clearLog: () => void;
} {
  const [log, setLog] = useState<LogLine[]>([]);
  // Monotonic id source for the lines: a dedicated counter (never reset on
  // slice) gives each line a stable React key, so the cap trims only the head
  // without re-creating the surviving line nodes.
  const seq = useRef(0);
  useEffect(() => {
    if (!config) return;
    return subscribeTauri(() =>
      listen<{ config: string; line: string }>("openvpn-progress", (ev) => {
        if (ev.payload.config !== config) return;
        setLog((prev) => [...prev, { id: seq.current++, text: ev.payload.line }].slice(-VPN_LOG_CAP));
      }),
    );
  }, [config]);
  const clearLog = useCallback(() => setLog([]), []);
  return { log, clearLog };
}

/**
 * Call `onReady` once the interactive OpenVPN login running in PTY `termId`
 * prints {@link VPN_READY_MARKER}. The embedded login spawns `pkexec openvpn`
 * in its own PTY, so the tunnel is not in the backend's registry; the
 * terminal's own output (heard through the shared `terminalBus`, so a popout
 * hears it under its per-window event name) is the signal. A small rolling
 * buffer catches a marker that straddles two chunks.
 */
export function useVpnReadyMarker(termId: string | null | undefined, onReady: () => void): void {
  const readyRef = useRef(onReady);
  readyRef.current = onReady;
  useEffect(() => {
    if (!termId) return;
    let buf = "";
    // Visible-only streaming: a hidden pane's PTY stops emitting
    // terminal-output entirely, and the login terminal can be hidden while the
    // tunnel comes up — the watch keeps its raw stream flowing so the marker
    // scan below still sees it.
    void invoke("pty_watch", { id: termId }).catch(() => {});
    const stop = onTerminalOutput(termId, (data) => {
      buf = (buf + data).slice(-512);
      if (buf.includes(VPN_READY_MARKER)) readyRef.current();
    });
    return () => {
      stop();
      void invoke("pty_unwatch", { id: termId }).catch(() => {});
    };
  }, [termId]);
}

/**
 * Browse for a `.ovpn`/`.conf` and copy it into Tabtivity's store, so the
 * project no longer depends on the original file's location. Resolves to the
 * stored path, or null when the picker was cancelled; a refused import throws
 * (the caller shows it).
 */
export async function pickAndStoreOvpnConfig(filterLabel: string): Promise<string | null> {
  const picked = await open({
    multiple: false,
    filters: [{ name: filterLabel, extensions: ["ovpn", "conf"] }],
  }).catch(() => null);
  if (typeof picked !== "string") return null;
  return invoke<string>("openvpn_store_config", { config: picked });
}

/**
 * Drop the saved credentials of `config` (the backend clears the passphrase,
 * username and key passphrase together). Resolves to null on success or the
 * backend's message — shown by the caller, never swallowed.
 */
export async function forgetVpnPassword(config: string): Promise<string | null> {
  try {
    await invoke("vpn_forget_password", { config });
    return null;
  } catch (e) {
    return String(e);
  }
}
