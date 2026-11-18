import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import type { ChatLink } from "../terminal/chatLinks";

export function ChatLinksIndex({ links, open, onToggle, onOpen }: {
  links: readonly ChatLink[];
  open: boolean;
  onToggle: () => void;
  onOpen: (url: string) => void;
}) {
  const t = useT();
  return <nav className={open ? "open" : undefined} aria-label={t("mobile.chatLinks.region")}>
    <button type="button" className="subagent-index-toggle" aria-expanded={open} aria-controls="mobile-chat-links" onClick={onToggle}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-2 2m2 6a4 4 0 0 0-6 0l-4 4a4 4 0 0 0 6 6l2-2" /></svg>
      <span>{t("mobile.chatLinks.toggle", { count: links.length })}{isUntested("mobile.chat.linksIndex") && <em> · {t("mobile.focus.untested")}</em>}</span>
      <svg className={open ? "expanded" : ""} viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    {open && <ul id="mobile-chat-links" className="chat-link-index-list">
      {links.map((link) => <li key={link.url}>
        <button type="button" onClick={() => onOpen(link.url)}>
          {link.label && <span>{link.label}</span>}
          <bdi>{link.host}{link.rest}</bdi>
          <small>{t(link.from === "you" ? "mobile.sentIndex.fromYou" : "mobile.sentIndex.fromAgent")}</small>
        </button>
      </li>)}
    </ul>}
  </nav>;
}
