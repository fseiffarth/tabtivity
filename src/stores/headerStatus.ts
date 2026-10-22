import { useEffect } from "react";
import { create } from "zustand";
import type { ConnState } from "./remote/remoteStatus";

/**
 * What the header's right-hand status widgets currently have to say — the one
 * place `StatusCluster` reads to answer which lamp to show while everything is
 * folded away, and what each folded member would have said (its tooltip).
 *
 * Each widget self-reports rather than the cluster re-deriving six states from
 * six different stores: the widget already computed its own lamp (VPN's
 * `off|connecting|connected`, Machines' lamp buckets, Mobile's tone), and a
 * second copy of that logic in the cluster would drift the moment either side
 * changed. A report is therefore a *summary* of a reading the widget was making
 * anyway, not a new measurement — nothing here polls.
 *
 * Widgets report from an effect, so a widget that renders nothing at all (its
 * feature is off) reports `null` and simply is not a member: the cluster never
 * counts it, never folds it, and never lets it colour the summary lamp.
 */
export type HeaderStatusKey =
  | "conn"
  | "battery"
  | "mobile"
  | "vpn"
  | "machines"
  | "resources"
  | "alerts"
  | "devBuild";

/**
 * How loudly a member is speaking.
 *  - `off`       → present but dormant (no tunnel, no machines, nothing to say).
 *  - `ok`        → nominal. Folds away; contributes green to the summary lamp.
 *  - `attention` → transient and worth watching (a tunnel mid-connect).
 *  - `alert`     → wrong (offline, a machine erroring, a nearly flat battery).
 *
 * The tone only colours the collapsed cluster's summary lamp (`summaryLamp`);
 * a collapsed cluster hides every member, `alert` ones included — the user
 * chose one lamp, and the lamp going red/amber is how a problem is said.
 *
 * Deliberately `ok`: anything that toggles on ordinary work. A CPU spike during
 * a build, a Mobile status flipping to "checking" every poll, a fleet
 * reconnecting at launch — each would flicker the summary lamp amber all day,
 * which trains the user to ignore it. */
export type HeaderStatusTone = "off" | "ok" | "attention" | "alert";

export interface HeaderStatusReport {
  tone: HeaderStatusTone;
  /** One line of the collapsed button's tooltip — what this member would have
   *  said had it been visible. */
  label: string;
}

interface HeaderStatusState {
  reports: Partial<Record<HeaderStatusKey, HeaderStatusReport>>;
  /** `null` clears the key: the widget renders nothing and is not a member. */
  report: (key: HeaderStatusKey, next: HeaderStatusReport | null) => void;
}

export const useHeaderStatusStore = create<HeaderStatusState>((set) => ({
  reports: {},
  report: (key, next) =>
    set((s) => {
      const prev = s.reports[key];
      if (next === null) {
        if (prev === undefined) return s;
        const reports = { ...s.reports };
        delete reports[key];
        return { reports };
      }
      // Identity-stable when nothing changed: these widgets re-render on every
      // poll tick, and a fresh object each time would re-render the cluster
      // (and so the whole header) several times a second for no new fact.
      if (prev && prev.tone === next.tone && prev.label === next.label) return s;
      return { reports: { ...s.reports, [key]: next } };
    }),
}));

/**
 * Publish one widget's summary. Call it unconditionally, ABOVE the widget's own
 * `return null` — a widget that has switched itself off still has to say so, and
 * hooks cannot hide behind an early return anyway. Pass `null` for "I render
 * nothing".
 */
export function useHeaderStatusReport(
  /** `null`: this caller reports nothing (a second surface of a member that
   *  already reports, e.g. the Machines overlay) — and clears nothing. */
  key: HeaderStatusKey | null,
  report: HeaderStatusReport | null,
) {
  const tone = report?.tone ?? null;
  const label = report?.label ?? null;
  // Split from the unmount cleanup on purpose. One effect with a cleanup would
  // clear the key and re-add it on every tone change, and a member that blinks
  // out of existence for an instant also blinks the chevron on and off.
  useEffect(() => {
    if (key === null) return;
    const { report: publish } = useHeaderStatusStore.getState();
    publish(key, tone === null ? null : { tone, label: label ?? "" });
  }, [key, tone, label]);
  useEffect(() => {
    if (key === null) return;
    return () => useHeaderStatusStore.getState().report(key, null);
  }, [key]);
}

/**
 * The collapsed button's own lamp: the worst thing any member is saying, in the
 * `ConnLamp` vocabulary the rest of the header already speaks. Grey when every
 * member is dormant — not green, which would claim a connection nobody has.
 */
export function summaryLamp(
  reports: Partial<Record<HeaderStatusKey, HeaderStatusReport>>,
): ConnState {
  const tones = Object.values(reports).map((r) => r.tone);
  if (tones.includes("alert")) return "error";
  if (tones.includes("attention")) return "connecting";
  if (tones.includes("ok")) return "connected";
  return "off";
}
