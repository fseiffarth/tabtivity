import { useCallback } from "react";

import { useT } from "../../lib/i18n";
import { sideChatHolder, useReaderSideChatStore } from "../../stores/agents/readerSideChat";
import { UntestedTag } from "../common/UntestedTag";
import { ChevronLeftIcon } from "../common/icons/Icon";

/**
 * The side panel's cover while an agent tab's Reader is on Diffs or Data with
 * its chat switch on (`reader_side_chat`): the tab's name, ‹ Chat (back to the
 * tab's own Chat), and the slot the Reader moves its chat into. Drawn over the
 * panel's view, which stays mounted under it, so the panel is as it was once
 * the chat leaves. Nothing while no Reader holds the panel.
 */
export function ReaderSideChat() {
  const t = useT();
  const holder = useReaderSideChatStore(sideChatHolder);
  const slotRef = useCallback((el: HTMLDivElement | null) => {
    useReaderSideChatStore.getState().setSlot(el);
  }, []);
  if (!holder) return null;
  return (
    <section className="reader-side-chat" aria-label={t("terminal.reader.sideChatTitle", { tab: holder.label })}>
      <div className="reader-side-chat-head">
        <button
          type="button"
          className="btn-quiet reader-side-chat-back"
          onClick={holder.showChat}
          title={t("terminal.reader.sideChatBack")}
        >
          <ChevronLeftIcon /> {t("terminal.reader.sideChatBack")}
        </button>
        <span className="reader-side-chat-name" title={holder.label}>{holder.label}</span>
        <UntestedTag id="terminal.reader.sideChat" />
      </div>
      <div ref={slotRef} className="reader-side-chat-body" />
    </section>
  );
}
