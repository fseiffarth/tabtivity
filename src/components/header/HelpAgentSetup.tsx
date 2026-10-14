import { useState } from "react";
import { useModalFocus } from "../../hooks/useModalFocus";
import { useT, type TranslationKey } from "../../lib/i18n";
import { Dropdown } from "../common/Dropdown";
import { UntestedTag } from "../common/UntestedTag";
import { SettingsHeader } from "../layout/settingsUi";
import { AgentsPage } from "../layout/intro/AgentsPage";
import { LocalModelsPage } from "../layout/intro/LocalModelsPage";
import { openHelpAgent } from "./helpAgent";

/** The two ways to get an agent: a cloud agent CLI, or a local model. */
export type HelpSetupPage = "cloud" | "local";

const PAGES: { id: HelpSetupPage; titleKey: TranslationKey; leadKey: TranslationKey }[] = [
  { id: "cloud", titleKey: "helpAgent.setup.cloudTitle", leadKey: "helpAgent.setup.cloudLead" },
  { id: "local", titleKey: "helpAgent.setup.localTitle", leadKey: "helpAgent.setup.localLead" },
];

/**
 * What the header's ? shows when there is no agent to open: how to install
 * one, both ways — a cloud agent CLI that signs in to its provider on the web
 * (the intro's Agent CLIs page), or a local model run by Ollama on this
 * machine (the intro's Local models page). Those pages ARE the install flows —
 * one click opens a terminal tab with the registry's own command, and they
 * call `onClose` to step aside so it is in view — so they are mounted here
 * as they are rather than copied.
 *
 * Chrome is the intro wizard's (`.settings-dialog.intro-dialog`, which sets the
 * explicit colour a portaled dialog needs): its rail holds the two ways, its
 * footer the way back — "Ask the help agent" re-runs the button once
 * something is installed.
 */
export function HelpAgentSetup({
  initialPage,
  onClose,
}: {
  initialPage: HelpSetupPage;
  onClose: () => void;
}) {
  const t = useT();
  const [page, setPage] = useState<HelpSetupPage>(initialPage);
  const [retry, setRetry] = useState<"idle" | "busy" | "none" | "localFailed">(
    initialPage === "local" ? "localFailed" : "idle",
  );
  const modalRef = useModalFocus(onClose);
  const current = PAGES.find((p) => p.id === page) ?? PAGES[0];

  const askAgain = () => {
    setRetry("busy");
    void openHelpAgent(t)
      .then((outcome) => {
        if (outcome === "opened") onClose();
        else setRetry(outcome);
      })
      .catch(() => setRetry("none"));
  };

  return (
    <div
      className="modal-backdrop how-to-start-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={modalRef}
        tabIndex={-1}
        className="settings-dialog settings-with-navigation intro-dialog help-agent-setup"
        role="dialog"
        aria-modal="true"
        aria-label={t("helpAgent.setup.title")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <nav className="settings-navigation intro-rail" aria-label={t("helpAgent.setup.waysLabel")}>
          <div className="settings-navigation-compact">
            <Dropdown
              ariaLabel={t("helpAgent.setup.waysLabel")}
              title={t("helpAgent.setup.waysLabel")}
              value={page}
              options={PAGES.map((p) => ({ value: p.id, label: t(p.titleKey) }))}
              onChange={(v) => setPage(v as HelpSetupPage)}
            />
          </div>
          <div className="settings-navigation-links">
            <div
              className="settings-navigation-group"
              role="group"
              aria-label={t("helpAgent.setup.waysLabel")}
            >
              <div className="settings-navigation-group-title">{t("helpAgent.setup.waysLabel")}</div>
              {PAGES.map((p, i) => (
                <button
                  key={p.id}
                  type="button"
                  className="settings-btn"
                  aria-current={p.id === page ? "step" : undefined}
                  onClick={() => setPage(p.id)}
                >
                  <span className="intro-rail-entry">
                    <span className="how-to-start-num" aria-hidden="true">
                      {i + 1}
                    </span>
                    {t(p.titleKey)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </nav>

        <div className="settings-panel-content">
          <SettingsHeader
            title={
              <>
                {t("helpAgent.setup.title")} <UntestedTag id="desktop.helpAgent" />
              </>
            }
            onClose={onClose}
          />
          <div className="dialog-scroll" key={page}>
            <p className="settings-help">{t("helpAgent.setup.lead")}</p>
            <div className="how-to-start-step-title">{t(current.titleKey)}</div>
            <p className="settings-help">{t(current.leadKey)}</p>
            {page === "cloud" ? <AgentsPage onClose={onClose} /> : <LocalModelsPage onClose={onClose} />}
          </div>
          <div className="dialog-fixed-footer settings-link-row intro-footer">
            <span className="settings-help intro-progress" role="status">
              {retry === "none"
                ? t("helpAgent.setup.stillNone")
                : retry === "localFailed"
                  ? t("helpAgent.setup.localFailed")
                  : ""}
            </span>
            <button type="button" className="settings-btn intro-skip" onClick={onClose}>
              {t("common.close")}
            </button>
            <button
              type="button"
              className="settings-btn primary"
              disabled={retry === "busy"}
              onClick={askAgain}
            >
              {t("helpAgent.setup.askAgain")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
