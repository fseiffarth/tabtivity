import { useEffect, useMemo, useState } from "react";
import { CloseIcon } from "../glyphs";
import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { getArtifact } from "../api";
import { answerHtml } from "../terminal/answerMarkdown";
import { useBackLayer } from "../backStack";

/**
 * A document an Antigravity chat wrote and linked from an answer (a plan, a
 * task list), shown read-only. The desktop reads it from that chat's own
 * folder (`GET /tabs/{id}/artifact`); what comes back is text, formatted the
 * way an answer is (`answerHtml`: nothing in it loads or opens).
 */
export function ArtifactSheet({ tabId, target, onClose }: { tabId: string; target: string; onClose: () => void }) {
  useBackLayer(onClose);
  const t = useT();
  const [state, setState] = useState<{ name: string; text: string } | "loading" | "failed">("loading");
  useEffect(() => {
    const controller = new AbortController();
    setState("loading");
    getArtifact(tabId, target, controller.signal).then(
      (artifact) => { if (!controller.signal.aborted) setState(artifact ?? "failed"); },
      () => { if (!controller.signal.aborted) setState("failed"); },
    );
    return () => controller.abort();
  }, [tabId, target]);
  const html = useMemo(() => (typeof state === "object" ? answerHtml(state.text) : ""), [state]);
  const title = typeof state === "object" ? state.name : t("mobile.artifact.title");
  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet artifact-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header>
        <button className="sheet-close" onClick={onClose} aria-label={t("mobile.focus.messageMenuClose")}><CloseIcon size="1em" /></button>
        <h2>{title} {isUntested("mobile.chat.artifactLink") && <small>{t("mobile.focus.untested")}</small>}</h2>
        <span className="sheet-close" aria-hidden="true" />
      </header>
      {state === "loading" && <p className="sheet-note" role="status">{t("mobile.artifact.loading")}</p>}
      {state === "failed" && <p className="sheet-note error" role="status">{t("mobile.artifact.failed")}</p>}
      {typeof state === "object" && <div className="transcript-md artifact-body" dangerouslySetInnerHTML={{ __html: html }} />}
    </section>
  </div>;
}
