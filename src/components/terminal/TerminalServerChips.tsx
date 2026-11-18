import { createPortal } from "react-dom";
import { useT, type TranslationKey } from "../../lib/i18n";
import type { ServerKind, ServerUrl } from "../../lib/terminal/serverUrls";
import { UntestedTag } from "../common/UntestedTag";
import { CloseIcon } from "../common/icons/Icon";

/**
 * The chips a terminal pane shows for the local servers its program printed
 * (`findServerUrls`): "JupyterLab · node042:8888 — Open · Copy link · ✕". Written
 * to look like, and sit beside, {@link TerminalSignInCard}: the same card class,
 * portaled into the pane's own container, and the pane's mouse handling skips
 * events from inside them (`SERVER_CHIPS_CLASS`).
 *
 * In a remote tab Open forwards the port first (the host asks, once, naming both
 * ends) and the chip then reads "→ 127.0.0.1:<port> · Stop". In a local tab it
 * opens the page as printed; there is nothing to forward.
 */
export const SERVER_CHIPS_CLASS = "terminal-server-chips";

/** The newest few servers; a screen full of old runs does not fill the pane. */
const MAX_CHIPS = 3;

const KIND_KEY: Record<ServerKind, TranslationKey> = {
  jupyter: "terminal.server.kind.jupyter",
  tensorboard: "terminal.server.kind.tensorboard",
  vite: "terminal.server.kind.vite",
  streamlit: "terminal.server.kind.streamlit",
  gradio: "terminal.server.kind.gradio",
  generic: "terminal.server.kind.generic",
};

export function TerminalServerChips({
  host,
  servers,
  forwardedLocalPort,
  onOpen,
  onCopy,
  onStop,
  onDismiss,
}: {
  host: HTMLElement;
  servers: ServerUrl[];
  /** The local port a forward of this server already holds, when it does. */
  forwardedLocalPort: (server: ServerUrl) => number | null;
  onOpen: (server: ServerUrl) => void;
  onCopy: (server: ServerUrl) => void;
  onStop: (server: ServerUrl) => void;
  onDismiss: (server: ServerUrl) => void;
}) {
  const t = useT();
  const shown = servers.slice(-MAX_CHIPS);
  if (shown.length === 0) return null;
  return createPortal(
    <div className={SERVER_CHIPS_CLASS}>
      {shown.map((server) => {
        const local = forwardedLocalPort(server);
        const address = `${server.host.includes(":") ? `[${server.host}]` : server.host}:${server.port}`;
        return (
          <div key={server.port} className="hint-bubble terminal-server-chip" role="status">
            <button
              type="button"
              className="hint-bubble-close"
              aria-label={t("terminal.server.dismiss")}
              title={t("terminal.server.dismiss")}
              onClick={() => onDismiss(server)}
            >
              <CloseIcon />
            </button>
            <div className="terminal-server-chip-name">
              {t(KIND_KEY[server.kind])} · {address} <UntestedTag id="terminal.serverChip" />
            </div>
            {local !== null && (
              <div className="terminal-server-chip-forward">{t("terminal.server.forwarded", { port: local })}</div>
            )}
            <div className="hint-bubble-actions">
              <button type="button" className="hint-bubble-got-it terminal-server-chip-open" onClick={() => onOpen(server)}>
                {t("terminal.server.open")}
              </button>
              <button type="button" className="hint-bubble-link" onClick={() => onCopy(server)}>
                {t("terminal.server.copy")}
              </button>
              {local !== null && (
                <button type="button" className="hint-bubble-link" onClick={() => onStop(server)}>
                  {t("terminal.server.stop")}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>,
    host,
  );
}
