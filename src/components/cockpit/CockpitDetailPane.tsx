import { invoke } from "@tauri-apps/api/core";

import { splitPtyId } from "../../stores/activity";
import { BOX_SCOPE_PREFIX, boxFolderOfScope, useBoxesStore } from "../../stores/boxes";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteMachinesStore } from "../../stores/remote/remoteMachines";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { ROOT_SCOPE, allGroups, useTabsStore, type TabEntry } from "../../stores/tabs";
import { useOverlayAgentStore } from "../../stores/overlayAgent";
import { useCalendarStore } from "../../stores/calendar/calendar";
import { useMailStore } from "../../stores/mail";
import { useSettingsStore } from "../../stores/settings";
import { useTodoStore } from "../../stores/todo";
import { steeringAppEnabled, type SteeringApp } from "../../lib/shortcuts/steeringRegion";
import { UntestedTag } from "../common/UntestedTag";
import { ASSISTANT_SCOPE } from "../../lib/assistant";
import { paneRemoteHost } from "../../lib/tabs/remoteHold";
import { useT, type TranslationKey } from "../../lib/i18n";
import { resolveProjectDirectory } from "../../types";
import { AttachedAgentPane } from "../layout/AttachedAgentPane";

/** The popout window (its label) that shows `key` of `scope`, if one does. */
export function popoutLabelOf(
  detachedGroupsByScope: ReturnType<typeof useTabsStore.getState>["detachedGroupsByScope"],
  scope: string,
  key: string,
): string | null {
  for (const entry of detachedGroupsByScope?.[scope] ?? []) {
    if (allGroups(entry.subtree).some((g) => g.tabKeys.includes(key))) return entry.label;
  }
  return null;
}

/** What the detail pane can do for a tab. */
export type CockpitDetailMode = "attach" | "popout" | "docked" | "held" | "missing";

/** The app overlays that can dock a root agent beside them, with the name the
 *  "Shown in the … overlay" line gives each. */
const DOCK_APPS: { app: SteeringApp; name: TranslationKey }[] = [
  { app: "mail", name: "mail.overlayTitle" },
  { app: "calendar", name: "calendar.overlayTitle" },
  { app: "todo", name: "todo.overlayTitle" },
];

/**
 * The app overlay whose docked agent column draws root tab `key` right now, or
 * null. The column (`OverlayAgentColumn`) mounts only while its overlay is open
 * with the dock open on that key, and it marks the key shown while it draws it;
 * this pane must then draw nothing, or two attached views would fight over one
 * PTY's size (and the first to unmount would take the other's mark with it).
 */
export function useDockedApp(scope: string, key: string): SteeringApp | null {
  const docks = useOverlayAgentStore((s) => s.docks);
  const mailOpen = useMailStore((s) => s.overlayOpen);
  const calendarOpen = useCalendarStore((s) => s.overlayOpen);
  const todoOpen = useTodoStore((s) => s.overlayOpen);
  const settings = useSettingsStore((s) => s.settings);
  if (scope !== ROOT_SCOPE) return null;
  const up: Record<SteeringApp, boolean> = { mail: mailOpen, calendar: calendarOpen, todo: todoOpen };
  return (
    DOCK_APPS.find(
      ({ app }) => up[app] && steeringAppEnabled(app, settings) && docks[app].open && docks[app].key === key,
    )?.app ?? null
  );
}

/**
 * The cockpit's detail pane mechanics (`docs/desktop_cockpit_plan.md`, Detail
 * pane mechanics): the selected tab drawn **attach-only** through
 * `AttachedAgentPane` with its Reader always on, the root console's and
 * Tabby's view. The PTY stays owned by the tab's pane in `CenterPanel`; while
 * this is mounted the tab's PTY id is in the shown set (`scopeShownKeys`), so
 * that owner stands down — one visible view per PTY.
 *
 * Keyed by PTY id, so switching the selection unmounts the old view (its
 * effect cleanup takes its key out of the set) before the new one mounts: a
 * key is never held by two views.
 *
 * A root tab is attached like any other (root's `shownKeys`); the Root view is
 * never mounted while this pane is (one shown view at a time), so the console
 * and this pane never draw one PTY together. Four tabs are not attached, each
 * said in one line instead:
 *  - **popout-owned**: a popout window draws it; a second view here would
 *    fight it for the PTY's size. "Open in its window" raises that window.
 *  - **held**: its remote host's pool is down, so its owner never spawned a
 *    PTY to attach to. "Connect first" opens the connect hub.
 *  - **docked**: a root tab an open mail / calendar / to-do overlay shows in
 *    its docked agent column: that view owns the PTY, this one says where.
 *  - **missing**: the tab closed (or its scope is not loaded).
 * A **sleeping** owner needs nothing here: being drawn elsewhere wakes it
 * (`isSleepableTerminalTab`'s `drawnElsewhere`), as it does for root's.
 */
export function cockpitDetailMode(
  tab: TabEntry | undefined,
  { popout, held, docked }: { popout: string | null; held: boolean; docked: SteeringApp | null },
): CockpitDetailMode {
  if (!tab) return "missing";
  if (popout) return "popout";
  if (docked) return "docked";
  if (held) return "held";
  return "attach";
}

export function CockpitDetailPane({ ptyId, focused }: { ptyId: string; focused: boolean }) {
  const t = useT();
  const { scope, key } = splitPtyId(ptyId) ?? { scope: "", key: "" };
  const tab = useTabsStore((s) => s.tabsByScope[scope]?.find((entry) => entry.key === key));
  const popout = useTabsStore((s) => popoutLabelOf(s.detachedGroupsByScope, scope, key));
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === scope));
  const projectSsh = useRemoteStatusStore((s) => s.byProject[scope]?.ssh);
  const hostSsh = useRemoteStatusStore((s) => s.byHost[scope]);
  const boxDir = useBoxesStore((s) => boxFolderOfScope(scope, s.boxes));
  const held = !!tab && paneRemoteHost(tab, project, projectSsh, hostSsh).held;
  const docked = useDockedApp(scope, key);
  const mode = scope === ASSISTANT_SCOPE ? "missing" : cockpitDetailMode(tab, { popout, held, docked });

  if (mode === "missing" || !tab) {
    return <div className="cockpit-detail-pane cockpit-detail-note">{t("cockpit.detail.gone")}</div>;
  }
  if (mode === "popout") {
    return (
      <div className="cockpit-detail-pane cockpit-detail-note">
        <span>{t("cockpit.detail.inPopout")}</span>
        <button
          type="button"
          className="settings-btn sm"
          onClick={() => void invoke<boolean>("focus_detached_window", { label: popout }).catch(() => false)}
        >
          {t("cockpit.detail.openPopout")}
        </button>
      </div>
    );
  }
  if (mode === "docked" && docked) {
    const label = DOCK_APPS.find((d) => d.app === docked)!.name;
    return (
      <div className="cockpit-detail-pane cockpit-detail-note">
        <span>{t("cockpit.detail.docked", { name: t(label) })}</span>
        <UntestedTag id="rootConsole.rootRow" />
      </div>
    );
  }
  if (mode === "held") {
    return (
      <div className="cockpit-detail-pane cockpit-detail-note">
        <span>{t("cockpit.detail.connectFirst")}</span>
        <button type="button" className="settings-btn sm" onClick={() => useRemoteMachinesStore.getState().open(scope)}>
          {t("cockpit.detail.connect")}
        </button>
      </div>
    );
  }
  const scopeDir = scope.startsWith(BOX_SCOPE_PREFIX) ? boxDir : resolveProjectDirectory(project);
  return (
    <div className="cockpit-detail-pane">
      <AttachedAgentPane key={ptyId} scope={scope} tab={tab} focused={focused} readerAlways scopeDir={scopeDir} />
    </div>
  );
}
