// What keyboard steering can do inside a tab: answer the question the Focus
// chat lists with a digit, and put the caret in the composer. Registered with
// the steering store while the Terminal is mounted (`registerInside`); the
// engine (`steering/usePhoneSteering.ts`) calls it lazily at the key.
import { useEffect, useRef, type RefObject } from "react";
import { freeTextRow, optionForDigit, type SelectOption, type SelectPrompt } from "../../terminal/selectPrompt";
import { refreshInside, registerInside, type AnswerResult } from "../../steering/steeringState";

export function useTerminalSteering({ focusView, liveQuestion, answerQuestion, composer }: {
  /** The Focus view is up: the one view that lists the question as rows. */
  focusView: boolean;
  liveQuestion: SelectPrompt | null;
  answerQuestion: (option: SelectOption) => void;
  composer: RefObject<HTMLTextAreaElement | null>;
}): void {
  const latest = useRef({ focusView, liveQuestion, answerQuestion });
  latest.current = { focusView, liveQuestion, answerQuestion };
  useEffect(() => {
    registerInside({
      answer(n): AnswerResult {
        const { focusView: shown, liveQuestion: prompt, answerQuestion: answer } = latest.current;
        if (!shown || !prompt) return "none";
        const option = optionForDigit(prompt, n);
        if (!option) return "missing";
        if (freeTextRow(option)) {
          // The row's button opens its field (a typing target, so steering hands off).
          const button = document.querySelectorAll<HTMLButtonElement>(".question-list > li > button")[prompt.options.indexOf(option)];
          if (!button) return "none";
          if (!button.disabled) button.click();
          return "freeText";
        }
        // A second digit while the first is held is ignored by `answerQuestion`.
        answer(option);
        return "answered";
      },
      focusComposer() {
        const field = composer.current;
        if (!field) return "blocked";
        if (field.disabled) return latest.current.liveQuestion ? "blocked" : "offline";
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
        return "focused";
      },
      hasQuestion: () => latest.current.focusView && latest.current.liveQuestion !== null,
    });
    return () => registerInside(null);
  }, [composer]);
  const shown = focusView && liveQuestion !== null;
  useEffect(() => { refreshInside(); }, [shown]);
}
