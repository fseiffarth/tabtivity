import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../../lib/i18n";
import { IS_HOST_WINDOWS } from "../../lib/platform";
import { splitPtyId } from "../../lib/terminal/ptyId";
import { relaunch, runsLocally } from "../../stores/agents/agentClearUndo";
import { useTabsStore } from "../../stores/tabs";
import { usePaneTab } from "../tabs/paneTabContext";
import { UntestedTag } from "../common/UntestedTag";
import { SIGN_IN_CARD_CLASS } from "./TerminalSignInCard";

const POLL_MS = 5_000;

/**
 * The card a fenced agent's pane shows once the agent has quit. Its tmux pane
 * stays (`remain-on-exit`) so the run stays visible and reattachable, but takes
 * no input — no shell outside the fence is left behind for a phone to type
 * into. Restart relaunches the agent like a restart; Open a shell here is the
 * explicit, user-chosen way to a shell in the same folder.
 * The sign-in card's look and place, and its class, so the pane's own mouse
 * handling leaves clicks inside it alone.
 */
export function TerminalDeadPaneCard({
  host,
  ptyId,
  visible,
}: {
  host: HTMLElement;
  ptyId: string;
  visible: boolean;
}) {
  const t = useT();
  const parts = splitPtyId(ptyId);
  const tab = usePaneTab(parts?.scope, parts?.key);
  const session =
    parts && tab && tab.cmd && !tab.tmuxAttach && !IS_HOST_WINDOWS && runsLocally(parts.scope, tab)
      ? tab.tmuxSession
      : undefined;
  const [dead, setDead] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDead(false);
    if (!session || !visible) return;
    let stopped = false;
    const poll = () =>
      void invoke<boolean>("local_tmux_pane_dead", { session })
        .then((value) => {
          if (!stopped) setDead(value);
        })
        .catch(() => {});
    poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [session, visible, tab?.relaunchSeq]);

  if (!dead || !parts || !tab) return null;
  const restart = async () => {
    setBusy(true);
    setFailed(false);
    const result = await relaunch(parts.scope, tab);
    setBusy(false);
    if (result === "undone") setDead(false);
    else setFailed(true);
  };
  const openShell = () => {
    useTabsStore.getState().addTabToScope(parts.scope, {
      label: t("terminal.deadPane.shellLabel"),
      cmd: "",
      args: [],
      env: {},
      cwd: tab.cwd,
      kind: "shell",
    });
  };
  return createPortal(
    <div className={`hint-bubble ${SIGN_IN_CARD_CLASS} terminal-dead-pane`} role="status">
      <div className="hint-bubble-title">
        {t("terminal.deadPane.title")} <UntestedTag id="terminal.deadPane" />
      </div>
      <div className="hint-bubble-body">{t(failed ? "terminal.deadPane.failed" : "terminal.deadPane.body")}</div>
      <div className="hint-bubble-actions">
        <button type="button" className="hint-bubble-got-it" disabled={busy} onClick={() => void restart()}>
          {t("terminal.deadPane.restart")}
        </button>
        <button type="button" className="hint-bubble-got-it" disabled={busy} onClick={openShell}>
          {t("terminal.deadPane.openShell")}
        </button>
      </div>
    </div>,
    host,
  );
}
