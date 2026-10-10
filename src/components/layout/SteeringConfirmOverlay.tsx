import { useEffect, useState } from "react";
import { DialogShell } from "../common/PromptDialogs";
import { UntestedTag } from "../common/UntestedTag";
import { useT } from "../../lib/i18n";
import { steeringRowKeys, type SteeringKeyMap } from "../../lib/shortcuts/steeringBindings";
import {
  STEERING_CONFIRM_EVENT,
  runSteeringConfirm,
  type SteeringConfirmDetail,
} from "../../lib/shortcuts/steeringConfirm";
import { useSettingsStore } from "../../stores/settings";

type Open = Omit<SteeringConfirmDetail, "handled">;

/**
 * Steering's "are you sure" before W closes a tab or K clears an agent's
 * conversation (`steeringConfirm`). Steering stays on and walks the box as the
 * overlay region: the Confirm key (Y) says yes, Esc no, Enter presses the
 * button under the cursor — Cancel to start with, so a stray Enter keeps the
 * tab. Mounted once in `AppShell`; opened by `STEERING_CONFIRM_EVENT`.
 */
export function SteeringConfirmOverlay() {
  const t = useT();
  const steerKeys = useSettingsStore((s) => s.settings?.steering_keys) as SteeringKeyMap | undefined;
  const [open, setOpen] = useState<Open | null>(null);

  useEffect(() => {
    const onRequest = (e: Event) => {
      const detail = (e as CustomEvent<SteeringConfirmDetail>).detail;
      detail.handled = true;
      setOpen({ kind: detail.kind, scope: detail.scope, tab: detail.tab });
    };
    window.addEventListener(STEERING_CONFIRM_EVENT, onRequest);
    return () => window.removeEventListener(STEERING_CONFIRM_EVENT, onRequest);
  }, []);

  if (!open) return null;
  const close = open.kind === "closeTab";
  const confirm = () => {
    setOpen(null);
    runSteeringConfirm(open);
  };
  const confirmLabel = t(close ? "steering.confirm.closeButton" : "steering.confirm.clearButton");
  const keys = steeringRowKeys(["confirm"], steerKeys);
  return (
    <DialogShell onDismiss={() => setOpen(null)}>
      <h2>
        {t(close ? "steering.confirm.closeTitle" : "steering.confirm.clearTitle", { tab: open.tab.label })}
        <UntestedTag id="steering.confirm" />
      </h2>
      <p className="file-delete-body">{t(close ? "steering.confirm.closeBody" : "steering.confirm.clearBody")}</p>
      <div className="file-delete-actions">
        <span className="steering-prompt-hint">
          {keys !== "—" && (
            <span><kbd>{keys}</kbd> {confirmLabel}</span>
          )}
          <span><kbd>{t("steering.prompt.keyEsc")}</kbd> {t("common.cancel")}</span>
        </span>
        <button type="button" autoFocus onClick={() => setOpen(null)}>
          {t("common.cancel")}
        </button>
        {/* STEERING_CONFIRM_ATTR: what the Confirm key presses. */}
        <button type="button" className="danger" data-steering-confirm="" onClick={confirm}>
          {confirmLabel}
        </button>
      </div>
    </DialogShell>
  );
}
