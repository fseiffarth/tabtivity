import { createPortal } from "react-dom";
import { useT } from "../../lib/i18n";
import { splitPtyId } from "../../lib/terminal/ptyId";
import { localTabDriver } from "../../lib/agents/agentReader";
import { useAgentPermissionModeStore } from "../../stores/agents/agentPermissionMode";
import { usePaneTab } from "../tabs/paneTabContext";
import { UntestedTag } from "../common/UntestedTag";
import { SIGN_IN_CARD_CLASS } from "./TerminalSignInCard";
import { CloseIcon } from "../common/icons/Icon";

/**
 * The card a local-model Claude tab shows while Claude's hook reports `auto`
 * mode (`agentPermissionMode`): auto mode sends every tool call to a
 * classifier, which here is the local model, and it gives no verdict Claude
 * Code can use ("auto mode's check had no usable answer"), so commands are
 * refused. It only explains: the mode is the CLI's own, switched with
 * Shift+Tab in the terminal. The undo-clear card's look and place.
 */
export function TerminalLocalAutoModeCard({ host, ptyId }: { host: HTMLElement; ptyId: string }) {
  const t = useT();
  const auto = useAgentPermissionModeStore((state) => state.modes[ptyId] === "auto" && !state.dismissed[ptyId]);
  const parts = splitPtyId(ptyId);
  const tab = usePaneTab(parts?.scope, parts?.key);
  if (!auto || !tab || localTabDriver(tab) !== "claude") return null;
  return createPortal(
    <div className={`hint-bubble ${SIGN_IN_CARD_CLASS} terminal-undo-clear`} role="status">
      <button
        type="button"
        className="hint-bubble-close"
        aria-label={t("terminal.localAutoMode.dismiss")}
        title={t("terminal.localAutoMode.dismiss")}
        onClick={() => useAgentPermissionModeStore.getState().dismiss(ptyId)}
      >
        <CloseIcon />
      </button>
      <div className="hint-bubble-title">
        {t("terminal.localAutoMode.title")} <UntestedTag id="terminal.localAutoMode" />
      </div>
      <div className="hint-bubble-body">{t("terminal.localAutoMode.body")}</div>
    </div>,
    host,
  );
}
