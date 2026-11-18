import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../lib/i18n";
import { splitPtyId } from "../../lib/terminal/ptyId";
import {
  clearSessionHostState,
  onSessionHostState,
  type SessionHostUiState,
} from "../../lib/terminal/sessionHostNotice";
import { resumeArgsOf } from "../../stores/tabs/tabKinds";
import { useTabsStore } from "../../stores/tabs";
import { usePaneTab } from "../tabs/paneTabContext";
import { UntestedTag } from "../common/UntestedTag";
import { SIGN_IN_CARD_CLASS } from "./TerminalSignInCard";

const COPY = {
  fallback: { title: "terminal.sessionHost.fallbackTitle", body: "terminal.sessionHost.fallbackBody" },
  unresponsive: { title: "terminal.sessionHost.silentTitle", body: "terminal.sessionHost.silentBody" },
  refused: { title: "terminal.sessionHost.refusedTitle", body: "terminal.sessionHost.refusedBody" },
} as const satisfies Record<SessionHostUiState, { title: string; body: string }>;

/**
 * The Windows session host's notice on one agent pane
 * (docs/windows_session_host_plan.md §4): a host that is definitively absent
 * leaves the tab in the window with a notice (the backend's fallback event,
 * once per app run); a host that is silent or declines fails closed (a
 * `pty_spawn` rejection TerminalView reports), and the pane offers Retry,
 * which respawns the tab on the args a restore would give it. Both live in
 * `lib/terminal/sessionHostNotice`'s per-PTY record, which this card only
 * follows (it clears there on every spawn attempt and when the PTY goes). The backend's
 * shapes are read only in `lib/terminal/sessionHostNotice`. The dead-pane
 * card's look and place.
 */
export function TerminalSessionHostCard({
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
  const [state, setState] = useState<SessionHostUiState | null>(null);

  useEffect(() => {
    setState(null);
    return onSessionHostState(ptyId, setState);
  }, [ptyId]);

  if (!state || !visible || !parts) return null;
  const retry = () => {
    clearSessionHostState(ptyId);
    if (tab) useTabsStore.getState().relaunchTabInScope(parts.scope, tab.key, resumeArgsOf(tab));
  };
  const fallback = state === "fallback";
  return createPortal(
    <div className={`hint-bubble ${SIGN_IN_CARD_CLASS} terminal-session-host`} role={fallback ? "status" : "alert"}>
      <div className="hint-bubble-title">
        {t(COPY[state].title)} <UntestedTag id="terminal.sessionHostFallback" />
      </div>
      <div className="hint-bubble-body">{t(COPY[state].body)}</div>
      <div className="hint-bubble-actions">
        {fallback ? (
          <button type="button" className="hint-bubble-got-it" onClick={() => clearSessionHostState(ptyId)}>
            {t("terminal.sessionHost.gotIt")}
          </button>
        ) : (
          <button type="button" className="hint-bubble-got-it" disabled={!tab} onClick={retry}>
            {t("terminal.sessionHost.retry")}
          </button>
        )}
      </div>
    </div>,
    host,
  );
}
