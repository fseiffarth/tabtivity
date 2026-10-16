import { createPortal } from "react-dom";
import { useT } from "../../lib/i18n";
import { storageKey } from "../../lib/brand";
import { UntestedTag } from "../common/UntestedTag";
import { SIGN_IN_CARD_CLASS } from "./TerminalSignInCard";

/** localStorage record of project ids whose empty-AGENTS.md card was dismissed. */
const DISMISSED_KEY = storageKey("agents-empty-dismissed");

function readDismissed(): Record<string, true> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, true>;
    }
  } catch {
    /* ignore storage failures */
  }
  return {};
}

/** True when the card for this project was dismissed before. */
export function agentsEmptyDismissed(projectId: string): boolean {
  return !!readDismissed()[projectId];
}

/** Remember the dismissal, so the card shows at most once per project. */
export function dismissAgentsEmpty(projectId: string): void {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify({ ...readDismissed(), [projectId]: true }));
  } catch {
    /* ignore storage failures */
  }
}

/**
 * The card an agent pane shows once when its project's `AGENTS.md` still
 * holds no project guidance (missing, empty, or the untouched scaffold stub,
 * per the backend's `project_agents_empty`): describe the project below and
 * the agent fills it in. "Fill AGENTS.md" pastes that instruction into the
 * pane; × dismisses forever for the project.
 *
 * The sign-in card's look and place, so the pane's own mouse handling leaves
 * clicks inside it alone.
 */
export function TerminalAgentsEmptyCard({
  host,
  projectId,
  onFill,
  onDismiss,
}: {
  host: HTMLElement;
  projectId: string;
  onFill: () => void;
  onDismiss: () => void;
}) {
  const t = useT();
  const dismiss = () => {
    dismissAgentsEmpty(projectId);
    onDismiss();
  };
  return createPortal(
    <div className={`hint-bubble ${SIGN_IN_CARD_CLASS} terminal-agents-empty`} role="status">
      <button
        type="button"
        className="hint-bubble-close"
        aria-label={t("terminal.agentsEmpty.dismiss")}
        title={t("terminal.agentsEmpty.dismiss")}
        onClick={dismiss}
      >
        ×
      </button>
      <div className="hint-bubble-title">
        {t("terminal.agentsEmpty.title")} <UntestedTag id="terminal.agentsEmpty" />
      </div>
      <div className="hint-bubble-body">{t("terminal.agentsEmpty.body")}</div>
      <div className="hint-bubble-actions">
        <button type="button" className="hint-bubble-got-it" onClick={onFill}>
          {t("terminal.agentsEmpty.fill")}
        </button>
      </div>
    </div>,
    host,
  );
}
