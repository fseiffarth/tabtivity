import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ToggleRow } from "../layout/settingsUi";
import { UntestedTag } from "../common/UntestedTag";
import { useT } from "../../lib/i18n";
import { AGENT_ITEMS, buildSignInTabSpec } from "../../lib/tabs/newTabItems";
import { openTabInRootConsole } from "../../stores/rootOverlay";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { AgentsHelp, AgentsStatus } from "./agentsUi";

/** `claude_token_status` (`services::claude_token`). Never carries the token. */
interface ClaudeTokenStatus {
  saved: boolean;
  /** New local Claude tabs run on it now: no shared Claude login. */
  inUse: boolean;
  /** Saves since the backend started: a new token replacing an old one. */
  revision: number;
}

/** How long a Generate click keeps re-reading the status. */
const WAIT_MS = 15 * 60 * 1000;
const POLL_MS = 3000;

/** Every mounted row's refresh: the row sits in the Accounts & keys group and
 *  in Claude's card, so a save, removal or toggle in one re-reads the other. */
const mounted = new Set<() => void>();
const refreshAll = () => mounted.forEach((f) => f());

/** Claude's long-lived token (`claude setup-token`): generated in a tab whose
 *  screen the backend reads the token from, or pasted; the fallback login of
 *  every Claude tab while no shared login holds one, remote hosts included.
 *  `heading={false}` drops the title line, for a host that shows the title
 *  itself (the fold in Claude's card); the help then shows as a line. */
export function ClaudeTokenRow({ heading = true }: { heading?: boolean }) {
  const t = useT();
  const [status, setStatus] = useState<ClaudeTokenStatus | null>(null);
  // The backend's default is on (`Settings::claude_token_remote`).
  const remote = useSettingsStore((s) => s.settings?.claude_token_remote ?? true);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /** The revision a Generate click waits to see change, while it waits. */
  const [waitingFrom, setWaitingFrom] = useState<number | null>(null);

  const refresh = () =>
    invoke<ClaudeTokenStatus>("claude_token_status")
      .then((s) => {
        setStatus(s);
        return s;
      })
      .catch(() => {
        setStatus(null);
        return null;
      });
  useEffect(() => {
    const reread = () => void refresh();
    mounted.add(reread);
    reread();
    return () => {
      mounted.delete(reread);
    };
  }, []);

  useEffect(() => {
    if (waitingFrom === null) return;
    const started = Date.now();
    const id = window.setInterval(() => {
      if (Date.now() - started > WAIT_MS) {
        setWaitingFrom(null);
        return;
      }
      void refresh().then((s) => {
        if (s && s.saved && s.revision !== waitingFrom) {
          setWaitingFrom(null);
          setNote(t("settings.claudeTokenSaved"));
          refreshAll();
        }
      });
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [waitingFrom, t]);

  const generate = () => {
    const item = AGENT_ITEMS.find((a) => a.cmd === "claude");
    if (!item) return;
    setNote(null);
    setWaitingFrom(status?.revision ?? 0);
    const cwd = useProjectsStore.getState().rootDir ?? "";
    openTabInRootConsole({
      ...buildSignInTabSpec(item, { args: ["setup-token"], exits: true }, cwd, t),
      label: t("settings.claudeTokenTabLabel"),
      location: "local",
    });
  };

  const run = (cmd: "claude_token_save" | "claude_token_clear", args?: Record<string, unknown>) => {
    setNote(null);
    setBusy(true);
    invoke(cmd, args)
      .then(() => {
        if (cmd === "claude_token_save") {
          setDraft("");
          setNote(t("settings.claudeTokenSaved"));
        }
      })
      .catch((e: unknown) => setNote(String(e)))
      .finally(() => {
        setBusy(false);
        refreshAll();
      });
  };

  if (!status) return null;
  const state = !status.saved
    ? t("settings.claudeTokenNone")
    : status.inUse
      ? t("settings.claudeTokenInUse")
      : t("settings.claudeTokenStandby");

  return (
    <div className="agents-block">
      {heading && (
        <div className="settings-subheader">
          {t("settings.claudeToken")} <UntestedTag id="settings.claudeToken" />
          <AgentsHelp text={t("settings.claudeTokenHelp")} />
        </div>
      )}
      <div className="agents-row">
        <div className="agents-row-main">
          <AgentsStatus tone={status.saved ? "ok" : "off"}>{state}</AgentsStatus>
        </div>
        <div className="agents-actions">
          <button type="button" className="settings-btn sm" disabled={busy} onClick={generate}>
            {t("settings.claudeTokenGenerate")}
          </button>
          {status.saved && (
            <button
              type="button"
              className="settings-btn sm danger"
              disabled={busy}
              onClick={() => run("claude_token_clear")}
            >
              {t("settings.claudeTokenRemove")}
            </button>
          )}
        </div>
      </div>
      <div className="agents-row agents-key-row">
        <div className="agents-row-main">
          <input
            className="agents-input"
            type="password"
            value={draft}
            autoComplete="off"
            spellCheck={false}
            placeholder={t("settings.claudeTokenPaste")}
            aria-label={t("settings.claudeTokenPaste")}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && draft.trim()) run("claude_token_save", { token: draft });
            }}
          />
        </div>
        <div className="agents-actions">
          <button
            type="button"
            className="settings-btn sm primary"
            disabled={busy || !draft.trim()}
            onClick={() => run("claude_token_save", { token: draft })}
          >
            {t("settings.claudeTokenSave")}
          </button>
        </div>
      </div>
      <div className="agents-option">
        <ToggleRow
          label={<>{t("settings.claudeTokenRemote")} <UntestedTag id="settings.claudeTokenRemote" /></>}
          checked={remote}
          onChange={(e) => void useSettingsStore.getState().updateSettings({ claude_token_remote: e.target.checked })}
        />
        <p className="settings-help">{t("settings.claudeTokenRemoteHelp")}</p>
      </div>
      {!heading && <p className="settings-help">{t("settings.claudeTokenHelp")}</p>}
      {waitingFrom !== null && <p className="settings-help">{t("settings.claudeTokenWaiting")}</p>}
      {note && <p className="settings-help">{note}</p>}
    </div>
  );
}
