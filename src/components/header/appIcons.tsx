import { lazy, Suspense, useState, type ReactNode } from "react";
import { MailIndicator } from "./MailIndicator";
import { CalendarIndicator } from "./CalendarIndicator";
import { TodoIndicator } from "./TodoIndicator";
import { CockpitIndicator } from "./CockpitIndicator";
import { InboxIndicator } from "./InboxIndicator";
import { HelpAgentButton } from "./HelpAgentButton";
import { SettingsMenu } from "./SettingsMenu";
import { LocalModelMenu } from "../layout/LocalModelMenu";
import { AgentsButton } from "./AgentsButton";
import { AlertsToggle } from "./AlertsToggle";
import { MobileIndicator } from "./MobileIndicator";
import { VpnIndicator } from "./VpnIndicator";
import { AppResourceDisplay } from "./AppResourceDisplay";
import { DevBuildIndicator } from "./DevBuildIndicator";
import { useSettingsStore } from "../../stores/settings";
import type { HeaderItemId } from "../../lib/headerPins";

// Code-split (perf plan §6): the Machines menu renders nothing while switched
// off (Settings' "Remote features"; on by default), so its module graph loads
// only once `machines_enabled` is on. Once mounted it stays mounted: switching
// the feature off is its own `!enabled` branch (no menu, header report
// cleared), and a "sign in in a terminal" add/edit still waiting keeps its
// poll and form instead of being dropped by an unmount.
const MachinesIndicator = lazy(() =>
  import("./MachinesIndicator").then((m) => ({ default: m.MachinesIndicator })),
);

function MachinesSlot() {
  const enabled = useSettingsStore((s) => s.settings?.machines_enabled ?? true);
  const [mounted, setMounted] = useState(enabled);
  if (enabled && !mounted) setMounted(true);
  return mounted ? (
    <Suspense fallback={null}>
      <MachinesIndicator />
    </Suspense>
  ) : null;
}

/** Every self-contained top-bar item by id: the global apps and menus, and the
 *  status menus (alerts, Mobile, VPN, Machines, CPU/RAM/GPU, dev build), which
 *  the user may drag into the apps run. `HeaderBar` draws whatever is pinned in
 *  that run from here; `StatusCluster` draws the rest, overriding the members
 *  that need its own state (connection, battery, the folded resource meter).
 *  An id missing here draws NOTHING where `HeaderBar` places it. */
export const APP_ICONS: Partial<Record<HeaderItemId, ReactNode>> = {
  mail: <MailIndicator />,
  calendar: <CalendarIndicator />,
  todo: <TodoIndicator />,
  cockpit: <CockpitIndicator />,
  inbox: <InboxIndicator />,
  agents: <AgentsButton />,
  models: <LocalModelMenu />,
  help: <HelpAgentButton />,
  settings: <SettingsMenu />,
  alerts: <AlertsToggle />,
  mobile: <MobileIndicator />,
  vpn: <VpnIndicator />,
  machines: <MachinesSlot />,
  resources: <AppResourceDisplay />,
  // Dev checkouts only: a release build's backend answers no status and the
  // chip renders nothing (see DevBuildIndicator).
  devBuild: <DevBuildIndicator />,
};
