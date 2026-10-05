import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ConnLamp } from "../common/ConnLamp";
import { ConnTypeIcon, connLabel } from "./ConnTypeIcon";
import { BatteryIndicator } from "./BatteryIndicator";
import { MobileIndicator } from "./MobileIndicator";
import { AlertsToggle } from "./AlertsToggle";
import { VpnIndicator } from "./VpnIndicator";
import { MachinesIndicator } from "./MachinesIndicator";
import { AppResourceDisplay } from "./AppResourceDisplay";
import { DevBuildIndicator } from "./DevBuildIndicator";
import { useQuiesce, saverInterval, usePowerStore } from "../../stores/power";
import { useSettingsStore } from "../../stores/settings";
import {
  summaryLamp,
  useHeaderStatusStore,
  type HeaderStatusKey,
  type HeaderStatusReport,
} from "../../stores/headerStatus";
import { useT } from "../../lib/i18n";

/**
 * The header's machine-state readouts — connection, battery, Mobile, OpenVPN,
 * Machines, CPU/RAM/GPU — as ONE collapsible cluster instead of six permanently
 * lit widgets.
 *
 * The problem it solves is a budget one. Those six are roughly a third of the
 * top bar's width, they never change size, and the only elastic thing in the
 * header is the project pill strip — so every pixel they hold at rest is taken
 * straight out of the app's primary navigation, all day, to say "still fine"
 * six times over.
 *
 * Collapsed, the cluster is a single lamp: the worst thing any member is saying
 * (`summaryLamp`), with every member's line in its tooltip. Clicking expands the
 * whole row back, and that choice PERSISTS (`header_status_expanded`) — a user
 * who wants the old bar clicks once, forever.
 *
 * Collapsed means ALL of it: a failing member folds away like a healthy one.
 * The fold is the user's explicit choice to see one lamp, and popping members
 * back out on `attention`/`alert` reflowed the bar under them. The problem is
 * still said — the summary lamp takes the worst tone (red/amber) and the
 * tooltip lists every member's line — it just does not claim the width back.
 *
 * Two structural notes:
 *  - Folding is `display: none` on a wrapper, NOT unmounting. Every member stays
 *    mounted and keeps polling, because a folded widget still has to report the
 *    tone the summary lamp shows — a Machines indicator that stopped watching
 *    while hidden would leave the lamp green over a dead host. So folding
 *    is a width fix, not a polling fix. The one exception is the
 *    CPU/RAM/GPU readout, which never tones the lamp: folded, it stops its
 *    poll and samples once as the pointer reaches the toggle, whose tooltip
 *    is the only place its figures still appear.
 *  - Members render in a FIXED DOM order whether folded or not, so expanding
 *    puts every widget back in the slot it always had.
 */

/** Below this, folding is worse than the crowding: a one-item fold is a lamp
 *  hiding a lamp. (Two counts the toggle itself as the second thing on screen.) */
const MIN_FOLDABLE = 2;

export function StatusCluster() {
  const t = useT();
  const quiesce = useQuiesce();
  const [online, setOnline] = useState(navigator.onLine);
  const [connType, setConnType] = useState<string | null>(null);
  const [ssid, setSsid] = useState<string | null>(null);
  const batterySupported = usePowerStore((s) => s.supported);
  const batteryPercentage = usePowerStore((s) => s.percentage);
  const onBattery = usePowerStore((s) => s.onBattery);
  const expanded = useSettingsStore((s) => s.settings?.header_status_expanded ?? false);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const reports = useHeaderStatusStore((s) => s.reports);
  const [resourcePeek, setResourcePeek] = useState(0);

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  useEffect(() => {
    // The name is asked for only once the type probe has said "wlan": naming
    // the network costs its own process spawn on every platform, and an
    // Ethernet machine has no answer to give. Clearing it on any other type is
    // what keeps a stale SSID from outliving the link it named.
    const poll = () =>
      invoke<string>("network_conn_type")
        .then(async (kind) => {
          setConnType(kind);
          if (kind !== "wlan") {
            setSsid(null);
            return;
          }
          const name = await invoke<string>("network_wifi_ssid").catch(() => "");
          setSsid(name.trim() || null);
        })
        .catch(() => {});
    poll();
    const id = setInterval(poll, saverInterval(10_000, quiesce));
    return () => clearInterval(id);
  }, [quiesce]);

  const connKind = connType === "lan" ? "lan" : connType === "wlan" ? "wlan" : null;
  const showConn = connKind !== null || !online;
  const batteryPct =
    batteryPercentage == null ? null : Math.round(Math.min(100, Math.max(0, batteryPercentage)));

  // Conn and battery are the cluster's own children — dumb SVGs fed from here
  // rather than self-contained widgets — so their reports are computed inline
  // instead of routed through the store. Same shape, same rules; merging them
  // over the store's reports is what lets the summary lamp and the fold count
  // see all six members as one set.
  const local: Partial<Record<HeaderStatusKey, HeaderStatusReport>> = {};
  if (showConn) {
    local.conn = {
      tone: online ? "ok" : "alert",
      label: connLabel(connKind ?? "wlan", online, ssid, t),
    };
  }
  if (batterySupported) {
    local.battery = {
      // Only a flat battery on its own power is worth reddening the summary lamp
      // for. On mains, or merely low-ish, it is `ok` — a laptop at 35% is not news.
      tone: !onBattery ? "ok" : batteryPct != null && batteryPct <= 15 ? "alert" : "ok",
      label:
        batteryPct == null
          ? t("batteryIndicator.unknown")
          : `${batteryPct}%${!onBattery ? t("batteryIndicator.pluggedSuffix") : ""}`,
    };
  }

  const all: Partial<Record<HeaderStatusKey, HeaderStatusReport>> = { ...local, ...reports };
  const entries = Object.entries(all) as [HeaderStatusKey, HeaderStatusReport][];
  const memberCount = entries.length;
  const collapsed = !expanded && memberCount >= MIN_FOLDABLE;

  const toggleTitle = collapsed
    ? [t("statusCluster.expandTitle"), ...entries.map(([, r]) => r.label)].join("\n")
    : t("statusCluster.collapseTitle");

  return (
    <div className="header-status-cluster">
      {/* Alerts leads the row: it is the one member that is a *control* rather
          than a readout, so it takes the row's head — the slot nearest the
          global-app buttons it used to live among — rather than being buried
          between the VPN lamp and the CPU meters. */}
      <span className="status-cluster-item" data-folded={collapsed}>
        <AlertsToggle />
      </span>
      <span className="status-cluster-item" data-folded={collapsed}>
        {showConn && <ConnTypeIcon type={connKind ?? "wlan"} online={online} ssid={ssid} />}
      </span>
      <span className="status-cluster-item" data-folded={collapsed}>
        {batterySupported && (
          <BatteryIndicator percentage={batteryPercentage} plugged={!onBattery} />
        )}
      </span>
      <span className="status-cluster-item" data-folded={collapsed}>
        <MobileIndicator />
      </span>
      <span className="status-cluster-item" data-folded={collapsed}>
        <VpnIndicator />
      </span>
      <span className="status-cluster-item" data-folded={collapsed}>
        <MachinesIndicator />
      </span>
      <span className="status-cluster-item" data-folded={collapsed}>
        <AppResourceDisplay folded={collapsed} peek={resourcePeek} />
      </span>
      {/* Dev checkouts only: a release build's backend answers no status and
          the chip renders nothing (see DevBuildIndicator). */}
      <span className="status-cluster-item" data-folded={collapsed}>
        <DevBuildIndicator />
      </span>
      {/* The toggle only exists once there is something to fold: with a single
          member (or none) the cluster is already as small as it gets, and a
          chevron next to one lamp is pure noise. */}
      {memberCount >= MIN_FOLDABLE && (
        <button
          type="button"
          className="global-apps-menu-btn status-cluster-toggle"
          aria-expanded={!collapsed}
          aria-label={collapsed ? t("statusCluster.expandTitle") : t("statusCluster.collapseTitle")}
          title={toggleTitle}
          onPointerEnter={collapsed ? () => setResourcePeek((n) => n + 1) : undefined}
          onClick={() => void updateSettings({ header_status_expanded: collapsed })}
        >
          {collapsed && <ConnLamp status={summaryLamp(all)} label={t("statusCluster.label")} />}
          {/* Points the way the cluster moves: ‹ opens it leftwards into the bar,
              › folds it back towards the window controls beside it. */}
          <span className="status-cluster-chevron" aria-hidden>
            {collapsed ? "‹" : "›"}
          </span>
        </button>
      )}
    </div>
  );
}
