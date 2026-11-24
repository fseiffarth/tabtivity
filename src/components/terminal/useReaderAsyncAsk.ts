import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { AskedQuestion } from "../../../mobile-web/src/api";
import { OPEN_QUEUED_QUESTION, queuedPickerFooter, queuedPickerKeys, readQueuedPicker } from "../../../mobile-web/src/screens/terminal/useAsyncAsk";
import { readableScreen } from "../../../mobile-web/src/terminal/readableScreen";
import { useT } from "../../lib/i18n";
import { isAiOffRefusal } from "../../lib/aiSwitch";
import { dialogOnScreen } from "../../lib/agents/dialogOnScreen";
import { typePaneKeys } from "../../lib/agents/paneKeys";
import { terminalFor } from "../../lib/terminal/terminalRegistry";
import { useProjectsStore } from "../../stores/projects";

const PICKER_WAIT_MS = 3_000;
const SCREEN_POLL_MS = 60;
const QUEUE_HINT = /^shift\+←\s+to answer$/u;

export function useReaderAsyncAsk(ptyId: string, sessionId: string | undefined, enabled: boolean) {
  const t = useT();
  const operation = useRef<object | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  useLayoutEffect(() => {
    setSending(null);
    return () => { operation.current = null; };
  }, [ptyId, sessionId, enabled]);

  const pick = useCallback(async (key: string, asked: AskedQuestion, row: number) => {
    if (!enabled || operation.current || !asked.options?.[row]) return;
    const term = terminalFor(ptyId);
    if (!term) return;

    const attempt = {};
    operation.current = attempt;
    setSending(key);
    const isCurrent = () => operation.current === attempt && terminalFor(ptyId) === term;
    const read = () => {
      const { lines } = readableScreen(term.buffer.active, term.rows);
      const bottom = lines.map((line) => line.text.trim()).filter(Boolean).slice(-10);
      const picker = readQueuedPicker(lines, asked);
      const queued = !!queuedPickerFooter(lines);
      const canOpen = !queued && bottom.some((text, index) => QUEUE_HINT.test(text)
        && /^\? \d+ questions?$/u.test(bottom[index - 1] ?? ""));
      return { picker, queued, canOpen };
    };
    const waitFor = async (ready: (screen: ReturnType<typeof read>) => boolean) => {
      const deadline = Date.now() + PICKER_WAIT_MS;
      let screen = read();
      while (isCurrent() && !ready(screen) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, SCREEN_POLL_MS));
        if (isCurrent()) screen = read();
      }
      return screen;
    };

    try {
      let screen = read();
      if (screen.canOpen) {
        await typePaneKeys(ptyId, [OPEN_QUEUED_QUESTION]);
        screen = await waitFor((next) => next.queued && !!next.picker);
      }
      if (!isCurrent()) return;
      // Shift+Left opens the oldest question. If it is a different one, leave
      // its live card available so the user can decide what to do with it.
      if (screen.queued && !screen.picker) return;
      if (!screen.picker) throw new Error("The queued question did not open");

      // The list may be taller than the area (Codex scrolls it with the
      // highlight): the walk goes by the printed numbers, not by rows seen.
      await typePaneKeys(ptyId, queuedPickerKeys(screen.picker, row), () => dialogOnScreen(ptyId, "Codex"), (key) => {
        if (!isCurrent()) return false;
        const current = read();
        return !!current.picker && (key !== "\r" || current.picker.current === row + 1);
      });
      await waitFor((next) => !next.picker);
    } catch (error) {
      if (isCurrent()) useProjectsStore.setState({ switchToast: t(isAiOffRefusal(error) ? "terminal.reader.answerAiOff" : "terminal.reader.answerFailed") });
    } finally {
      if (operation.current === attempt) {
        operation.current = null;
        setSending(null);
      }
    }
  }, [enabled, ptyId, t]);

  return { sending, pick };
}
