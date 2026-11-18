import { useT } from "../../lib/i18n";
import { useActivityStore } from "../../stores/activity";
import { useProjectsStore } from "../../stores/projects";
import type { TabEntry } from "../../stores/tabs";
import { ArrowRightIcon } from "../common/icons/Icon";
import { UntestedTag } from "../common/UntestedTag";

/** Which tabs can hand their work to another CLI: an agent tab of a local
 * project, not the assistant and not the root console's Host session. The
 * backend (`services::agent_cli_handoff`) refuses every remote project, its
 * here-running tabs included, and reads the scope's agent home, which is not
 * the Host session's. Remote projects, local-model tabs and the phone come later. */
export function canContinueInAnotherCli(scope: string, tab: TabEntry): boolean {
  if (tab.kind !== "agent" || tab.assistant || tab.hostSession) return false;
  return !useProjectsStore.getState().projects.find((p) => p.id === scope)?.remote;
}

/**
 * The tab right-click menu's "Continue with another CLI…" row. It opens
 * `CliHandoffDialog`; it is disabled while the tab's own turn is running, since
 * the file would hold a half-finished turn. A shell command the agent started
 * (`shell` busy kind) is not a turn. Hidden for a tab that cannot hand off.
 */
export function CliHandoffMenuItem({ scope, tab, onOpen }: { scope: string; tab: TabEntry; onOpen: () => void }) {
  const t = useT();
  const ptyId = `${scope}:${tab.key}`;
  const working = useActivityStore((s) => !!s.busyByTab[ptyId] && s.busyKindByTab[ptyId] !== "shell");
  if (!canContinueInAnotherCli(scope, tab)) return null;
  return (
    <button
      className="tab-new-menu-item"
      disabled={working}
      title={t(working ? "cliHandoff.menuBusy" : "cliHandoff.menuTitle")}
      onClick={onOpen}
    >
      <span className="tab-new-menu-dot tab-new-menu-dot--accent"><ArrowRightIcon /></span>
      {t("cliHandoff.menu")}
      <UntestedTag id="agent.cliHandoff" />
    </button>
  );
}
