import { useCallback, useMemo, useRef, useState } from "react";
import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { chatLinkUrl } from "../terminal/answerMarkdown";
import { HOLD_MS } from "./MessageMenu";

/**
 * The question a tapped chat link asks before anything opens: the agent wrote
 * the link, and an agent may have read anything, so its label is not trusted
 * to say where it goes. The sheet shows the address itself — the host on its
 * own line, in the ASCII form `chatLinkUrl` normalized it to — and opens it
 * only on Open, in a new browsing context that gets neither this page as its
 * opener nor its address as the referrer.
 */
function LinkSheet({ url, onClose }: { url: string; onClose: () => void }) {
  const t = useT();
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const host = new URL(url).host;
  const open = () => {
    // Checked again at the moment of opening: only what the sheet showed goes.
    const target = chatLinkUrl(url);
    onClose();
    if (target) window.open(target, "_blank", "noopener,noreferrer");
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setNote({ text: t("mobile.focus.copied") });
    } catch {
      setNote({ text: t("mobile.focus.copyFailed"), error: true });
    }
  };
  const title = t("mobile.link.title");
  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header>
        <button className="sheet-close" onClick={onClose} aria-label={t("mobile.focus.messageMenuClose")}>✕</button>
        <h2>{title} {isUntested("mobile.link.title") && <small>{t("mobile.focus.untested")}</small>}</h2>
        <span className="sheet-close" aria-hidden="true" />
      </header>
      <p className={note?.error ? "sheet-note error" : "sheet-note"} role={note ? "status" : undefined}>{note ? note.text : t("mobile.link.body")}</p>
      <div className="link-sheet-target">
        <strong>{host}</strong>
        <code data-testid="link-sheet-url">{url}</code>
      </div>
      <ul className="option-list">
        <li>
          <button onClick={open}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>
            <span><strong>{t("mobile.link.open")}</strong></span>
          </button>
        </li>
        <li>
          <button onClick={copy}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h8" /></svg>
            <span><strong>{t("mobile.link.copy")}</strong></span>
          </button>
        </li>
      </ul>
    </section>
  </div>;
}

/** What a formatted message spreads to make its links ask before opening. */
export interface LinkHandlers {
  onPointerDown: (event: React.PointerEvent) => void;
  onClick: (event: React.MouseEvent) => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
}

/**
 * Tappable links for a chat: `links` on every formatted message, `sheet` once
 * beside them. A tap on a link (`data-href`, set only for an address
 * `chatLinkUrl` accepts) opens `LinkSheet`; nothing opens without it. A press
 * held long enough to be the message menu's is that menu's, not a tap.
 */
export function useChatLinks(): { links: LinkHandlers; sheet: React.ReactNode } {
  const [url, setUrl] = useState<string | null>(null);
  const downAt = useRef(0);
  const ask = useCallback((target: EventTarget): boolean => {
    const link = target instanceof Element ? target.closest<HTMLElement>(".md-link[data-href]") : null;
    const href = chatLinkUrl(link?.dataset.href);
    if (!href) return false;
    setUrl(href);
    return true;
  }, []);
  const links = useMemo<LinkHandlers>(() => ({
    onPointerDown: (event) => { downAt.current = event.timeStamp; },
    onClick: (event) => {
      if (downAt.current && event.timeStamp - downAt.current >= HOLD_MS) return;
      if (ask(event.target)) event.stopPropagation();
    },
    onKeyDown: (event) => {
      if (event.key === "Enter" && ask(event.target)) event.preventDefault();
    },
  }), [ask]);
  const close = useCallback(() => setUrl(null), []);
  return { links, sheet: url && <LinkSheet url={url} onClose={close} /> };
}
