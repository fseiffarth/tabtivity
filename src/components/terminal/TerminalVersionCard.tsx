import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../lib/i18n";
import { loginIdForCmd } from "../../lib/agents/signInLaunch";
import { useAgentVersionNoticeStore } from "../../stores/agents/agentVersionNotice";
import { UntestedTag } from "../common/UntestedTag";
import { SIGN_IN_CARD_CLASS } from "./TerminalSignInCard";

/**
 * The card an agent pane shows when the host's CLI is newer than the release
 * Tabtivity's flags and parsers were verified with (`agentVersionNotice`). The
 * sign-in card's look and place, and its class, so the pane's own mouse
 * handling leaves clicks inside it alone.
 */
export function TerminalVersionCard({ host, cmd }: { host: HTMLElement; cmd: string }) {
  const t = useT();
  const agent = loginIdForCmd(cmd);
  const notice = useAgentVersionNoticeStore((state) =>
    state.hidden[agent] ? undefined : state.newer[agent],
  );
  const load = useAgentVersionNoticeStore((state) => state.load);
  useEffect(() => {
    void load();
    const refresh = () => void load();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [load]);
  if (!notice) return null;
  const { hide, dismiss } = useAgentVersionNoticeStore.getState();
  return createPortal(
    <div className={`hint-bubble ${SIGN_IN_CARD_CLASS} terminal-version-drift`} role="status">
      <button
        type="button"
        className="hint-bubble-close"
        aria-label={t("terminal.versionDrift.close")}
        title={t("terminal.versionDrift.close")}
        onClick={() => hide(agent)}
      >
        ×
      </button>
      <div className="hint-bubble-title">
        {t("terminal.versionDrift.title", { label: notice.label })}{" "}
        <UntestedTag id="terminal.versionDrift" />
      </div>
      <div className="hint-bubble-body">
        {t("terminal.versionDrift.body", {
          label: notice.label,
          installed: notice.installed,
          verified: notice.verified,
        })}
      </div>
      <div className="hint-bubble-actions">
        <button
          type="button"
          className="hint-bubble-got-it"
          title={t("agents.versionDismissTitle")}
          onClick={() => void dismiss(agent)}
        >
          {t("terminal.versionDrift.dismiss", { installed: notice.installed })}
        </button>
      </div>
    </div>,
    host,
  );
}
