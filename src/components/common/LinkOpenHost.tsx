import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTauriListener } from "../../hooks/useTauriListener";
import { useT } from "../../lib/i18n";
import { answerLinkAsk, externalAnchorUrl, openExternalUrl, useLinkAsks } from "../../lib/externalLinks";
import { ConfirmDialog } from "./PromptDialogs";
import { UntestedTag } from "./UntestedTag";

/** `services::nav_gate::OPEN_REQUEST_EVENT`. */
const NAV_GATE_OPEN_REQUEST = "nav-gate-open-request";

/**
 * The "Open this link?" dialog of every app window (`src/lib/externalLinks.ts`):
 * the exact address, its host standing out, and nothing opens until the user
 * presses Open link. Mounted once per window beside `<App />`.
 *
 * It also catches the two ways a link could leave without asking:
 *  - an `<a target="_blank">` (or a middle click) that no handler took — the
 *    Markdown viewers, the intro and settings pages' doc links;
 *  - a new-window request the backend's navigation gate refused and handed
 *    back (`window.open`, a link inside a sandboxed frame).
 */
export function LinkOpenHost() {
  const t = useT();
  const ask = useLinkAsks((s) => s.asks[0] ?? null);

  useEffect(() => {
    // Bubble phase, after the components: a handler that opened the link its
    // own way (and asked, or showed the address) has prevented the default.
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || (e.button !== 0 && e.button !== 1)) return;
      const anchor = (e.target as Element | null)?.closest?.("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const url = externalAnchorUrl(anchor, e.button === 1);
      if (!url) return;
      e.preventDefault();
      void openExternalUrl(url).catch(() => {});
    };
    window.addEventListener("click", onClick);
    window.addEventListener("auxclick", onClick);
    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("auxclick", onClick);
    };
  }, []);

  useTauriListener(
    () =>
      listen<string>(NAV_GATE_OPEN_REQUEST, (event) => {
        if (typeof event.payload === "string") void openExternalUrl(event.payload).catch(() => {});
      }),
    [],
  );

  if (!ask) return null;
  let host = ask.url;
  try {
    host = new URL(ask.url).host;
  } catch {
    // Shown as given.
  }
  return (
    <ConfirmDialog
      key={ask.id}
      title={
        <>
          {t("link.open.title")} <UntestedTag id="terminal.openLink.title" />
        </>
      }
      body={
        <>
          {ask.note ?? t("link.open.body")} <strong>{host}</strong>
          <code className="file-delete-path" style={{ display: "block", marginTop: 8, overflowWrap: "anywhere" }}>
            {ask.url}
          </code>
        </>
      }
      confirmLabel={t("link.open.confirm")}
      onCancel={() => answerLinkAsk(ask.id, false)}
      onConfirm={() => answerLinkAsk(ask.id, true)}
    />
  );
}
