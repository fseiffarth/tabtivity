import { useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../lib/i18n";
import { splitPtyId } from "../../lib/terminal/ptyId";
import { undoAgentClear, useAgentClearUndoStore } from "../../stores/agents/agentClearUndo";
import { usePaneTab } from "../tabs/paneTabContext";
import { UntestedTag } from "../common/UntestedTag";
import { SIGN_IN_CARD_CLASS } from "./TerminalSignInCard";

/**
 * The card an agent pane shows right after its session was cleared — from this
 * window, the phone, or `/clear` typed into the terminal (`agentClearUndo`):
 * "Undo clear" brings back the conversation that clear ended, in-session
 * (Claude) or by relaunching the tab onto it as a restart would.
 * The sign-in card's look and place, and its class, so the pane's own mouse
 * handling leaves clicks inside it alone.
 */
export function TerminalUndoClearCard({ host, ptyId }: { host: HTMLElement; ptyId: string }) {
  const t = useT();
  const offered = useAgentClearUndoStore((state) => !!state.cleared[ptyId]);
  const [failure, setFailure] = useState<"" | "failed" | "remote">("");
  const [busy, setBusy] = useState(false);
  const parts = splitPtyId(ptyId);
  const tab = usePaneTab(parts?.scope, parts?.key);
  if (!offered) return null;
  const undo = async () => {
    if (!parts || !tab) return;
    setBusy(true);
    const result = await undoAgentClear(parts.scope, tab);
    setBusy(false);
    setFailure(result === "tab_not_ready" ? "failed" : result === "remote_tab" ? "remote" : "");
  };
  return createPortal(
    <div className={`hint-bubble ${SIGN_IN_CARD_CLASS} terminal-undo-clear`} role="status">
      <button
        type="button"
        className="hint-bubble-close"
        aria-label={t("terminal.undoClear.dismiss")}
        title={t("terminal.undoClear.dismiss")}
        onClick={() => useAgentClearUndoStore.getState().dismiss(ptyId)}
      >
        ×
      </button>
      <div className="hint-bubble-title">
        {t("terminal.undoClear.title")} <UntestedTag id="terminal.undoClear" />
      </div>
      <div className="hint-bubble-body">
        {t(failure === "failed" ? "terminal.undoClear.failed" : failure === "remote" ? "terminal.undoClear.remote" : "terminal.undoClear.body")}
      </div>
      <div className="hint-bubble-actions">
        <button type="button" className="hint-bubble-got-it" disabled={busy} onClick={() => void undo()}>
          {t("terminal.undoClear.undo")}
        </button>
      </div>
    </div>,
    host,
  );
}
