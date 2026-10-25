import { useEffect, useRef, useState, type ReactNode } from "react";

import { isAiOffRefusal } from "../../lib/aiSwitch";
import { ASSISTANT_DEFAULT_MODEL, ASSISTANT_SCOPE, assistantModelRows, assistantNewChat, type AssistantModelRow } from "../../lib/assistant";
import { useT } from "../../lib/i18n";
import { useAssistantViewStore } from "../../stores/assistantView";
import {
  assistantTabs,
  ensureAssistantScopeHydrated,
  forgetAssistantChat,
  mountAssistantChat,
  startAssistantChat,
  switchAssistantModel,
} from "../../stores/assistantScope";
import { useOverlayAgentStore } from "../../stores/overlayAgent";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { Dropdown } from "../common/Dropdown";
import { UntestedTag } from "../common/UntestedTag";
import { AttachedAgentPane } from "../layout/AttachedAgentPane";
import { CliBlockCard, SearchSetupCard } from "./AssistantCards";
import { cliBlock, defaultCliOf, defaultModelOf, useAssistantOptions, type AssistantOptionsHandle } from "./useAssistantOptions";

/** A CLI and, for a local one, the model it drives. */
interface Launch {
  cli: string;
  model: string | null;
}

/**
 * **Tabby's side-panel view**: the panel's edge-rail icon (and its switcher's
 * button) opens it like Files or Git. Mounted by the side panel's
 * `ProjectFilesView` only while the panel is open on this view (and only with
 * the experimental switch on), so every effect below — the options poll
 * included — is visible-only.
 *
 * **One chat.** On top, the CLI it runs and its model as dropdowns and
 * Relaunch; below, the chat — an attach-only view of its tab
 * (`AttachedAgentPane` with `readerAlways`: the Reader is always on here, and
 * the agent's own terminal one toggle away). The PTY belongs to the tab's pane
 * in `CenterPanel`; closing the panel or switching views ends nothing.
 *
 * Opening the view shows the last chat, started again if its CLI is not
 * running (`startAssistantChat` resumes it); with none it starts one on the
 * default CLI at once. Picking another model restarts the same chat on it
 * (`switchAssistantModel`, the conversation resumed). Picking another CLI, or
 * Relaunch, starts a fresh chat and removes the one it replaces (every other chat of the scope with it, so
 * the scope holds the one chat shown here and on the phone).
 */
export function AssistantView() {
  const t = useT();
  const handle = useAssistantOptions(true);
  const { options } = handle;
  const stored = useSettingsStore((s) => s.settings?.assistant_settings);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    let alive = true;
    void ensureAssistantScopeHydrated().then((ok) => {
      if (alive) setHydrated(ok);
    });
    return () => {
      alive = false;
    };
  }, []);

  const chats = useTabsStore((s) => s.tabsByScope[ASSISTANT_SCOPE]);
  const selectedKey = useAssistantViewStore((s) => s.selectedKey);
  // The chat a jump named, else the newest (the scope holds them oldest first).
  const chat = chats?.find((c) => c.key === selectedKey) ?? chats?.[chats.length - 1];

  // A launch asked for and not made yet: the default on a first open, or the
  // dropdown's pick. It waits here while its CLI is blocked (the card says
  // why) and goes once the poll sees the block cleared.
  const [want, setWant] = useState<Launch | null>(null);
  const [busy, setBusy] = useState(false);
  /** A model switch of the shown chat is under way (the chat stays shown). */
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const defaultLaunch = (): Launch | null => {
    if (!options) return null;
    const cli = defaultCliOf(options, stored?.default_cli);
    if (!cli) return null;
    return { cli: cli.id, model: cli.local ? defaultModelOf(options, stored?.default_model) : null };
  };

  // Nothing to show: ask for a chat on the default CLI, once per open.
  const autoAsked = useRef(false);
  useEffect(() => {
    if (!hydrated || !options || chat || autoAsked.current) return;
    autoAsked.current = true;
    setWant(defaultLaunch());
    // `defaultLaunch` reads the same `options`/`stored` this render does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, options, chat]);

  // Showing a chat is what starts its CLI.
  const chatKey = chat?.key;
  useEffect(() => {
    if (chatKey) startAssistantChat(chatKey);
  }, [chatKey]);

  const wantCli = want ? options?.clis.find((c) => c.id === want.cli) : undefined;
  const wantBlock = wantCli && options ? cliBlock(wantCli, options) : null;

  /** Start a chat on `launch`, show it, and remove every other chat. */
  const launch = async (next: Launch) => {
    setBusy(true);
    setError(null);
    try {
      // The scope first: a created tab arriving at an unhydrated scope is only
      // picked up by the hydrate (the restored chats would then be missed).
      await ensureAssistantScopeHydrated();
      const made = await assistantNewChat(next.cli, next.model);
      const tab = await mountAssistantChat(made.tabId);
      if (!tab) {
        setError(t("assistant.newChat.vanished"));
        return;
      }
      useAssistantViewStore.getState().select(tab.key);
      for (const old of assistantTabs().filter((c) => c.key !== tab.key)) deleteChat(old);
    } catch (err) {
      setError(isAiOffRefusal(err)
        ? t("sidePanel.aiOffHint")
        : t("assistant.newChat.failed", { reason: String(err).replace(/^Error: /, "") }));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!want || busy || !wantCli || wantBlock !== null || (wantCli.local && !want.model)) return;
    setWant(null);
    void launch(want);
    // `launch` is a fresh closure each render; `want` is what triggers it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [want, busy, wantCli, wantBlock]);

  const current: Launch | null = want
    ?? (chat?.assistant ? { cli: chat.assistant.cli, model: chat.assistant.model ?? null } : null)
    ?? defaultLaunch();
  const currentCli = current ? options?.clis.find((c) => c.id === current.cli) : undefined;
  // Read again only when what they come from changes, not at every options poll.
  const [modelChoices, setModelChoices] = useState<AssistantModelRow[]>([]);
  const rowsFrom = useRef({ currentCli, options });
  rowsFrom.current = { currentCli, options };
  const rowsKey = currentCli && options
    ? JSON.stringify([currentCli.id, currentCli.local ? options.localModels : currentCli.models ?? []])
    : "";
  useEffect(() => {
    let live = true;
    setModelChoices([]);
    const { currentCli: cli, options: from } = rowsFrom.current;
    if (cli && from) void assistantModelRows(cli, from).then((rows) => { if (live) setModelChoices(rows); });
    return () => { live = false; };
  }, [rowsKey]);
  const shownModel = current?.model ?? (current?.cli === "claude" ? ASSISTANT_DEFAULT_MODEL : "");

  const pick = (next: Launch) => {
    setError(null);
    const same = chat?.assistant && chat.assistant.cli === next.cli && (chat.assistant.model ?? null) === next.model;
    setWant(same ? null : next);
  };
  const pickCli = (id: string) => {
    const cli = options?.clis.find((c) => c.id === id);
    if (!cli || !options) return;
    const model = cli.local ? (current?.model && options.localModels.includes(current.model) ? current.model : defaultModelOf(options, stored?.default_model)) : null;
    pick({ cli: id, model });
  };
  /** A model for the shown chat's own CLI switches that chat in place (the
   *  conversation carries on); with no chat, or a CLI pick pending, it is part
   *  of the launch asked for. */
  const pickModel = (model: string) => {
    if (!current) return;
    if (!want && chat?.assistant?.cli === current.cli) {
      setError(null);
      setSwitching(true);
      void switchAssistantModel(chat.key, model).finally(() => setSwitching(false));
      return;
    }
    pick({ cli: current.cli, model: model === ASSISTANT_DEFAULT_MODEL && !currentCli?.local ? null : model });
  };
  const relaunch = () => {
    if (!chat?.assistant || busy) return;
    setWant(null);
    void launch({ cli: chat.assistant.cli, model: chat.assistant.model ?? null });
  };

  let body: ReactNode = null;
  if (!hydrated || (!options && !handle.error)) {
    body = <p className="settings-help assistant-main-note">{t("assistant.loading")}</p>;
  } else if (!options) {
    body = <p className="settings-help assistant-main-note">{t("assistant.optionsFailed", { reason: handle.error ?? "" })}</p>;
  } else if (want && wantCli && wantBlock) {
    body = (
      <div className="assistant-start">
        <p className="settings-help">{t("assistant.newChat.intro")}</p>
        <CliBlockCard block={wantBlock} cli={wantCli} onRecheck={() => void handle.refresh()} />
      </div>
    );
  } else if (busy || want) {
    body = <p className="settings-help assistant-main-note">{t("assistant.newChat.starting")}</p>;
  } else if (error || !chat) {
    body = (
      <div className="assistant-start">
        <p className="settings-help">{t("assistant.newChat.intro")}</p>
        {error && <p className="project-dialog-error" role="alert">{error}</p>}
        <div className="settings-link-row">
          <button type="button" className="settings-btn primary" onClick={() => current && pick(current)} disabled={!current}>
            {t("assistant.newChat.start")}
          </button>
        </div>
      </div>
    );
  } else {
    body = <ChatView chat={chat} handle={handle} />;
  }

  return (
    <div className="assistant-view" aria-label={t("assistant.title")}>
      <div className="assistant-head">
        <Dropdown
          className="assistant-head-pick"
          value={current?.cli ?? ""}
          ariaLabel={t("assistant.newChat.cli")}
          title={t("assistant.newChat.cli")}
          options={options?.clis.map((c) => ({ value: c.id, label: c.label })) ?? []}
          placeholder={t("assistant.loading")}
          disabled={!options || busy || switching}
          onChange={pickCli}
        />
        {currentCli && (currentCli.local || modelChoices.length > 0) && (
          <Dropdown
            className="assistant-head-pick"
            value={shownModel}
            ariaLabel={t(currentCli.local ? "assistant.newChat.model" : "assistant.newChat.cloudModel")}
            title={t(currentCli.local ? "assistant.newChat.model" : "assistant.newChat.cloudModel")}
            options={modelChoices.map((row) => ({ value: row.id, label: row.label }))}
            placeholder={t(currentCli.local ? "assistant.newChat.noModel" : "assistant.newChat.defaultModel")}
            disabled={modelChoices.length === 0 || busy || switching}
            onChange={pickModel}
          />
        )}
        <button
          type="button"
          className="settings-btn sm assistant-relaunch"
          title={t("assistant.relaunchHint")}
          disabled={!chat || busy || switching || !!want}
          onClick={relaunch}
        >
          {t("assistant.relaunch")}
        </button>
        <UntestedTag id="assistant.view" />
      </div>
      <section className="assistant-chat-main">{body}</section>
    </div>
  );
}

/** Like closing any tab: the pane unmounts and its PTY is reaped. The persist
 *  host saves the shorter list. */
function deleteChat(chat: TabEntry) {
  useAssistantViewStore.getState().forget(chat.key);
  forgetAssistantChat(chat.key);
  useTabsStore.getState().removeTabInScope(ASSISTANT_SCOPE, chat.key);
}

/** One chat: the cards its CLI may need above, the attach-only view below. */
function ChatView({ chat, handle }: { chat: TabEntry; handle: AssistantOptionsHandle }) {
  const { options, refresh } = handle;
  const t = useT();
  const started = useOverlayAgentStore((s) => s.assistantStartedKeys.has(chat.key));
  const ended = useOverlayAgentStore((s) => s.assistantEndedKeys.has(chat.key));
  const rootConsoleOpen = useRootOverlayStore((s) => s.open);
  const cli = options?.clis.find((c) => c.id === chat.assistant?.cli);
  const block = options && cli ? cliBlock(cli, options) : null;

  // The agent has the keyboard when the chat opens and after a press inside it;
  // a press anywhere else (the workspace, the rest of the panel) takes it back
  // (the docked column's rule).
  const bodyRef = useRef<HTMLDivElement>(null);
  const [inside, setInside] = useState(true);
  useEffect(() => {
    setInside(true);
  }, [chat.key]);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      setInside(!!bodyRef.current && e.target instanceof Node && bodyRef.current.contains(e.target));
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, []);

  return (
    <div className="assistant-chat">
      {cli && block && (
        <div className="assistant-chat-notes">
          <CliBlockCard block={block} cli={cli} onRecheck={() => void refresh()} />
        </div>
      )}
      {options && cli?.local && !block && (
        <div className="assistant-chat-notes">
          <SearchSetupCard options={options} compact onSaved={() => void refresh()} />
        </div>
      )}
      {started && ended && (
        <div className="assistant-chat-notes">
          <div className="settings-card assistant-card" role="status">
            <p className="settings-help">{t("assistant.chatEnded")}</p>
            <div className="settings-link-row">
              <button type="button" className="settings-btn sm primary" onClick={() => startAssistantChat(chat.key)}>
                {t("assistant.restartChat")}
              </button>
            </div>
          </div>
        </div>
      )}
      <div ref={bodyRef} className="assistant-chat-body">
        {started && (
          <AttachedAgentPane
            scope={ASSISTANT_SCOPE}
            tab={chat}
            focused={inside && !rootConsoleOpen}
            readerAlways
          />
        )}
      </div>
    </div>
  );
}
