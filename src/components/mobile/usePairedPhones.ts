import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * A paired phone, in the sidecar's `AdminDevice` shape — the one type for both
 * sources: `mobile_paired_devices` reads `devices.json` whether or not the
 * host runs (`online` always false), and `mobile_admin devices` answers the
 * same rows with `online` while it runs.
 */
export interface PairedPhone {
  id: string;
  name: string;
  /** Unix seconds. */
  created_at: number;
  last_seen_at?: number | null;
  online?: boolean;
  /** Phone sections the desktop keeps this phone out of (absent = none). */
  hidden_sections?: string[];
}

type AdminDevicesAnswer = { status: "devices"; devices: PairedPhone[] } | { status: string };

/**
 * The paired phones, for the per-phone Mobile access picker and the access
 * rows' "N phones" counts. Reads the device file through
 * `mobile_paired_devices` (host up or down) and merges `online` from the
 * running host when it answers. Re-read whenever `refreshKey` changes — the
 * picker passes its open state, so every opening shows the current list.
 * `phones` is `null` until the first answer (and when neither source can be
 * read), so a count is never drawn from a list that is not there. `enabled`
 * false reads nothing — a viewer mounted many times over asks only while its
 * button shows a count.
 */
export function usePairedPhones(refreshKey?: unknown, enabled = true): {
  phones: PairedPhone[] | null;
  refresh: () => void;
} {
  const [phones, setPhones] = useState<PairedPhone[] | null>(null);
  const sequence = useRef(0);
  const refresh = useCallback(() => {
    const mine = ++sequence.current;
    void Promise.allSettled([
      invoke<PairedPhone[]>("mobile_paired_devices"),
      invoke<AdminDevicesAnswer>("mobile_admin", { request: { type: "devices" } }),
    ]).then(([fromFile, fromHost]) => {
      if (mine !== sequence.current) return;
      const live =
        fromHost.status === "fulfilled"
        && fromHost.value?.status === "devices"
        && "devices" in fromHost.value
        && Array.isArray(fromHost.value.devices)
          ? fromHost.value.devices
          : null;
      const paired = fromFile.status === "fulfilled" && Array.isArray(fromFile.value)
        ? fromFile.value
        : live;
      if (!paired) {
        setPhones(null);
        return;
      }
      const online = new Set((live ?? []).filter((d) => d.online).map((d) => d.id));
      setPhones(paired.map((phone) => ({ ...phone, online: online.has(phone.id) })));
    });
  }, []);
  useEffect(() => {
    if (enabled) refresh();
  }, [refresh, refreshKey, enabled]);
  return { phones, refresh };
}

/** What a project's or box's Mobile access reaches, for its button label. */
export type PhoneReach =
  | { kind: "off" }
  | { kind: "all" }
  | { kind: "some"; count: number }
  /** On, but its list names no phone that is still paired (all revoked, a
   *  Lock down, or a malformed value): the sidecar lets no phone in. */
  | { kind: "none" };

/**
 * The reach of a scope's access switch and per-phone list, counting only the
 * ids still paired (`phones`; `null` while unknown counts the list as stored).
 * Mirrors the sidecar: switch off → off; no list → every phone; a list → its
 * paired members, none of them → no phone.
 */
export function phoneReach(
  enabled: boolean,
  devices: unknown,
  phones: PairedPhone[] | null,
): PhoneReach {
  if (!enabled) return { kind: "off" };
  if (devices === undefined || devices === null) return { kind: "all" };
  // A malformed value (not an array of strings) reaches no phone, as there.
  const listed: string[] =
    Array.isArray(devices) && devices.every((d) => typeof d === "string") ? devices : [];
  const paired = phones ? new Set(phones.map((p) => p.id)) : null;
  const count = paired ? listed.filter((id) => paired.has(id)).length : listed.length;
  return count > 0 ? { kind: "some", count } : { kind: "none" };
}
