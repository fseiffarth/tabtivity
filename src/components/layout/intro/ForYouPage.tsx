import { Fragment } from "react";
import { useT } from "../../../lib/i18n";
import { LESSONS, type Lesson } from "../../../lib/lessons";
import { UntestedTag } from "../../common/UntestedTag";
import { INTRO_GOAL_DEFS, recommendedLessons, type IntroGoal } from "./introData";
import { IntroActions, IntroStep, IntroSteps, startLessonById } from "./introUi";

/**
 * Intro page "For you" — the guided lessons matched to the answers on the
 * Goals page (`recommendedLessons`), one heading per goal, each lesson with
 * its own title and blurb from `LESSONS` and a "Walk me through it" button
 * that hands over to the spotlighted walk-through (`startLessonById`). The
 * numbering runs across the groups so the page reads as one list.
 */
export function ForYouPage({ goals, onClose }: { goals: readonly IntroGoal[]; onClose: () => void }) {
  const t = useT();
  let num = 0;
  const groups = recommendedLessons(goals).map(({ goal, lessonIds }) => ({
    goal,
    lessons: lessonIds
      .map((id) => LESSONS.find((l) => l.id === id))
      .filter((l): l is Lesson => !!l)
      .map((lesson) => ({ lesson, num: ++num })),
  }));

  return (
    <>
      <p className="settings-help">
        {t("intro.forYou.lead")} <UntestedTag id="desktop.intro.forYou" />
      </p>
      {groups
        .filter((g) => g.lessons.length > 0)
        .map(({ goal, lessons }) => {
          const def = INTRO_GOAL_DEFS[goal];
          return (
            <Fragment key={goal}>
              <h3 className="project-form-heading">
                <span aria-hidden="true">{def.icon}</span> {t(def.titleKey)}
              </h3>
              <IntroSteps>
                {lessons.map(({ lesson, num: n }) => (
                  <IntroStep key={lesson.id} num={n} title={t(lesson.titleKey)}>
                    <div className="settings-help">{t(lesson.blurbKey)}</div>
                    <IntroActions>
                      <button
                        type="button"
                        className="settings-btn sm"
                        onClick={() => startLessonById(lesson.id, onClose)}
                      >
                        {t("intro.walkMeThrough")}
                      </button>
                    </IntroActions>
                  </IntroStep>
                ))}
              </IntroSteps>
            </Fragment>
          );
        })}
    </>
  );
}
