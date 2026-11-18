import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../lib/i18n";
import {
  clearContainerNotice,
  onContainerNotice,
  type ContainerNotice,
} from "../../lib/terminal/containerSpawnNotice";
import { useProjectsStore } from "../../stores/projects";
import { UntestedTag } from "../common/UntestedTag";
import { SIGN_IN_CARD_CLASS } from "./TerminalSignInCard";

const COPY = {
  no_docker: { title: "terminal.container.noDockerTitle", body: "terminal.container.noDockerBody" },
  daemon_down: { title: "terminal.container.daemonDownTitle", body: "terminal.container.daemonDownBody" },
} as const;

/**
 * A container tab that could not start because Docker is missing or stopped
 * (`lib/terminal/containerSpawnNotice`): offers to move the project out of its
 * container. Turning the toggle off is project-wide and respawns every tab of
 * the project (the flag is in each TerminalView's spawn deps), this one
 * included; with the engine down no container tab can be live, so nothing is
 * lost by it. The session host card's look and place.
 */
export function TerminalContainerCard({
  host,
  ptyId,
  visible,
}: {
  host: HTMLElement;
  ptyId: string;
  visible: boolean;
}) {
  const t = useT();
  const setProjectSandbox = useProjectsStore((s) => s.setProjectSandbox);
  const [notice, setNotice] = useState<ContainerNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setNotice(null);
    setError(null);
    return onContainerNotice(ptyId, setNotice);
  }, [ptyId]);

  if (!notice || !visible) return null;
  const runWithout = async () => {
    setBusy(true);
    setError(null);
    try {
      const outcome = await setProjectSandbox(notice.projectId, false);
      if (outcome.outcome === "applied") clearContainerNotice(ptyId);
    } catch (e) {
      setError(t("terminal.container.failed", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  };
  return createPortal(
    <div className={`hint-bubble ${SIGN_IN_CARD_CLASS} terminal-session-host`} role="alert">
      <div className="hint-bubble-title">
        {t(COPY[notice.problem].title)} <UntestedTag id="terminal.containerMissing" />
      </div>
      <div className="hint-bubble-body">{t(COPY[notice.problem].body)}</div>
      {error && <div className="hint-bubble-body">{error}</div>}
      <div className="hint-bubble-actions">
        <button type="button" className="hint-bubble-got-it" disabled={busy} onClick={runWithout}>
          {t("terminal.container.runWithout")}
        </button>
      </div>
    </div>,
    host,
  );
}
