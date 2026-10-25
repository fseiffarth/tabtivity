import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { encode } from "uqr";
import { useT, translateNow } from "../../lib/i18n";
import {
  useMobileHostStatusStore,
  type MobileHostRuntimeStatus,
} from "../../stores/mobileHostStatus";

/** A one-time pairing code with the private address a phone opens to use it. */
export interface Pairing {
  code: string;
  /** Unix seconds; the sidecar's `PAIR_TTL` (five minutes). */
  expiresAt: number;
  /** The verified Tailscale Serve origin, when the host reports one. */
  origin: string | null;
}

/** What the Add device QR carries: the private Serve origin, with the code in
 *  the fragment. A fragment never reaches a server, and the phone's pairing
 *  screen takes it once and wipes it from the address (`mobile-web` `Pair`). */
export function pairingUrl(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, "")}/#pair=${encodeURIComponent(code)}`;
}

/** Asks the running host for a fresh code. The host is asked again first
 *  rather than trusted from the last poll, which may be 15 s old. */
async function requestPairing(): Promise<Pairing> {
  const current = await invoke<MobileHostRuntimeStatus>("mobile_host_status");
  useMobileHostStatusStore.getState().publish(current);
  if (!current.running) throw new Error(translateNow("mobile.errStartHostFirst"));
  const response = await invoke<{ status: string; code?: string; expires_at?: number; message?: string }>(
    "mobile_admin",
    { request: { type: "pairing_code" } },
  );
  if (response.status !== "pairing_code" || !response.code) {
    throw new Error(response.message ?? translateNow("mobile.errPairingUnavailable"));
  }
  return {
    code: response.code,
    expiresAt: response.expires_at ?? Math.floor(Date.now() / 1000) + 300,
    origin: current.origin ?? null,
  };
}

/** The Add device flow's state, shared by the header Mobile menu and Settings.
 *  A code is dropped when it expires: one still on screen after it stopped
 *  working is worse than none. */
export function useAddDevice() {
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!pairing) return;
    const remaining = pairing.expiresAt * 1000 - Date.now();
    if (remaining <= 0) {
      setPairing(null);
      return;
    }
    const timer = window.setTimeout(() => setPairing(null), remaining);
    return () => window.clearTimeout(timer);
  }, [pairing]);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    setPairing(null);
    try {
      setPairing(await requestPairing());
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }, []);
  const clear = useCallback(() => setPairing(null), []);

  return { pairing, busy, error, start, clear };
}

/** A QR code as one SVG path, dark on a fixed white square with the standard
 *  four-module quiet zone. Fixed colours, not theme tokens: a camera reads
 *  contrast, and a themed palette (lavender, dark) can make a scan fail. */
export function QrCode({ text, label }: { text: string; label: string }) {
  const { size, path } = useMemo(() => {
    const qr = encode(text, { ecc: "M", border: 4 });
    let d = "";
    qr.data.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`;
      });
    });
    return { size: qr.size, path: d };
  }, [text]);
  return (
    <svg
      className="mobile-pair-qr"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

/** The new code: a QR to scan when the host knows its address, and the code
 *  itself to type. */
export function AddDevicePanel({ pairing }: { pairing: Pairing }) {
  const t = useT();
  return (
    <div className="mobile-indicator-paircode" role="status">
      {pairing.origin && <QrCode text={pairingUrl(pairing.origin, pairing.code)} label={t("mobile.addDeviceQr")} />}
      <code>{pairing.code}</code>
      <span>{pairing.origin ? t("mobile.addDeviceScan") : t("mobile.pairCodeValidity")}</span>
    </div>
  );
}
