import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../../stores/settings";
import { useT } from "../../lib/i18n";
import { MailIcon, WarningIcon } from "../common/icons/Icon";

/** What `root_mcp_status` answers (`services::root_mcp`). */
export interface RootMcpStatus {
  running: boolean;
  tools: string[];
  /** At least one mail account is open to a contained reader agent. */
  mail_open?: boolean;
  /** With `mail_open`: the widest per-account scope — a few marked messages,
   *  or a whole account. */
  mail_scope?: "marked" | "all";
  /** Root agents run fenced, so the staged-write review cannot be bypassed. */
  review_enforced?: boolean;
  /** A root agent started now could read the projects (the fence switch is
   *  on, or it runs unfenced) — what a mail draft's `attach` needs. */
  projects_readable?: boolean;
}

/** What the rights badge reports, read once per mount ({@link useRootMcpRights}). */
export interface RootMcpRights {
  status: RootMcpStatus | null;
  /** Settings' global switch (`root_mcp`). */
  toolsEnabled: boolean;
  /** Settings' `root_mcp_local_only`. */
  localOnly: boolean;
  /** Switched on AND the listener runs. */
  toolsOn: boolean;
  /** The tools are on but the staged-write review can be bypassed. */
  reviewAdvisory: boolean;
}

/**
 * The root agents' MCP rights: `root_mcp_status` asked once per mount (the
 * listener's `running` only moves on a restart), the settings switches live —
 * so the badge follows a flip made in Settings at once.
 */
export function useRootMcpRights(): RootMcpRights {
  const [status, setStatus] = useState<RootMcpStatus | null>(null);
  useEffect(() => {
    invoke<RootMcpStatus>("root_mcp_status").then(setStatus).catch(() => setStatus(null));
  }, []);
  const toolsEnabled = useSettingsStore((s) => s.settings?.root_mcp ?? true);
  const localOnly = useSettingsStore((s) => s.settings?.root_mcp_local_only ?? false);
  const toolsOn = toolsEnabled && !!status?.running;
  // `=== false`: a backend that predates the field says nothing, which is not
  // a claim that the gate is off.
  const reviewAdvisory = toolsOn && status?.review_enforced === false;
  return { status, toolsEnabled, localOnly, toolsOn, reviewAdvisory };
}

/**
 * The "⚿ tools" chip: which tools a root tab gets, whether mail is open to
 * agents, whether the review gate is enforced. It only REPORTS — switching
 * the tools on and off stays in Settings. Shared by the root console's title
 * bar and the docked agent column of the mail / calendar / to-do overlays
 * (`OverlayAgentColumn`), so both say the same thing about the same tabs.
 */
export function RootRightsBadge({ rights }: { rights: RootMcpRights }) {
  const t = useT();
  const { status, toolsEnabled, localOnly, toolsOn, reviewAdvisory } = rights;
  const agentsWithTools = !toolsEnabled
    ? t("rootConsole.rightsDisabled")
    : status?.running
      ? t(localOnly ? "rootConsole.rightsLocalOnly" : "rootConsole.rightsOn")
      : t("rootConsole.rightsOff");
  return (
    <span
      className={`root-overlay-rights status${toolsOn ? " on" : ""}${toolsEnabled ? "" : " off"}`}
      title={`${agentsWithTools}${
        toolsOn ? `\n${status?.tools.join(", ")}` : ""
      }\n${t("rootConsole.rightsInSettings")}\n${t("rootConsole.noPhone")}${
        status?.mail_open
          ? `\n${t(status.mail_scope === "all" ? "rootConsole.mailOpenAll" : "rootConsole.mailOpen")}`
          : ""
      }${reviewAdvisory ? `\n${t("rootConsole.reviewAdvisory")}` : ""}`}
    >
      {t("rootConsole.rightsBadge")}{reviewAdvisory && <> <WarningIcon /></>}
      {status?.mail_open && <> <MailIcon />{status.mail_scope === "all" && <MailIcon />}</>}
    </span>
  );
}
