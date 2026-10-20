import { useEffect, useState } from "react";
import type { AssistantLaunchOptions, AssistantLaunchRow, TabRow } from "../api";
import { assistantLaunches, replaceAssistantChat } from "../assistantChat";
import { describeFailure } from "../connection";
import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";

/** A launch as the head names it: the CLI, and a local one's model. */
function launchLabel(row: AssistantLaunchRow): string {
  return row.local && row.model ? `${row.label} · ${row.model}` : row.label;
}

/**
 * The Focus chat's title on Tabby's one chat: the CLI it runs as a dropdown
 * (the desktop's launches under their opaque ids, `launch-options`) and
 * Relaunch beside it. Picking another CLI, or Relaunch, starts a fresh chat on
 * that launch and closes the others (`replaceAssistantChat`); the chat then
 * shows in place of this one (`openTab`). A CLI that is not signed in on the
 * desktop is listed dimmed with why — signing in is the desktop's.
 */
export function TabbyHead({ tab, scope, openTab }: {
  tab: TabRow;
  scope: string;
  openTab?: (tab: TabRow) => void;
}) {
  const t = useT();
  const [options, setOptions] = useState<AssistantLaunchOptions | null>(null);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    assistantLaunches(scope, abort.signal).then(
      (answer) => { if (answer) setOptions(answer); },
      () => undefined,
    );
    return () => abort.abort();
  }, [scope]);
  const current = options?.launches.find((row) => row.id === tab.assistant_launch);
  const title = current ? launchLabel(current) : tab.agent_label ?? tab.label;

  const replace = (launch: string) => {
    setMenu(false);
    setBusy(true);
    setFailure("");
    replaceAssistantChat(scope, launch).then(
      (row) => openTab?.(row),
      (reason: unknown) => { setFailure(describeFailure(reason)); setBusy(false); },
    );
  };

  return <>
    <div className="terminal-title"><h1><button
      className="project-title"
      onClick={() => setMenu((open) => !open)}
      disabled={busy}
      aria-haspopup="menu"
      aria-expanded={menu}
      title={t("assistant.newChat.cli")}
    ><span>{title}</span><span className="view-caret" aria-hidden="true" /></button>{isUntested("mobile.assistant") && <small className="untested">{t("mobile.newTab.untested")}</small>}</h1>
      {failure ? <small className="error" role="alert">{failure}</small> : <small>{busy ? t("mobile.assistant.starting") : t("assistant.title")}</small>}</div>
    <button
      className="tabby-relaunch"
      disabled={busy || !tab.assistant_launch}
      onClick={() => tab.assistant_launch && replace(tab.assistant_launch)}
      aria-label={t("assistant.relaunch")}
      title={t("assistant.relaunchHint")}
    ><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" /><path d="M19.5 4.5v4h-4" /></svg></button>
    {menu && <div className="focus-menu-backdrop" role="presentation" onClick={() => setMenu(false)}>
      <div className="focus-menu project-menu" role="menu" aria-label={t("assistant.newChat.cli")} onClick={(event) => event.stopPropagation()}>
        {!options && <p className="sheet-note" role="status">{t("mobile.assistant.loading")}</p>}
        {options && options.launches.length === 0 && <p className="sheet-note">{t(options.ollama_reachable ? "mobile.assistant.none" : "mobile.assistant.ollamaDown")}</p>}
        {options?.launches.map((row) => <button
          key={row.id}
          role="menuitemradio"
          aria-checked={row.id === tab.assistant_launch}
          aria-disabled={row.ready ? undefined : "true"}
          className={row.ready ? undefined : "unavailable"}
          onClick={() => { if (row.ready && row.id !== tab.assistant_launch) replace(row.id); else if (row.ready) setMenu(false); }}
        >
          <span><strong>{launchLabel(row)}</strong>{!row.ready && <small>{t("mobile.assistant.notReady", { label: row.label })}</small>}</span>
          {row.id === tab.assistant_launch && <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 13 4.5 4.5L19 7" /></svg>}
        </button>)}
      </div>
    </div>}
  </>;
}
