import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../lib/i18n";
import { agentLabelOfCmd } from "../../lib/agents/dialogOnScreen";
import { splitPtyId } from "../../lib/terminal/ptyId";
import { useActivityStore } from "../../stores/activity";
import {
  armMcpReconnect,
  disarmMcpReconnect,
  dismissMcpStale,
  mcpReconnectKind,
  mcpStaleTurnInFlight,
  reconnectMcpStale,
  useMcpStaleStore,
  watchMcpStaleNotices,
} from "../../stores/agents/mcpStale";
import { usePaneTab } from "../tabs/paneTabContext";
import { useDialogs } from "../common/PromptDialogs";
import { CloseIcon } from "../common/icons/Icon";
import { UntestedTag } from "../common/UntestedTag";
import { SIGN_IN_CARD_CLASS } from "./TerminalSignInCard";

/**
 * The card over a local agent tab whose Tabtivity tools went dead on a
 * reattach (`stores/agents/mcpStale`): the agent kept the earlier run's MCP
 * port and tokens. Reconnect restarts it on its conversation; mid-turn the
 * button arms "Reconnect when this turn ends" instead. A "continue the latest"
 * CLI confirms first; one that cannot resume gets the notice only.
 * The dead-pane card's look, place and class (`TerminalDeadPaneCard`), lifted
 * over the agent's composer like the undo-clear card.
 */
export function TerminalMcpStaleCard({ host, ptyId }: { host: HTMLElement; ptyId: string }) {
  const t = useT();
  const { confirmAction, dialogs } = useDialogs();
  const shown = useMcpStaleStore((s) => !!s.stale[ptyId] && !s.dismissed[ptyId]);
  const armed = useMcpStaleStore((s) => !!s.armed[ptyId]);
  // Re-render on the hook's verdicts and on the bytes' busy flag: both feed
  // `mcpStaleTurnInFlight`.
  useMcpStaleStore((s) => s.turns[ptyId]?.state);
  useActivityStore((s) => !!s.busyByTab[ptyId]);
  // A tab can also go stale after its spawn answered (a revived token the
  // backend then refused): hear that while any agent terminal is here.
  useEffect(() => watchMcpStaleNotices(), []);
  const parts = splitPtyId(ptyId);
  const tab = usePaneTab(parts?.scope, parts?.key);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!shown || !parts || !tab) return dialogs;

  const kind = mcpReconnectKind(parts.scope, tab);
  const working = mcpStaleTurnInFlight(ptyId);
  const agent = agentLabelOfCmd(tab.cmd);
  const confirmed = () =>
    kind !== "latest" ||
    confirmAction({
      title: t("terminal.mcpStale.latestTitle", { agent }),
      body: t("terminal.mcpStale.latestBody", { agent }),
      confirmLabel: t("terminal.mcpStale.reconnect"),
    });
  const run = async (action: () => Promise<string>) => {
    if (!(await confirmed())) return;
    setBusy(true);
    setFailed(false);
    const result = await action();
    setBusy(false);
    setFailed(result !== "undone" && result !== "armed" && result !== "gone");
  };

  const body =
    kind === "none"
      ? "terminal.mcpStale.noResume"
      : failed
        ? "terminal.mcpStale.failed"
        : armed
          ? "terminal.mcpStale.armed"
          : "terminal.mcpStale.body";
  return (
    <>
      {createPortal(
        <div className={`hint-bubble ${SIGN_IN_CARD_CLASS} terminal-mcp-stale`} role="status">
          <button
            type="button"
            className="hint-bubble-close"
            aria-label={t("terminal.mcpStale.dismiss")}
            title={t("terminal.mcpStale.dismiss")}
            onClick={() => dismissMcpStale(ptyId)}
          >
            <CloseIcon />
          </button>
          <div className="hint-bubble-title">
            {t("terminal.mcpStale.title")} <UntestedTag id="terminal.mcpStale" />
          </div>
          <div className="hint-bubble-body">{t(body)}</div>
          {kind !== "none" && (
            <div className="hint-bubble-actions">
              {armed ? (
                <button type="button" className="hint-bubble-got-it" onClick={() => disarmMcpReconnect(ptyId)}>
                  {t("terminal.mcpStale.cancelArmed")}
                </button>
              ) : working ? (
                <button
                  type="button"
                  className="hint-bubble-got-it"
                  disabled={busy}
                  onClick={() => void run(() => armMcpReconnect(ptyId))}
                >
                  {t("terminal.mcpStale.reconnectAfterTurn")}
                </button>
              ) : (
                <button
                  type="button"
                  className="hint-bubble-got-it"
                  disabled={busy}
                  onClick={() => void run(() => reconnectMcpStale(ptyId))}
                >
                  {t("terminal.mcpStale.reconnect")}
                </button>
              )}
            </div>
          )}
        </div>,
        host,
      )}
      {dialogs}
    </>
  );
}

/** The hover card's word for a stale tab (`TabHoverCard`'s feature rows). */
export function McpStaleHoverMark() {
  const t = useT();
  return (
    <>
      <span className="tab-popup-mcp off">{t("tabHoverCard.mcpStale")}</span>{" "}
      <UntestedTag id="tabHoverCard.mcpStale" />
    </>
  );
}
