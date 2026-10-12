import { useModalFocus } from "../../hooks/useModalFocus";
import { useHostKeyPromptStore } from "../../stores/remote/hostKeyPrompt";
import { UntestedTag } from "./UntestedTag";
import { useT } from "../../lib/i18n";

/**
 * First-contact host-key confirmation. Mounted once at the shell, like the VPN
 * password prompt.
 *
 * This is the moment `StrictHostKeyChecking=accept-new` otherwise passes over in
 * silence: a host nobody here has ever spoken to, about to be handed a password.
 * OpenSSH's own prompt at least shows the fingerprint; headless connects have no
 * terminal to show it in, so it is shown here instead.
 *
 * Accepting writes the shown keys to `~/.ssh/known_hosts` — the same thing
 * `accept-new` would have done, done deliberately — after which the connect that
 * raised this retries. Declining leaves the connect failed.
 */
export function HostKeyConfirmDialog() {
  const t = useT();
  const pending = useHostKeyPromptStore((s) => s.pending);
  const status = useHostKeyPromptStore((s) => s.status);
  const error = useHostKeyPromptStore((s) => s.error);
  const keys = useHostKeyPromptStore((s) => s.keys);
  const accept = useHostKeyPromptStore((s) => s.accept);
  const cancel = useHostKeyPromptStore((s) => s.cancel);

  // Escape answers nothing, like the backdrop (see below).
  const modalRef = useModalFocus(() => {}, !!pending);
  if (!pending) return null;
  const canAccept = status === "ready" && keys.length > 0;

  return (
    // No backdrop dismiss: the answer decides whether a password leaves this
    // machine, so it must be given, not clicked past.
    <div className="modal-backdrop">
      <div ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true" className="project-dialog host-key-dialog">
        <h2 className="host-key-title">
          {t("hostKey.title")} <UntestedTag id="hostKey.title" />
        </h2>
        <p className="host-key-lede">
          {t("hostKey.ledePre")} <strong>{pending.target}</strong> {t("hostKey.ledePost")}
        </p>

        {status === "loading" && <div className="host-key-status">{t("hostKey.readingKey")}</div>}

        {status === "error" && (
          <div className="host-key-status host-key-status-error">
            {t("hostKey.errorHeading")}
            <div className="host-key-error-detail">{error}</div>
          </div>
        )}

        {keys.length > 0 && (
          <ul className="host-key-list">
            {keys.map((k) => (
              <li key={k.fingerprint} className="host-key-row">
                <span className="host-key-type">
                  {k.keyType} {k.bits}
                </span>
                <code className="host-key-fp">{k.fingerprint}</code>
              </li>
            ))}
          </ul>
        )}

        {canAccept && (
          <p className="host-key-note">
            {t("hostKey.acceptNotePre")} <code>~/.ssh/known_hosts</code>{t("hostKey.acceptNotePost")}
          </p>
        )}

        <div className="project-dialog-actions">
          <button type="button" onClick={cancel}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="primary"
            disabled={!canAccept}
            onClick={() => void accept()}
          >
            {status === "trusting" ? t("hostKey.accepting") : t("hostKey.acceptAndConnect")}
          </button>
        </div>
      </div>
    </div>
  );
}
