import { useModalFocus, isInActiveModal } from "../../hooks/useModalFocus";
import { UntestedTag } from "../common/UntestedTag";
import { Dropdown } from "../common/Dropdown";
import { useEffect, useState } from "react";
import { HOW_TO_START_STEPS, focusModeTip } from "../../lib/shortcuts/hints";
import { useT } from "../../lib/i18n";
import { PLATFORM } from "../../lib/platform";
import { probeSuperKeyOwnership } from "../../lib/shortcuts/superKey";
import { SettingsHeader } from "./settingsUi";
import {
  INTRO_PAGES,
  INTRO_PAGE_TITLE_KEYS,
  readIntroPage,
  writeIntroPage,
  type IntroPage,
} from "./intro/introData";
import { ProjectsPage } from "./intro/ProjectsPage";
import { AgentsPage } from "./intro/AgentsPage";
import { LocalModelsPage } from "./intro/LocalModelsPage";
import { AskAppPage } from "./intro/AskAppPage";

/**
 * The first-run intro: a paged wizard shown once on the first launch of an
 * empty install and re-openable from Settings / the gear menu. Welcome →
 * Projects → Agent CLIs → Local models → Ask Tabtivity → Done.
 *
 * Chrome is the Settings dialog's, down to the class names: `.settings-dialog
 * .settings-with-navigation` with the category rail on the left (the step rail
 * here, compacted to the shared dropdown on a narrow window), the split-scroll
 * `.dialog-scroll`, and a pinned `.dialog-fixed-footer` for Back / Skip / Next.
 * Only the current page is mounted, so each page's live probes run while it is
 * visible and stop when the user moves on. ←/→ page, Esc closes (shared modal
 * focus), and the page it was left on is remembered for the next open.
 */
export function HowToStart({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [page, setPage] = useState<IntroPage>(readIntroPage);
  const index = INTRO_PAGES.indexOf(page);
  const last = index === INTRO_PAGES.length - 1;
  const go = (next: IntroPage) => {
    setPage(next);
    writeIntroPage(next);
  };
  const step = (delta: number) => {
    const next = INTRO_PAGES[index + delta];
    if (next) go(next);
  };
  // Finishing (the Done page's primary) starts the next open from Welcome;
  // any other close keeps the page, so a user who stepped out to run an
  // installer comes back to the step they were on.
  const finish = () => {
    writeIntroPage("welcome");
    onClose();
  };
  // Closing on the Done page counts as finishing too.
  const close = () => (last ? finish() : onClose());
  const modalRef = useModalFocus(close);

  // ←/→ turn the page — unless a text field (the Ask box) or another modal
  // above this one has the keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], [role='listbox'], [role='menu']")) return;
      if (!modalRef.current || !isInActiveModal(modalRef.current)) return;
      e.preventDefault();
      step(e.key === "ArrowLeft" ? -1 : 1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const railOptions = INTRO_PAGES.map((p, i) => ({ value: p, label: `${i + 1}. ${t(INTRO_PAGE_TITLE_KEYS[p])}` }));

  return (
    <div className="modal-backdrop how-to-start-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div
        ref={modalRef}
        tabIndex={-1}
        className="settings-dialog settings-with-navigation how-to-start-dialog intro-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("howToStart.title")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <nav className="settings-navigation intro-rail" aria-label={t("intro.stepsLabel")}>
          <div className="settings-navigation-compact">
            <Dropdown
              ariaLabel={t("intro.stepsLabel")}
              title={t("intro.stepsLabel")}
              value={page}
              options={railOptions}
              onChange={(v) => go(v as IntroPage)}
            />
          </div>
          <div className="settings-navigation-links">
            <div className="settings-navigation-group" role="group" aria-label={t("intro.stepsLabel")}>
              <div className="settings-navigation-group-title">{t("intro.stepsLabel")}</div>
              {INTRO_PAGES.map((p, i) => (
                <button
                  key={p}
                  type="button"
                  className="settings-btn"
                  aria-current={p === page ? "step" : undefined}
                  onClick={() => go(p)}
                >
                  <span className="intro-rail-entry">
                    <span className="how-to-start-num" aria-hidden="true">{i + 1}</span>
                    {t(INTRO_PAGE_TITLE_KEYS[p])}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </nav>

        <div className="settings-panel-content">
          <SettingsHeader
            title={<>{t(page === "welcome" ? "howToStart.title" : INTRO_PAGE_TITLE_KEYS[page])} <UntestedTag id="desktop.welcome" /></>}
            onClose={close}
          />
          <div className="dialog-scroll" key={page}>
            {page === "welcome" && <WelcomePage />}
            {page === "projects" && <ProjectsPage onClose={onClose} />}
            {page === "agents" && <AgentsPage onClose={onClose} />}
            {page === "localModels" && <LocalModelsPage onClose={onClose} />}
            {page === "askApp" && <AskAppPage />}
            {page === "done" && <DonePage onClose={finish} />}
          </div>
          <div className="dialog-fixed-footer settings-link-row intro-footer">
            <button type="button" className="settings-btn" disabled={index === 0} onClick={() => step(-1)}>
              ‹ {t("common.back")}
            </button>
            <span className="settings-help intro-progress">
              {t("intro.progress", { n: index + 1, total: INTRO_PAGES.length })}
            </span>
            <UntestedTag id="desktop.intro.wizard" />
            {!last && (
              <button type="button" className="settings-btn intro-skip" onClick={onClose}>
                {t("intro.skip")}
              </button>
            )}
            {last ? (
              <button type="button" className="settings-btn primary how-to-start-got-it" onClick={finish}>
                {t("desktop.startWorking")}
              </button>
            ) : (
              <button type="button" autoFocus className="settings-btn primary how-to-start-got-it" onClick={() => step(1)}>
                {t("common.next")} ›
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Page 1: what Tabtivity is, and the four basics — `HOW_TO_START_STEPS`, the same
 *  copy the Feature Guide shows, so the two stay in lockstep. */
function WelcomePage() {
  const t = useT();
  // On Linux the panel key depends on the desktop (Super, or F9 where the shell
  // owns Super), and that answer is a backend probe. This dialog opens on the
  // fresh-install path, possibly before the probe `useKeyboard` fired has
  // landed — so the tip waits for the answer rather than naming Super to a
  // GNOME user and correcting itself a moment later.
  const [keyKnown, setKeyKnown] = useState(PLATFORM !== "linux");
  useEffect(() => {
    if (PLATFORM !== "linux") return;
    let live = true;
    void probeSuperKeyOwnership().then(() => {
      if (live) setKeyKnown(true);
    });
    return () => {
      live = false;
    };
  }, []);

  return (
    <>
      <p className="settings-help">{t("howToStart.intro")}</p>
      <ol className="how-to-start-steps">
        {HOW_TO_START_STEPS.map((step, i) => (
          <li key={step.titleKey} className="how-to-start-step">
            <span className="how-to-start-num">{i + 1}</span>
            <div>
              <div className="how-to-start-step-title">{t(step.titleKey)}</div>
              {/* Only step4's key has a {tip} placeholder; t() ignores unused params. */}
              <div className="settings-help">
                {t(step.bodyKey, { tip: keyKnown ? focusModeTip(t) : "" })}
              </div>
            </div>
          </li>
        ))}
      </ol>
      <p className="settings-help">{t("intro.welcome.next")}</p>
    </>
  );
}

/** Last page: where to go from here — the Feature Guide, the tour, the lessons. */
function DonePage({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <>
      <p className="settings-help">{t("intro.done.lead")}</p>
      <h3 className="project-form-heading">{t("desktop.learnMore")}</h3>
      <div className="settings-link-row">
        <button
          type="button"
          onClick={() => {
            window.dispatchEvent(new CustomEvent("app:open-settings", { detail: "help" }));
            onClose();
          }}
        >
          {t("howToStart.openFeatureGuide")}
        </button>
        <button
          type="button"
          onClick={() => {
            onClose();
            window.dispatchEvent(new Event("app:start-tour"));
          }}
        >
          {t("howToStart.takeTour")}
        </button>
        <button
          type="button"
          onClick={() => {
            onClose();
            window.dispatchEvent(new Event("app:open-lessons"));
          }}
        >
          {t("howToStart.lessons")}
        </button>
      </div>
      <p className="settings-help">{t("intro.done.reopen")}</p>
    </>
  );
}
