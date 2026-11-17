import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";

import { answerHtml } from "../../../mobile-web/src/terminal/answerMarkdown";
import { useT } from "../../lib/i18n";
import { DialogShell } from "../common/PromptDialogs";
import { UntestedTag } from "../common/UntestedTag";

/** What `agent_tab_artifact` answers: one document's name and text. */
interface Artifact {
  name: string;
  text: string;
}

/**
 * A document an Antigravity chat wrote and linked from an answer (a plan, a
 * task list — `[plan.md](file:///…/brain/<id>/plan.md)`), shown read-only. The
 * file is outside the project, so no path link reaches it: the backend reads
 * it from this tab's own conversation folder (`services::agent_artifacts`) and
 * answers nothing for any other file. The text is formatted the way an answer
 * is (`answerHtml`: nothing in it loads or opens).
 *
 * `request` is the Reader's transcript request for the tab (`readerRequest`),
 * which names the project, the tab's folder and its launch id.
 */
export function ReaderArtifactDialog({ target, request, onClose }: {
  target: string;
  request: Record<string, unknown>;
  onClose: () => void;
}) {
  const t = useT();
  const [state, setState] = useState<Artifact | "loading" | "failed">("loading");
  useEffect(() => {
    let cancelled = false;
    setState("loading");
    invoke<Artifact | null>("agent_tab_artifact", {
      projectId: request.projectId ?? null,
      tabDir: request.tabDir ?? "",
      sessionId: request.sessionId ?? "",
      target,
    }).then(
      (artifact) => { if (!cancelled) setState(artifact ?? "failed"); },
      () => { if (!cancelled) setState("failed"); },
    );
    return () => { cancelled = true; };
    // One read per opened link; the request is the tab's at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  const html = useMemo(() => (typeof state === "object" ? answerHtml(state.text) : ""), [state]);
  const title = typeof state === "object" ? state.name : t("terminal.reader.artifact.title");
  return (
    <DialogShell
      onDismiss={onClose}
      frame="settings-dialog"
      scroll
      title={<>{title} <UntestedTag id="terminal.reader.artifactLink" /></>}
    >
      {state === "loading" && <p role="status">{t("terminal.reader.artifact.loading")}</p>}
      {state === "failed" && <p role="alert">{t("terminal.reader.artifact.failed")}</p>}
      {typeof state === "object" && <div className="markdown-body terminal-reader-md" dangerouslySetInnerHTML={{ __html: html }} />}
    </DialogShell>
  );
}
