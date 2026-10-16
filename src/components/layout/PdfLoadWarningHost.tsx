import { useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import {
  loadedPdfCount,
  PDF_WARN_GRACE_MS,
  PDF_WARN_INITIAL,
  pdfWarnGraceLeft,
  pdfWarnStep,
  subscribeLoadedPdfCount,
  type PdfWarnState,
} from "../../lib/tabCost";

/** How long the notice stays: the `.conn-toast` animation's length. */
const TOAST_MS = 3200;

/**
 * The soft "many PDFs are loaded" notice (`docs/done/tab_cost_plan.md` step 1),
 * mounted once in the main window's `AppShell`. Follows the loaded-PDF count of
 * `lib/tabCost` — notified only when it moves, never per render or reload —
 * through the `pdfWarnStep` hysteresis, and shows AppShell's own toast
 * (`project-switch-toast conn-toast`, `pointer-events: none`) one slot below
 * the connection toast (`pdf-warn-toast`), cleared by a one-shot timeout.
 * Non-blocking: nothing to click, nothing to dismiss.
 */
export function PdfLoadWarningHost() {
  const t = useT();
  const [toast, setToast] = useState<{ n: number; id: number } | null>(null);
  const warn = useRef<PdfWarnState>(PDF_WARN_INITIAL);

  useEffect(() => {
    const check = (n: number, nowMs = performance.now()) => {
      const step = pdfWarnStep(warn.current, n, nowMs);
      warn.current = step.state;
      if (step.fire) setToast((prev) => ({ n, id: (prev?.id ?? 0) + 1 }));
    };
    const unsubscribe = subscribeLoadedPdfCount(check);
    // One look when the start-up grace ends: a count that crossed the
    // threshold inside it and has not moved since gets no other chance. A
    // one-shot timeout, gone once it ran; an already-warned crossing is
    // disarmed, so this cannot show the notice twice. The timer IS the grace's
    // end, so it reads the clock as at least that: `setTimeout` truncates the
    // fractional `left` to whole ms and a coarsened `performance.now()` can
    // read just short of it, which would lose the one look for good.
    const left = pdfWarnGraceLeft(performance.now());
    const graceEnd =
      left === null
        ? undefined
        : window.setTimeout(
            () => check(loadedPdfCount(), Math.max(performance.now(), PDF_WARN_GRACE_MS)),
            Math.ceil(left),
          );
    return () => {
      unsubscribe();
      if (graceEnd !== undefined) window.clearTimeout(graceEnd);
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), TOAST_MS);
    return () => window.clearTimeout(id);
  }, [toast]);

  if (!toast) return null;
  return (
    <div key={toast.id} className="project-switch-toast conn-toast multiline pdf-warn-toast" data-pdf-warn="">
      {t("pdfWarn.toast", { n: toast.n })}
    </div>
  );
}
