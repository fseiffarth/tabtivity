import { ConfirmDialog } from "../common/PromptDialogs";
import { UntestedTag } from "../common/UntestedTag";
import { useSettingsStore } from "../../stores/settings";
import { MOBILE_HOST_KEY } from "../../lib/brand";
import { useT } from "../../lib/i18n";

/**
 * The one-time launch question: should the Mobile host keep running after the
 * window quits (`stay_after_quit`, the headless owner), so the phone,
 * scheduled prompts and reminders go on with no window?
 *
 * Asked once, at the first launch with Mobile on (`AppShell` checks the
 * conditions and marks `stay_after_quit_prompted` before mounting this); without
 * Mobile the switch does nothing, so nobody is asked. "Yes" turns the switch on;
 * "No", Escape and the backdrop leave it off. Either way it can be changed later
 * from the header phone menu or Settings → Mobile.
 */
export function StayAfterQuitPrompt({ onClose }: { onClose: () => void }) {
  const t = useT();

  const answer = (yes: boolean) => {
    onClose();
    if (!yes) return;
    // Read at the click, not at mount: the block may have changed meanwhile,
    // and this write must carry every key it keeps.
    const { settings, updateSettings } = useSettingsStore.getState();
    const host = settings?.[MOBILE_HOST_KEY];
    if (!host) return;
    updateSettings({ [MOBILE_HOST_KEY]: { ...host, stay_after_quit: true } }).catch((reason) =>
      console.error("stay-after-quit: save failed", reason),
    );
  };

  return (
    <ConfirmDialog
      title={<>{t("mobile.stayAfterQuitAskTitle")} <UntestedTag id="mobile.stayAfterQuitAsk" /></>}
      body={t("mobile.stayAfterQuitAskBody")}
      confirmLabel={t("mobile.stayAfterQuitAskYes")}
      cancelLabel={t("mobile.stayAfterQuitAskNo")}
      onCancel={() => answer(false)}
      onConfirm={() => answer(true)}
    />
  );
}
