import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../lib/i18n";
import { loginIdForCmd } from "../../lib/agents/signInLaunch";
import {
  offeredUpdate,
  subscribeAgentUpdates,
  useAgentVersionNoticeStore,
} from "../../stores/agents/agentVersionNotice";
import { useModelsOverlayStore } from "../../stores/modelsOverlay";
import { UntestedTag } from "../common/UntestedTag";
import { SIGN_IN_CARD_CLASS } from "./TerminalSignInCard";
import { CloseIcon } from "../common/icons/Icon";

/**
 * The card an agent pane shows when the host's CLI is newer than the release
 * Tabtivity's flags and parsers were verified with (`agentVersionNotice`). The
 * sign-in card's look and place, and its class, so the pane's own mouse
 * handling leaves clicks inside it alone.
 *
 * Before that, the same place says when a newer release of the CLI is out
 * (the stored update check, `services::agent_latest`, asked once a day): only
 * on a tab that opens while the release is known, not on every tab already
 * open when the daily check finds it. "Update…" opens Manage CLIs, where the
 * update runs with its log; × hides that release until restart.
 */
export function TerminalVersionCard({ host, cmd }: { host: HTMLElement; cmd: string }) {
  const t = useT();
  const agent = loginIdForCmd(cmd);
  const notice = useAgentVersionNoticeStore((state) =>
    state.hidden[agent] ? undefined : state.newer[agent],
  );
  const load = useAgentVersionNoticeStore((state) => state.load);
  // The release this tab offers, fixed by the first read after it opened.
  const [offered, setOffered] = useState<string | null>(null);
  const update = useAgentVersionNoticeStore((state) => offeredUpdate(state, agent));
  const label = useAgentVersionNoticeStore((state) => state.labels[agent] ?? agent);
  useEffect(() => {
    let alive = true;
    void load().then(() => {
      if (!alive) return;
      setOffered(offeredUpdate(useAgentVersionNoticeStore.getState(), agent)?.latest ?? null);
    });
    const refresh = () => void load();
    window.addEventListener("focus", refresh);
    const unsubscribe = subscribeAgentUpdates();
    return () => {
      alive = false;
      window.removeEventListener("focus", refresh);
      unsubscribe();
    };
  }, [load, agent]);
  if (update && offered && update.latest === offered) {
    return createPortal(
      <div className={`hint-bubble ${SIGN_IN_CARD_CLASS} terminal-version-drift`} role="status">
        <button
          type="button"
          className="hint-bubble-close"
          aria-label={t("terminal.agentUpdate.close")}
          title={t("terminal.agentUpdate.close")}
          onClick={() => useAgentVersionNoticeStore.getState().hideUpdate(agent, offered)}
        >
          <CloseIcon />
        </button>
        <div className="hint-bubble-title">
          {t("terminal.agentUpdate.title", { label, latest: offered })}{" "}
          <UntestedTag id="terminal.agentUpdate" />
        </div>
        <div className="hint-bubble-body">
          {t("terminal.agentUpdate.body", { installed: update.current ?? "", latest: offered })}
        </div>
        <div className="hint-bubble-actions">
          <button
            type="button"
            className="hint-bubble-got-it"
            onClick={() => useModelsOverlayStore.getState().openOverlay("agents")}
          >
            {t("terminal.agentUpdate.open")}
          </button>
        </div>
      </div>,
      host,
    );
  }
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
        <CloseIcon />
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
