import { useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";

/**
 * One log line plus a stable, monotonically-increasing id minted at the push
 * site. The id (never the array index) is the React key, so when the caller caps
 * the list with `.slice(-500)` only the trimmed head's nodes drop — the surviving
 * lines keep their ids and React reuses their nodes instead of re-creating all.
 */
export type LogLine = { id: number; text: string };

/** How long the button shows its ✓ before returning to the copy glyph. */
const COPIED_MS = 1600;

/**
 * Read-only live log of a headless OpenVPN handshake. Tabtivity feeds the password
 * itself (no typing), so this is purely a progress view: it renders the lines
 * the backend forwards (`openvpn-progress`) and auto-scrolls to the newest so a
 * connect reads as live work rather than an opaque spinner. Shared by the
 * project dialog and the activation-time VPN password prompt.
 *
 * **It is the only copyable record of a failed connect.** The app sets
 * `user-select: none` globally (`styles/base.css`), so these lines were
 * unselectable — and this is exactly the surface whose text a user needs to hand
 * to someone else: OpenVPN's own failure line is the difference between "the VPN
 * didn't work" and a diagnosis. The xterm surfaces (a root-terminal tunnel, the
 * dialog's embedded login terminal) already copy on select; this one now opts
 * back into selection *and* carries a Copy button, because dragging a selection
 * through a 150px box that auto-scrolls under the cursor is not a way to get a
 * handshake log out. The button copies **every** line, not the visible ones.
 */
export function ConnectionLog({ lines, busy }: { lines: LogLine[]; busy: boolean }) {
  const t = useT();
  const endRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lines.length]);
  // Reset the ✓ on a timer owned by the effect, so a copy during an in-flight
  // one restarts the window instead of leaving a stale tick behind.
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(id);
  }, [copied]);
  const copy = () => {
    navigator.clipboard?.writeText(lines.map((l) => l.text).join("\n")).catch(() => {});
    setCopied(true);
  };
  return (
    <div className="connection-log-wrap">
      {lines.length > 0 && (
        <button
          type="button"
          className="connection-log-copy"
          onClick={copy}
          title={t(copied ? "connLog.copied" : "connLog.copy")}
          aria-label={t(copied ? "connLog.copied" : "connLog.copy")}
        >
          {copied ? "✓" : "⧉"}
        </button>
      )}
      <div className="connection-log" role="log" aria-label={t("connLog.ariaLabel")}>
        {lines.length === 0 && busy ? (
          <div className="connection-log-line connection-log-waiting">
            {t("connLog.startingVpn")}
          </div>
        ) : (
          lines.map((line) => (
            <div key={line.id} className="connection-log-line">
              {line.text}
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
