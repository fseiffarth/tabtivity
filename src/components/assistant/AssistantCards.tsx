import { useState } from "react";
import type { AssistantCliOption, AssistantOptions } from "../../lib/assistant";
import { signInLaunch } from "../../lib/agents/signInLaunch";
import { runInstallInTab } from "../../lib/installCommand";
import { useT } from "../../lib/i18n";
import type { CliBlock } from "./useAssistantOptions";
import { AssistantSearchSetup } from "./AssistantSearchSetup";

/** The binary a cloud assistant CLI signs in with (its `AssistantCli::bin`). */
const SIGN_IN_BIN: Record<string, string> = { claude: "claude", codex: "codex" };

/** Open Settings on a page, the way the intro's "all CLIs" button does. */
function openSettings(panel: "agents" | "ollama") {
  window.dispatchEvent(new CustomEvent("app:open-settings", { detail: panel }));
}

/**
 * What stands between the chosen CLI and a first chat, as a card with the one
 * click that fixes it. The sign-in is the intro wizard's flow: a terminal tab
 * in the root console that runs the CLI's own login command (the login lands
 * in the shared agent auth, so every Tabby chat sees it); the overlay's options
 * poll then notices the new login and lifts the card.
 */
export function CliBlockCard({
  block,
  cli,
  onRecheck,
}: {
  block: Exclude<CliBlock, null>;
  cli: AssistantCliOption;
  /** Re-read the options now (after a sign-in or an install). */
  onRecheck: () => void;
}) {
  const t = useT();
  const bin = SIGN_IN_BIN[cli.id];
  const signIn = () => {
    if (!bin) return;
    const launch = signInLaunch(bin);
    runInstallInTab(t("intro.agents.signInTabLabel", { label: cli.label }), [bin, ...launch.args].join(" "), "default");
  };
  const recheck = (
    <button type="button" className="settings-btn sm" onClick={onRecheck}>
      {t("assistant.recheck")}
    </button>
  );
  return (
    <div className="settings-card assistant-card" role="status">
      {block === "signIn" && (
        <>
          <div className="assistant-card-title">{t("assistant.signIn.title", { cli: cli.label })}</div>
          <p className="settings-help">{t("assistant.signIn.body", { cli: cli.label })}</p>
          <div className="settings-link-row">
            {bin ? (
              <button type="button" className="settings-btn sm primary" onClick={signIn}>
                {t("assistant.signIn.button", { cli: cli.label })}
              </button>
            ) : (
              <button type="button" className="settings-btn sm primary" onClick={() => openSettings("agents")}>
                {t("assistant.openAgents")}
              </button>
            )}
            {recheck}
          </div>
        </>
      )}
      {block === "notInstalled" && (
        <>
          <div className="assistant-card-title">{t("assistant.notInstalled.title", { cli: cli.label })}</div>
          <p className="settings-help">
            {t(cli.local ? "assistant.notInstalled.bodyLocal" : "assistant.notInstalled.body", { cli: cli.label })}
          </p>
          <div className="settings-link-row">
            <button type="button" className="settings-btn sm primary" onClick={() => openSettings("agents")}>
              {t("assistant.openAgents")}
            </button>
            {recheck}
          </div>
        </>
      )}
      {(block === "ollamaDown" || block === "noModel") && (
        <>
          <div className="assistant-card-title">
            {t(block === "ollamaDown" ? "assistant.ollamaDown.title" : "assistant.noModel.title")}
          </div>
          <p className="settings-help">
            {t(block === "ollamaDown" ? "assistant.ollamaDown.body" : "assistant.noModel.body")}
          </p>
          <div className="settings-link-row">
            <button type="button" className="settings-btn sm primary" onClick={() => openSettings("ollama")}>
              {t("assistant.openOllama")}
            </button>
            {recheck}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The search setup card for a local model: without a search backend its
 * `web_search` answers `search_not_configured`, and the model has nothing else
 * to look things up with. Shown when the options say none is configured;
 * `compact` folds the form behind one button (the banner above an open chat).
 */
export function SearchSetupCard({
  options,
  compact = false,
  onSaved,
}: {
  options: AssistantOptions;
  compact?: boolean;
  onSaved: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(!compact);
  if (options.search.configured) return null;
  return (
    <div className="assistant-card assistant-card-plain">
      <div className="assistant-card-title">{t("assistant.searchCard.title")}</div>
      <p className="settings-help">{t("assistant.searchCard.body")}</p>
      {open ? (
        <AssistantSearchSetup search={options.search} onSaved={onSaved} />
      ) : (
        <div className="settings-link-row">
          <button type="button" className="settings-btn sm primary" onClick={() => setOpen(true)}>
            {t("assistant.searchCard.setUp")}
          </button>
        </div>
      )}
    </div>
  );
}
