import type { AppLink } from "../../lib/navigation/appLinks";
import { settingsLinkTarget, isMainSection, anchorOf } from "./settingsIndex";
import { translateNow } from "../../lib/i18n";
import { voiceInputOffered } from "../../lib/voice/desktopVoice";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore } from "../../stores/tabs";
import { jumpToTab } from "../../lib/shortcuts/tabJump";

/** Click-only navigation. Never creates tabs, launches commands or writes settings. */
export async function openAppLink(target: AppLink): Promise<boolean> {
  if (target.kind === "settings") {
    const destination = settingsLinkTarget(target.page, target.setting, translateNow);
    if (!destination || (destination.entry === "voice" && !voiceInputOffered())) return false;
    const main = isMainSection(destination.entry);
    window.dispatchEvent(new CustomEvent("app:open-settings", { detail: {
      panel: main ? "main" : destination.entry,
      anchor: isMainSection(destination.entry) ? anchorOf(destination.entry) : undefined,
      reveal: destination.path ? { path: destination.path, open: destination.open } : undefined,
    } }));
    return true;
  }
  if (target.kind === "project") {
    const projects = useProjectsStore.getState();
    if (!projects.projects.some((project) => project.id === target.id)) return false;
    await projects.setActive(target.id);
    return true;
  }
  const tabs = useTabsStore.getState();
  const list = target.scope === tabs.scope ? tabs.tabs : tabs.tabsByScope[target.scope];
  if (!list?.some((tab) => tab.key === target.id)) return false;
  jumpToTab(target.scope, target.id);
  return true;
}
