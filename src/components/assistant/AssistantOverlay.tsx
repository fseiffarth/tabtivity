import { useEffect, useMemo, useRef, useState } from "react";

import { ASSISTANT_SCOPE } from "../../lib/assistant";
import { useExperimental } from "../../lib/experimental";
import { useT } from "../../lib/i18n";
import { storageKey } from "../../lib/brand";
import { useAssistantOverlayStore } from "../../stores/assistantOverlay";
import { ensureAssistantScopeHydrated, forgetAssistantChat, startAssistantChat } from "../../stores/assistantScope";
import { useOverlayAgentStore } from "../../stores/overlayAgent";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { UntestedTag } from "../common/UntestedTag";
import { useFloatingFrame } from "../common/useFloatingFrame";
import { AssistantGlyph } from "../header/HeaderGlyphs";
import { AttachedAgentPane } from "../layout/AttachedAgentPane";
import { CliBlockCard, SearchSetupCard } from "./AssistantCards";
import { AssistantNewChat } from "./AssistantNewChat";
import { cliBlock, useAssistantOptions, type AssistantOptionsHandle } from "./useAssistantOptions";

/**
 * The **Tabby overlay**: the header chat-bubble button's window, in the mail /
 * calendar / to-do overlays' chrome (`.root-overlay.subwindow`, moved and
 * resized by `useFloatingFrame`, its backdrop at the family's shared z-index so
 * the shell's mount order tie-breaks).
 *
 * Left, the chats (the assistant scope's tabs, newest first) with New chat and
 * a delete per chat. Right, the chat shown — an attach-only view of its tab
 * (`AttachedAgentPane` with `readerAlways`: the Reader is always on here, and
 * the agent's own terminal one toggle away). The PTY belongs to the tab's pane
 * in `CenterPanel`; closing the overlay ends nothing, deleting a chat does.
 *
 * **Lazy spawn.** Hydrating the scope restores chats as records only. A chat's
 * CLI starts when the chat is first shown here (`startAssistantChat`), so
 * opening the overlay with many saved chats starts one CLI, not all of them.
 *
 * Mounted at the shell only while open (and only with the experimental switch
 * on), so every effect below — the options poll included — is visible-only.
 */
export function AssistantOverlayHost() {
  const enabled = useExperimental("assistant");
  const open = useAssistantOverlayStore((s) => s.open);
  if (!enabled || !open) return null;
  return <AssistantOverlay />;
}

function AssistantOverlay() {
  const t = useT();
  const close = () => useAssistantOverlayStore.getState().close();
  const { frameRef, frameStyle, frameClass, barProps, grips, fillButton } =
    useFloatingFrame(storageKey("assistantOverlayFrame"));
  const { title: moveHint, ...barRest } = barProps;

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
  const selectedKey = useAssistantOverlayStore((s) => s.selectedKey);
  const composing = useAssistantOverlayStore((s) => s.composing);
  const selected = chats.find((c) => c.key === selectedKey) ?? (composing ? undefined : chats[0]);
  const showForm = hydrated && (composing || chats.length === 0);

  // Showing a chat is what starts its CLI.
  const selectedChatKey = !showForm ? selected?.key : undefined;
  useEffect(() => {
    if (selectedChatKey) startAssistantChat(selectedChatKey);
  }, [selectedChatKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // The root console opens above this overlay (a sign-in tab); its Escape
      // is its own. So is Escape typed into the chat: the agent's cancel key.
      if (useRootOverlayStore.getState().open) return;
      if ((e.target as Element | null)?.closest?.(".assistant-chat-main")) return;
      e.stopPropagation();
      useAssistantOverlayStore.getState().close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const deleteChat = (chat: TabEntry) => {
    useAssistantOverlayStore.getState().forget(chat.key);
    forgetAssistantChat(chat.key);
    // Like closing any tab: the pane unmounts and its PTY is reaped. The persist
    // host saves the shorter list.
    useTabsStore.getState().removeTabInScope(ASSISTANT_SCOPE, chat.key);
  };

  return (
    <div
      className="modal-backdrop root-overlay-backdrop app-overlay-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={frameRef}
        className={`root-overlay subwindow focused assistant-overlay ${frameClass}`}
        style={frameStyle}
        role="dialog"
        aria-modal="true"
        aria-label={t("assistant.overlayTitle")}
      >
        {grips}
        <div {...barRest} className={`tab-bar root-overlay-bar ${barRest.className}`}>
          <div className="root-overlay-mark app-overlay-mark" title={moveHint}>
            <AssistantGlyph className="assistant-overlay-glyph" />
            <span className="app-overlay-label">{t("assistant.overlayTitle")}</span>
            <UntestedTag id="assistant.overlay" />
          </div>
          <div className="tab-controls root-overlay-controls">
            {fillButton}
            <button
              type="button"
              className="subwindow-hide"
              title={t("common.close")}
              aria-label={t("common.close")}
              onClick={close}
            >
              ×
            </button>
          </div>
        </div>
        <div className="subwindow-body assistant-overlay-body">
          <aside className="assistant-chat-list" aria-label={t("assistant.chats")}>
            <div className="assistant-chat-list-head">
              <button
                type="button"
                className="settings-btn sm primary assistant-new-chat-btn"
                onClick={() => useAssistantOverlayStore.getState().compose()}
              >
                + {t("assistant.newChat")}
              </button>
            </div>
            <div className="assistant-chat-rows" role="list">
              {chats.length === 0 && <p className="settings-help assistant-chat-empty">{t("assistant.noChats")}</p>}
              {chats.map((chat) => (
                <ChatRow
                  key={chat.key}
                  chat={chat}
                  active={!showForm && selected?.key === chat.key}
                  cliLabel={handle.options?.clis.find((c) => c.id === chat.assistant?.cli)?.label ?? chat.assistant?.cli ?? ""}
                  onSelect={() => useAssistantOverlayStore.getState().select(chat.key)}
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
                  useAssistantOverlayStore.getState().select(key);
                }}
              />
            ) : selected ? (
              <ChatView chat={selected} handle={handle} />
            ) : null}
          </section>
        </div>
      </div>
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
  // a press anywhere else hands it back to the overlay (the docked column's rule).
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
