import { useModalFocus } from "../../hooks/useModalFocus";
import { Fragment } from "react";
import { LESSONS, categoryLabel } from "../../lib/lessons";
import { UntestedTag } from "../common/UntestedTag";
import { useTourStore } from "../../stores/tour";
import { useT } from "../../lib/i18n";

/**
 * The lesson picker: a small modal listing the task "lessons" (add a project,
 * install an agent, use a local model, …). Picking one closes the dialog and
 * starts that lesson through the shared tour engine
 * (`useTourStore.startLesson`). Re-openable any time from the gear menu /
 * Settings; reuses the `.modal-backdrop` + `.settings-dialog` split-scroll
 * frame — the list lives in a `.dialog-scroll` child so it scrolls (and,
 * like `HowToStart`, brings its own Esc handler).
 */
export function LessonsMenu({ onClose }: { onClose: () => void }) {
  const t = useT();
  const startLesson = useTourStore((s) => s.startLesson);

  const modalRef = useModalFocus(onClose);

  return (
    <div className="modal-backdrop how-to-start-backdrop" onMouseDown={onClose}>
      <div
        ref={modalRef}
        tabIndex={-1}
        className="settings-dialog how-to-start-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("lessons.title")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>{t("lessons.title")}</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        {/* `.settings-dialog` is a split-scroll FRAME: it clips (overflow:hidden,
            padding 0, gap 0) and the `.dialog-scroll` child does the scrolling.
            Without this wrapper the 30+ lessons render flush to the dialog's
            edges and everything past the frame's max-height is cut off with no
            way to reach it — the harder categories were unreachable. Same
            structure as ProjectFilesSettings/EventDialog. */}
        <div className="dialog-scroll">
        {/* The hands-on half (task steps, hints, the `:)` reward) has never been
            run in a live window — the tag comes off per the usual rule, when
            the user says it's tested. */}
        <p className="settings-help">
          {t("lessons.intro")} <UntestedTag id="lessons.intro" />
        </p>

        <div className="lessons-list">
          {LESSONS.map((lesson, i) => {
            // LESSONS is sorted by category (easy → hard), so a header is shown
            // whenever the tier changes from the previous lesson.
            const newSection = i === 0 || LESSONS[i - 1].category !== lesson.category;
            return (
              <Fragment key={lesson.id}>
                {newSection && (
                  <h3 className="lessons-section-title">{categoryLabel(lesson.category, t)}</h3>
                )}
                <button
                  type="button"
                  className="lesson-item"
                  onClick={() => {
                    onClose();
                    startLesson(lesson);
                  }}
                >
                  <span className="lesson-item-title">{t(lesson.titleKey)}</span>
                  <span className="lesson-item-blurb">{t(lesson.blurbKey)}</span>
                </button>
              </Fragment>
            );
          })}
        </div>
        </div>
      </div>
    </div>
  );
}
