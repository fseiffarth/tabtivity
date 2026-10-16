import { useT } from "../../../lib/i18n";
import { UntestedTag } from "../../common/UntestedTag";
import { INTRO_GOAL_DEFS, INTRO_GOALS, INTRO_PAGE_TITLE_KEYS, type IntroGoal, type IntroPage } from "./introData";

/**
 * Intro page 2 — "What do you want to do?". One toggle card per goal
 * (`INTRO_GOAL_DEFS`), several may be on; the answers decide which setup pages
 * follow (`introRoute`, computed by `HowToStart` and passed in as `route`) and
 * which lessons the For you page lists. The cards are native buttons with
 * `aria-pressed`, so Tab/Space/Enter work as everywhere else; the "Next up"
 * line under them reads the route back as it changes.
 */
export function GoalsPage({
  goals,
  onToggle,
  route,
}: {
  goals: readonly IntroGoal[];
  onToggle: (g: IntroGoal) => void;
  route: readonly IntroPage[];
}) {
  const t = useT();
  const next = route.slice(route.indexOf("goals") + 1).filter((p) => p !== "done");
  const pages = next.map((p) => t(INTRO_PAGE_TITLE_KEYS[p])).join(" · ");

  return (
    <>
      <p className="settings-help">
        {t("intro.goals.lead")} <UntestedTag id="desktop.intro.goals" />
      </p>
      <div className="intro-goal-grid" role="group" aria-label={t("intro.goals.groupLabel")}>
        {INTRO_GOALS.map((goal) => {
          const def = INTRO_GOAL_DEFS[goal];
          const on = goals.includes(goal);
          return (
            <button
              key={goal}
              type="button"
              className="settings-card intro-goal-card"
              aria-pressed={on}
              onClick={() => onToggle(goal)}
            >
              <span className="intro-goal-icon" aria-hidden="true">
                {def.icon}
              </span>
              <span className="intro-goal-text">
                <span className="how-to-start-step-title">{t(def.titleKey)}</span>
                <span className="settings-help">{t(def.blurbKey)}</span>
              </span>
              <span className="intro-goal-check" aria-hidden="true">
                {on ? "✓" : ""}
              </span>
            </button>
          );
        })}
      </div>
      <p className="settings-help intro-goal-preview" aria-live="polite">
        {goals.length === 0 ? t("intro.goals.none") : t("intro.goals.preview", { pages })}
      </p>
    </>
  );
}
