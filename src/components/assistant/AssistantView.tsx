import { useEffect, useMemo, useRef, useState } from "react";

import { ASSISTANT_SCOPE } from "../../lib/assistant";
import { useT } from "../../lib/i18n";
import { useAssistantViewStore } from "../../stores/assistantView";
import { ensureAssistantScopeHydrated, forgetAssistantChat, startAssistantChat } from "../../stores/assistantScope";
import { useOverlayAgentStore } from "../../stores/overlayAgent";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { UntestedTag } from "../common/UntestedTag";
import { AttachedAgentPane } from "../layout/AttachedAgentPane";
import { CliBlockCard, SearchSetupCard } from "./AssistantCards";
import { AssistantNewChat } from "./AssistantNewChat";
import { cliBlock, useAssistantOptions, type AssistantOptionsHandle } from "./useAssistantOptions";

/**
 * **Tabby's side-panel view**: the panel's edge-rail icon (and its switcher's
 * button) opens it like Files or Git. Mounted by the side panel's
 * `ProjectFilesView` only while the panel is open on this view (and only with
 * the experimental switch on), so every effect below — the options poll
 * included — is visible-only.
 *
 * On top, New chat and the chats (the assistant scope's tabs, newest first)
 * with a delete per chat. Below, the chat shown — an attach-only view of its
 * tab (`AttachedAgentPane` with `readerAlways`: the Reader is always on here,
 * and the agent's own terminal one toggle away). The PTY belongs to the tab's
 * pane in `CenterPanel`; closing the panel or switching views ends nothing,
 * deleting a chat does.
 *
 * **Lazy spawn.** Hydrating the scope restores chats as records only. A chat's
 * CLI starts when the chat is first shown here (`startAssistantChat`), so
 * opening the view with many saved chats starts one CLI, not all of them.
 */
export function AssistantView() {
  const t = useT();
  const handle = useAssistantOptions(true);
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

  const stored = useTabsStore((s) => s.tabsByScope[ASSISTANT_SCOPE]);
  // Newest first; the scope holds them oldest first.
  const chats = useMemo(() => [...(stored ?? [])].reverse(), [stored]);
  const selectedKey = useAssistantViewStore((s) => s.selectedKey);
  const composing = useAssistantViewStore((s) => s.composing);
  const selected = chats.find((c) => c.key === selectedKey) ?? (composing ? undefined : chats[0]);
  const showForm = hydrated && (composing || chats.length === 0);

  // Showing a chat is what starts its CLI.
  const selectedChatKey = !showForm ? selected?.key : undefined;
  useEffect(() => {
    if (selectedChatKey) startAssistantChat(selectedChatKey);
  }, [selectedChatKey]);

  const deleteChat = (chat: TabEntry) => {
    useAssistantViewStore.getState().forget(chat.key);
    forgetAssistantChat(chat.key);
    // Like closing any tab: the pane unmounts and its PTY is reaped. The persist
    // host saves the shorter list.
    useTabsStore.getState().removeTabInScope(ASSISTANT_SCOPE, chat.key);
  };

  return (
    <div className="assistant-view" aria-label={t("assistant.title")}>
      <aside className="assistant-chat-list" aria-label={t("assistant.chats")}>
        <div className="assistant-chat-list-head">
          <button
            type="button"
            className="settings-btn sm primary assistant-new-chat-btn"
            onClick={() => useAssistantViewStore.getState().compose()}
          >
            + {t("assistant.newChat")}
          </button>
          <UntestedTag id="assistant.view" />
        </div>
        <div className="assistant-chat-rows" role="list">
          {chats.length === 0 && <p className="settings-help assistant-chat-empty">{t("assistant.noChats")}</p>}
          {chats.map((chat) => (
            <ChatRow
              key={chat.key}
              chat={chat}
              active={!showForm && selected?.key === chat.key}
              cliLabel={handle.options?.clis.find((c) => c.id === chat.assistant?.cli)?.label ?? chat.assistant?.cli ?? ""}
              onSelect={() => useAssistantViewStore.getState().select(chat.key)}
              onDelete={() => deleteChat(chat)}
            />
          ))}
        </div>
      </aside>
      <section className="assistant-chat-main">
        {!hydrated ? (
          <p className="settings-help assistant-main-note">{t("assistant.loading")}</p>
        ) : showForm ? (
          <AssistantNewChat
            handle={handle}
            onStarted={(key) => {
              startAssistantChat(key);
              useAssistantViewStore.getState().select(key);
            }}
          />
        ) : selected ? (
          <ChatView chat={selected} handle={handle} />
        ) : null}
      </section>
    </div>
  );
}

function ChatRow({
  chat,
  active,
  cliLabel,
  onSelect,
  onDelete,
}: {
  chat: TabEntry;
  active: boolean;
  cliLabel: string;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const sub = [cliLabel, chat.assistant?.model].filter(Boolean).join(" · ");
  return (
    <div role="listitem" className={`assistant-chat-row${active ? " active" : ""}`}>
      <button type="button" className="assistant-chat-select" aria-current={active || undefined} onClick={onSelect}>
        <span className="assistant-chat-label">{chat.label || t("assistant.chatFallback")}</span>
        {sub && <span className="assistant-chat-sub">{sub}</span>}
      </button>
      <button
        type="button"
        className="subwindow-hide assistant-chat-delete"
        title={t("assistant.deleteChat")}
        aria-label={t("assistant.deleteChat")}
        onClick={onDelete}
      >
        ×
      </button>
    </div>
  );
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
