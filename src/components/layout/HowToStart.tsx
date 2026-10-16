import { useModalFocus, isInActiveModal } from "../../hooks/useModalFocus";
import { UntestedTag } from "../common/UntestedTag";
import { Typewriter } from "../common/Typewriter";
import { Dropdown } from "../common/Dropdown";
import { useEffect, useRef, useState } from "react";
import { HOW_TO_START_STEPS, focusModeTip } from "../../lib/shortcuts/hints";
import { useT } from "../../lib/i18n";
import { PLATFORM } from "../../lib/platform";
import { probeSuperKeyOwnership } from "../../lib/shortcuts/superKey";
import { SettingsHeader } from "./settingsUi";
import { LESSONS } from "../../lib/lessons";
import {
  INTRO_PAGE_TITLE_KEYS,
  firstRecommendedLesson,
  introRoute,
  readIntroGoals,
  readIntroPage,
  toggleGoal,
  writeIntroGoals,
  writeIntroPage,
  type IntroGoal,
  type IntroPage,
} from "./intro/introData";
import { startLessonById } from "./intro/introUi";
import { GoalsPage } from "./intro/GoalsPage";
import { ForYouPage } from "./intro/ForYouPage";
import { ProjectsPage } from "./intro/ProjectsPage";
import { AgentsPage } from "./intro/AgentsPage";
import { LocalModelsPage } from "./intro/LocalModelsPage";
import { AskAppPage } from "./intro/AskAppPage";

/**
 * The first-run intro: a paged wizard shown once on the first launch of an
 * empty install and re-openable from Settings / the gear menu. The route
 * adapts to the user: Welcome → Your goals (multi-select "what do you want to
 * do?") → only the setup pages those goals need (Projects, Agent CLIs, Local
 * models — `introRoute`) → For you (lessons matched to the goals) → Ask
 * Tabtivity → Done, which names the best first lesson for the answers. No goal
 * picked is the full tour. The answers are remembered (`readIntroGoals`) and
 * can be changed any time; the rail, the dropdown, "Step n of total" and
 * Back/Next all walk the current route, and a remembered page the route no
 * longer contains opens on the goals page.
 *
 * Chrome is the Settings dialog's, down to the class names: `.settings-dialog
 * .settings-with-navigation` with the category rail on the left (the step rail
 * here, compacted to the shared dropdown on a narrow window), the split-scroll
 * `.dialog-scroll`, and a pinned `.dialog-fixed-footer` for Back / Skip / Next.
 * Only the current page is mounted, so each page's live probes run while it is
 * visible and stop when the user moves on. ←/→ page, Esc closes (shared modal
 * focus), and the page it was left on is remembered for the next open.
 */
export function HowToStart({ onClose, firstRun = false }: {
  onClose: () => void;
  /** The fresh-install open: the Welcome greeting types itself out, once.
   *  Re-opened from Settings it shows complete. */
  firstRun?: boolean;
}) {
  const t = useT();
  const [goals, setGoals] = useState<IntroGoal[]>(readIntroGoals);
  const route = introRoute(goals);
  // A remembered page the current answers don't route through opens on the
  // goals page, where the route is decided.
  const [page, setPage] = useState<IntroPage>(() => {
    const remembered = readIntroPage();
    return route.includes(remembered) ? remembered : "goals";
  });
  const [greet, setGreet] = useState(firstRun);
  // Belt and braces: whatever happens to `page`, only a route page renders.
  const current: IntroPage = route.includes(page) ? page : "goals";
  const index = route.indexOf(current);
  const last = index === route.length - 1;
  const go = (next: IntroPage) => {
    setPage(next);
    setGreet(false);
    writeIntroPage(next);
  };
  const step = (delta: number) => {
    const next = route[index + delta];
    if (next) go(next);
  };
  const onToggleGoal = (goal: IntroGoal) => {
    const next = toggleGoal(goals, goal);
    setGoals(next);
    writeIntroGoals(next);
    // Toggles happen on the goals page, so this only guards a page that
    // dropped out of the route from under the user.
    if (!introRoute(next).includes(current)) go("goals");
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
  // "Change my answers" on the Done page unmounts the button it was pressed
  // on; hand the focus to the goal cards (the first picked one) instead of
  // letting it fall to the body.
  const focusGoalsRef = useRef(false);
  const changeGoals = () => {
    focusGoalsRef.current = true;
    go("goals");
  };
  useEffect(() => {
    if (!focusGoalsRef.current || current !== "goals") return;
    focusGoalsRef.current = false;
    const cards = modalRef.current?.querySelectorAll<HTMLElement>(".intro-goal-card");
    const picked = Array.from(cards ?? []).find((c) => c.getAttribute("aria-pressed") === "true");
    (picked ?? cards?.[0])?.focus();
  }, [current, modalRef]);

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

  const railOptions = route.map((p, i) => ({ value: p, label: `${i + 1}. ${t(INTRO_PAGE_TITLE_KEYS[p])}` }));

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
              value={current}
              options={railOptions}
              onChange={(v) => go(v as IntroPage)}
            />
          </div>
          <div className="settings-navigation-links">
            <div className="settings-navigation-group" role="group" aria-label={t("intro.stepsLabel")}>
              <div className="settings-navigation-group-title">{t("intro.stepsLabel")}</div>
              {route.map((p, i) => (
                <button
                  key={p}
                  type="button"
                  className="settings-btn"
                  aria-current={p === current ? "step" : undefined}
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
            title={<>{t(current === "welcome" ? "howToStart.title" : INTRO_PAGE_TITLE_KEYS[current])} <UntestedTag id="desktop.welcome" /></>}
            onClose={close}
          />
          <div className="dialog-scroll" key={current}>
            {current === "welcome" && <WelcomePage greet={greet} />}
            {current === "goals" && <GoalsPage goals={goals} onToggle={onToggleGoal} route={route} />}
            {current === "projects" && <ProjectsPage onClose={onClose} />}
            {current === "agents" && <AgentsPage onClose={onClose} />}
            {current === "localModels" && <LocalModelsPage onClose={onClose} />}
            {current === "forYou" && <ForYouPage goals={goals} onClose={onClose} />}
            {current === "askApp" && <AskAppPage />}
            {current === "done" && <DonePage goals={goals} onClose={finish} onChangeGoals={changeGoals} />}
          </div>
          <div className="dialog-fixed-footer settings-link-row intro-footer">
            <button type="button" className="settings-btn" disabled={index === 0} onClick={() => step(-1)}>
              ‹ {t("common.back")}
            </button>
            <span className="settings-help intro-progress">
              {t("intro.progress", { n: index + 1, total: route.length })}
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

/** Page 1: the greeting (typed out on the first run), what Tabtivity is, and the
 *  four basics — `HOW_TO_START_STEPS`, the same copy the Feature Guide shows, so
 *  the two stay in lockstep. */
function WelcomePage({ greet }: { greet: boolean }) {
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
      <Typewriter text={t("howToStart.greeting")} animate={greet} />
      <p className="settings-help">{t("howToStart.intro")} <UntestedTag id="howToStart.greeting" /></p>
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

/** Last page: where to go from here — the best first lesson for the user's
 *  goals (or back to change them), then the Feature Guide, the tour, the
 *  lessons. */
function DonePage({ goals, onClose, onChangeGoals }: {
  goals: readonly IntroGoal[];
  onClose: () => void;
  onChangeGoals: () => void;
}) {
  const t = useT();
  const firstId = firstRecommendedLesson(goals);
  const lesson = firstId ? LESSONS.find((l) => l.id === firstId) : undefined;
  return (
    <>
      <p className="settings-help">{t("intro.done.lead")}</p>
      {lesson && <p className="settings-help">{t("intro.done.startWith")}</p>}
      <div className="settings-link-row">
        {lesson && (
          // Not .primary: the footer's Start working is this view's one primary.
          <button type="button" className="settings-btn" onClick={() => startLessonById(lesson.id, onClose)}>
            {t(lesson.titleKey)}
          </button>
        )}
        <button type="button" className="settings-btn" onClick={onChangeGoals}>
          {t("intro.goals.change")}
        </button>
      </div>
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
