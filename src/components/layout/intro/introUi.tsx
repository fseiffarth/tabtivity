import type { ReactNode } from "react";
import { LESSONS } from "../../../lib/lessons";
import { useTourStore } from "../../../stores/tour";
import { CheckIcon } from "../../common/icons/Icon";

/**
 * The intro's small building blocks. They wear existing classes only — the
 * numbered list is `HowToStart`'s own `.how-to-start-steps` (also used by the
 * Mobile setup guide), the status line is the Settings Ollama/agents one — so
 * the wizard reads as the rest of the app does.
 */

/** A numbered, one-step-per-row instruction list. */
export function IntroSteps({ children }: { children: ReactNode }) {
  return <ol className="how-to-start-steps">{children}</ol>;
}

/** One step: the number badge (a ✓ once live state says it is done), a title,
 *  and whatever body/actions it carries. */
export function IntroStep({
  num,
  title,
  done,
  children,
}: {
  num: number;
  title: ReactNode;
  done?: boolean;
  children?: ReactNode;
}) {
  return (
    <li className={`how-to-start-step${done ? " intro-step-done" : ""}`}>
      <span className="how-to-start-num" aria-hidden="true">{done ? <CheckIcon /> : num}</span>
      <div className="intro-step-body">
        <div className="how-to-start-step-title">{title}</div>
        {children}
      </div>
    </li>
  );
}

/** Live state as the Settings panels show it: a dot and a short phrase.
 *  `null` state = still probing (no dot, muted text). */
export function IntroStatus({ ok, children }: { ok: boolean | null; children: ReactNode }) {
  return (
    <span className="ollama-status-text intro-status" data-state={ok === null ? "probing" : ok ? "ok" : "off"}>
      {ok !== null && <span className={`ollama-status-dot ${ok ? "running" : "stopped"}`} />}
      {children}
    </span>
  );
}

/** A row of one-click actions under a step. */
export function IntroActions({ children }: { children: ReactNode }) {
  return <div className="settings-link-row">{children}</div>;
}

/** Hand over to one of the existing lessons (the spotlighted walk-through the
 *  Lessons menu starts): the wizard steps aside first, exactly as the Lessons
 *  menu closes before `startLesson`. */
export function startLessonById(id: string, onClose: () => void): void {
  const lesson = LESSONS.find((l) => l.id === id);
  if (!lesson) return;
  onClose();
  useTourStore.getState().startLesson(lesson);
}
