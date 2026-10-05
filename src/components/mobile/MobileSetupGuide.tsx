import { useEffect } from "react";
import { useSettingsStore } from "../../stores/settings";
import { SETTINGS_ANCHORS } from "../layout/settingsUi";
import { runInstallInTab } from "../../lib/installCommand";
import { UntestedTag } from "../common/UntestedTag";
import { translate, useI18nStore, useT } from "../../lib/i18n";
import { MOBILE_HOST_KEY } from "../../lib/brand";

/** `translate` at the live language, for the callbacks below (the component's
 *  `t` inside a `window.confirm` string would read a stale language). */
function tr(
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
): string {
  return translate(useI18nStore.getState().lang, key, params);
}

const DEFAULT_PORT = 8742;

/**
 * The setup instruction behind the header's phone icon while Tabtivity Mobile is
 * off — the one door into Mobile for someone who has never used it.
 *
 * The full guide lives in Mobile settings, which is exactly the problem it
 * solves: a feature nobody has switched on is a feature nobody goes looking for
 * in the settings scroll. The icon is therefore shown *before* setup too, and
 * clicking it opens this — the same six steps, in the order they are performed,
 * with the two that Tabtivity can do for the user (run the `tailscale serve`
 * command, land on the Mobile section of Settings) as buttons in their own step.
 *
 * Chrome is `HowToStart`'s down to the class names — `.modal-backdrop` +
 * `.settings-dialog` split-scroll frame, `.how-to-start-steps` — because it is
 * the same kind of object: a numbered, one-screen instruction. No new CSS.
 */
export function MobileSetupGuide({ onClose }: { onClose: () => void }) {
  const t = useT();
  const stored = useSettingsStore((s) => s.settings?.[MOBILE_HOST_KEY]);
  // The command has to name the port Tabtivity will actually listen on, so a user
  // who already changed it in Mobile settings is not told to publish 8742.
  const port = Number.isInteger(stored?.port) && (stored?.port ?? 0) >= 1024 && (stored?.port ?? 0) <= 65535
    ? (stored?.port as number)
    : DEFAULT_PORT;
  const command = `tailscale serve --bg http://127.0.0.1:${port}`;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Same one-click shape as Mobile settings' own button (and every other
  // install-via-command flow): the command runs in a root terminal the root
  // console floats over — so the guide steps aside for the terminal it opened.
  const setUpInTerminal = () => {
    if (!window.confirm(tr("mobile.setUpConfirm", { command }))) return;
    runInstallInTab(tr("mobile.guideSummary"), command, "default");
    onClose();
  };

  const openMobileSettings = () => {
    window.dispatchEvent(new CustomEvent("app:open-settings", {
      detail: { panel: "main", anchor: SETTINGS_ANCHORS.mobile },
    }));
    onClose();
  };

  return (
    <div className="modal-backdrop how-to-start-backdrop" onMouseDown={onClose}>
      <div
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("mobile.setupTitle")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>{t("mobile.setupTitle")} <UntestedTag id="mobile.setupTitle" /></h2>
          <button
            type="button"
            className="dialog-close-btn"
            aria-label={t("common.close")}
            onClick={onClose}
          >×</button>
        </div>
        <div className="dialog-scroll">
          <p className="settings-help">{t("mobile.setupIntro")}</p>

          <ol className="how-to-start-steps">
            <li className="how-to-start-step">
              <span className="how-to-start-num">1</span>
              <div>
                <div className="how-to-start-step-title">{t("mobile.setupStep1Title")}</div>
                <div className="settings-help">{t("mobile.setupStep1Body")}</div>
              </div>
            </li>
            <li className="how-to-start-step">
              <span className="how-to-start-num">2</span>
              <div>
                <div className="how-to-start-step-title">{t("mobile.setupStep2Title")}</div>
                <div className="settings-help">{t("mobile.setupStep2Body")}</div>
              </div>
            </li>
            <li className="how-to-start-step">
              <span className="how-to-start-num">3</span>
              <div>
                <div className="how-to-start-step-title">{t("mobile.setupStep3Title")}</div>
                <div className="settings-help">{t("mobile.setupStep3Body")}</div>
                <code className="mobile-settings-guide-command">{command}</code>
                <div className="settings-link-row">
                  <button type="button" className="settings-btn sm" onClick={setUpInTerminal}>
                    {t("mobile.setUpInTerminal")}
                  </button>
                  <span className="settings-help">{t("mobile.setUpInTerminalHelp")}</span>
                </div>
              </div>
            </li>
            <li className="how-to-start-step">
              <span className="how-to-start-num">4</span>
              <div>
                <div className="how-to-start-step-title">{t("mobile.setupStep4Title")}</div>
                <div className="settings-help">{t("mobile.setupStep4Body")}</div>
                <div className="settings-link-row">
                  <button type="button" className="settings-btn sm" onClick={openMobileSettings}>
                    {t("mobile.setupOpenSettings")}
                  </button>
                </div>
              </div>
            </li>
            <li className="how-to-start-step">
              <span className="how-to-start-num">5</span>
              <div>
                <div className="how-to-start-step-title">{t("mobile.setupStep5Title")}</div>
                <div className="settings-help">{t("mobile.setupStep5Body")}</div>
              </div>
            </li>
            <li className="how-to-start-step">
              <span className="how-to-start-num">6</span>
              <div>
                <div className="how-to-start-step-title">{t("mobile.setupStep6Title")}</div>
                <div className="settings-help">{t("mobile.setupStep6Body")}</div>
              </div>
            </li>
          </ol>

          <p className="settings-help">{t("mobile.guideOutro")}</p>

          <div className="settings-link-row">
            <a href="https://tailscale.com/docs/features/tailscale-serve" target="_blank" rel="noreferrer">
              {t("mobile.serveDocs")}
            </a>
            <button type="button" className="how-to-start-got-it" onClick={onClose}>
              {t("common.close")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
