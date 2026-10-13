import { useModalFocus } from "../../hooks/useModalFocus";
/**
 * The **per-account Mail AI (local)** settings, raised from the mail toolbar (or,
 * on creating a new account, from `MailPane`'s save handler).
 *
 * The `MailAiSettings` section, shown where it is actually *about* — beside the
 * encryption and keyring buttons the toolbar already carries — so turning an
 * account's local-model features on does not mean leaving mail. This supplies
 * only the dialog chrome; the section owns the toggles and writes the account.
 *
 * No experimental gate here: the only host of `MailPane` is the mail overlay,
 * which `mail_client` already gates, so a toolbar button is unreachable unless
 * the feature is on. The section still self-gates each toggle on the global
 * master switch and a resolvable loopback mail-role model.
 */
import { createPortal } from "react-dom";

import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { MailAiSettings } from "./MailAiSettings";
import type { MailAccount } from "../../types/mail";

export interface MailAiSettingsDialogProps {
  account: MailAccount;
  onClose: () => void;
}

export function MailAiSettingsDialog({ account, onClose }: MailAiSettingsDialogProps) {
  const t = useT();
  const modalRef = useModalFocus(onClose);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={modalRef}
        tabIndex={-1}
        className="settings-dialog mail-ai-dialog"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="settings-title-row">
          <h2>
            {t("mailAi.settingsTitle")} <UntestedTag id="mailAi.settingsTitle#2" />
          </h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="dialog-scroll">
          <MailAiSettings account={account} embedded />
        </div>
      </div>
    </div>,
    document.body,
  );
}
