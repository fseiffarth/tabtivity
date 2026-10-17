import { useEffect, useState } from "react";
import { getLaunchOptions, type AssistantLaunchOptions, type AssistantLaunchRow } from "../api";
import { describeFailure } from "../connection";
import { isUntested } from "../../../src/lib/untested";
import { useT } from "../../../src/lib/i18n";

/**
 * What the Tabby screen's ＋ opens: the CLIs the desktop can start a chat with,
 * and for a local one the model it drives — each under the opaque id the host
 * derived from the desktop's own options (`launch-options`' `assistant` block),
 * so no CLI name, model path or folder is ever composed on the phone.
 *
 * The same sheet shape as the project ＋ (`NewTabSheet`): a grid of tiles, the
 * local models in their own group beneath. A CLI that is not signed in on the
 * desktop is dimmed, not hidden, and the sheet says why — signing in is the
 * desktop's. Creating is the caller's, as it is there: it owns the idempotency
 * key and the jump into the new chat, and the sheet closes on the tap.
 */
export function NewChatSheet({ projectId, busy, onPick, onClose }: {
  projectId: string;
  busy: boolean;
  onPick: (launchId: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [options, setOptions] = useState<AssistantLaunchOptions | null>(null);
  const [failure, setFailure] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    getLaunchOptions(projectId, abort.signal).then(
      (answer) => { if (answer.assistant) setOptions(answer.assistant); else setFailure(t("mobile.assistant.failed")); },
      (reason: unknown) => { if (!abort.signal.aborted) setFailure(describeFailure(reason)); },
    );
    return () => abort.abort();
    // The sheet is keyed by the scope; `t` changing must not ask the host again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);
  // The desktop's own preselection leads each group.
  const byDefault = (a: AssistantLaunchRow, b: AssistantLaunchRow) => Number(b.default) - Number(a.default);
  const cloud = (options?.launches.filter((row) => !row.local) ?? []).sort(byDefault);
  const local = (options?.launches.filter((row) => row.local) ?? []).sort(byDefault);
  const unsigned = [...new Set(options?.launches.filter((row) => !row.ready && !row.local).map((row) => row.label) ?? [])];
  const title = t("mobile.assistant.newChat");
  const tile = (row: AssistantLaunchRow) => <div className="agent-create" key={row.id}>
    <button
      disabled={busy || !row.ready}
      title={row.ready ? undefined : t("mobile.assistant.notReady", { label: row.label })}
      onClick={() => onPick(row.id)}
    >{row.local && row.model ? row.model : row.label}</button>
  </div>;
  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet new-tab-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header><button className="sheet-close" onClick={onClose} aria-label={t("mobile.newTab.close")}>✕</button><h2>{title}{isUntested("mobile.assistant") && <small>{t("mobile.newTab.untested")}</small>}</h2><span className="sheet-close" aria-hidden="true" /></header>
      <p className="sheet-note">{t("mobile.assistant.note")}</p>
      <div className="create">
        {!options && !failure && <p className="sheet-note" role="status">{t("mobile.assistant.loading")}</p>}
        {failure && <p className="error" role="alert">{failure}</p>}
        {options && options.launches.length === 0 && <p className="sheet-note">{t("mobile.assistant.none")}</p>}
        {cloud.length > 0 && <div className="new-tab-local" role="group" aria-label={t("mobile.assistant.cloudGroup")}>
          <small>{t("mobile.assistant.cloudGroup")}</small>
          <div className="new-tab-agents">{cloud.map(tile)}</div>
        </div>}
        {local.length > 0 && <div className="new-tab-local" role="group" aria-label={t("mobile.assistant.localGroup")}>
          <small>{t("mobile.assistant.localGroup")}</small>
          <div className="new-tab-agents">{local.map(tile)}</div>
        </div>}
        {options && !options.ollama_reachable && local.length === 0 && <p className="sheet-note">{t("mobile.assistant.ollamaDown")}</p>}
        {unsigned.map((label) => <p className="sheet-note" key={label}>{t("mobile.assistant.notReady", { label })}</p>)}
      </div>
    </section>
  </div>;
}
